import {
  ENGINE_REGISTRY,
  findEngine,
  type EngineDescriptor,
  type EngineModel,
  type EngineModelCatalog,
  type EngineReadiness,
} from "@daycrew/shared";
import { ClaudeCodeProvider, CodexProvider, CursorProvider, GeminiProvider, GrokProvider } from "@daycrew/providers";

const CATALOG_TTL_MS = 60_000;

/**
 * Reads AI Engine metadata for the app: which CLI engines exist, whether each one is
 * installed and signed in, and which models it accepts. Every engine authenticates
 * itself, so nothing here reads, stores or asks for a credential.
 *
 * Live catalogues are cached briefly so opening a model picker does not spawn a CLI
 * on every render.
 */
export class EngineService {
  private readonly catalogs = new Map<string, { readonly at: number; readonly value: EngineModelCatalog }>();

  /** The engines a person can actually check from Settings, in registry order. */
  private detectable() {
    return [
      new ClaudeCodeProvider(),
      new CodexProvider(),
      new GeminiProvider({ detectionTimeoutMs: 8_000 }),
      new CursorProvider(),
      new GrokProvider(),
    ];
  }

  list(): EngineDescriptor[] {
    return ENGINE_REGISTRY.map((engine) => ({ ...engine }));
  }

  async detect(): Promise<EngineReadiness[]> {
    return Promise.all(
      this.detectable().map(async (provider): Promise<EngineReadiness> => {
        const detection = await provider.detect();
        const name = findEngine(provider.id)?.name ?? provider.id;
        return {
          id: provider.id,
          ...(detection.installed === undefined ? {} : { installed: detection.installed }),
          ...(detection.authenticated === undefined ? {} : { authenticated: detection.authenticated }),
          ready: detection.available,
          ...(detection.version ? { version: detection.version } : {}),
          message: detection.available
            ? `${name} is installed, signed in, and ready.`
            : detection.reason ?? `${name} could not be checked.`,
        };
      }),
    );
  }

  async models(engineId: string): Promise<EngineModelCatalog> {
    const engine = findEngine(engineId);
    if (!engine) throw new Error("Unknown AI Engine");
    const cached = this.catalogs.get(engineId);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const value = await this.buildCatalog(engine);
    this.catalogs.set(engineId, { at: Date.now(), value });
    return value;
  }

  /** Dropped after a detection run so a fresh sign-in is picked up immediately. */
  forget(engineId?: string): void {
    if (engineId === undefined) this.catalogs.clear();
    else this.catalogs.delete(engineId);
  }

  private async buildCatalog(engine: EngineDescriptor): Promise<EngineModelCatalog> {
    const fallback = (warning?: string): EngineModelCatalog => ({
      engineId: engine.id,
      models: [...engine.models],
      source: "catalog",
      allowsCustomModelId: engine.allowsCustomModelId,
      ...(warning === undefined ? {} : { warning }),
    });
    if (engine.modelDiscovery !== "dynamic") return fallback();
    try {
      const models = await this.discover(engine.id);
      if (models.length === 0) {
        return fallback(`${engine.name} reported no models. Check that it is installed and signed in.`);
      }
      return {
        engineId: engine.id,
        models,
        source: "live",
        allowsCustomModelId: engine.allowsCustomModelId,
      };
    } catch (error) {
      // A failed lookup must never block agent setup: the maintained list still works.
      return fallback(error instanceof Error ? error.message : `${engine.name} could not list its models.`);
    }
  }

  private async discover(engineId: string): Promise<EngineModel[]> {
    if (engineId === "codex") return new CodexProvider().listModels();
    if (engineId === "cursor") return new CursorProvider().listModels();
    if (engineId === "grok") return new GrokProvider().listModels();
    throw new Error("This engine does not publish a model list.");
  }
}

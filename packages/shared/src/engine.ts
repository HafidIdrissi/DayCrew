import { z } from "zod";

import { IdSchema, ModelIdSchema } from "./domain.js";

/**
 * Every real engine is a local CLI that owns its own authentication. DayCrew never
 * stores a provider credential and never asks for an API key.
 */
export const EngineKindSchema = z.enum(["cli", "simulated"]);
export type EngineKind = z.infer<typeof EngineKindSchema>;

export const EngineClassificationSchema = z.enum([
  "production-ready",
  "read-only-preview",
  "restricted-experimental",
  "simulated",
]);
export type EngineClassification = z.infer<typeof EngineClassificationSchema>;

/**
 * `dynamic` engines expose a documented catalogue command. `static` engines document
 * their accepted values but offer no listing command, so DayCrew ships a maintained
 * list. `unsupported` engines take no model parameter at all.
 */
export const ModelDiscoverySchema = z.enum(["dynamic", "static", "unsupported"]);
export type ModelDiscovery = z.infer<typeof ModelDiscoverySchema>;

export const EngineModelSchema = z
  .object({
    id: ModelIdSchema,
    label: z.string().trim().min(1).max(120),
    description: z.string().max(300).optional(),
  })
  .strict();
export type EngineModel = z.infer<typeof EngineModelSchema>;

/**
 * What Settings tells someone to run. These are instructions only: DayCrew prints
 * them, it never executes an install or a login on the user's behalf.
 */
export const EngineSetupSchema = z
  .object({
    /** How the tool is obtained, per platform where that differs. */
    install: z.array(z.object({ platform: z.string().trim().min(1), command: z.string().trim().min(1) }).strict()),
    /** The command that starts the engine's own sign-in flow. */
    signInCommand: z.string().trim().min(1).optional(),
    /** How DayCrew checks sign-in, or why it cannot. */
    authCheck: z.string().trim().min(1),
    /** False when no command reports sign-in, so Settings shows "unknown", not "signed out". */
    authDetectable: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict();
export type EngineSetup = z.infer<typeof EngineSetupSchema>;

export const EngineDescriptorSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    /** Names the actual program, so an engine is never confused with a same-brand tool. */
    binary: z.string().trim().min(1).optional(),
    kind: EngineKindSchema,
    classification: EngineClassificationSchema,
    autoEligible: z.boolean(),
    modelDiscovery: ModelDiscoverySchema,
    /** Documented by the engine as accepting an identifier outside the listed set. */
    allowsCustomModelId: z.boolean(),
    /** Maintained fallback catalogue, and the whole catalogue for `static` engines. */
    models: z.array(EngineModelSchema),
    /** When the catalogue below was last checked against the engine's own docs. */
    modelsVerifiedAt: z.string().trim().min(1),
    docsUrl: z.string().trim().min(1),
    capabilities: z.array(z.string()),
    limitations: z.array(z.string()),
    setup: EngineSetupSchema.optional(),
  })
  .strict();
export type EngineDescriptor = z.infer<typeof EngineDescriptorSchema>;

/**
 * The single place an AI Engine is declared. Screens read this through the local API,
 * so adding an engine here (plus its adapter) reaches every picker at once.
 *
 * Authentication always belongs to the CLI itself. Nothing in this file describes,
 * requests, or stores a provider credential.
 */
export const ENGINE_REGISTRY: readonly EngineDescriptor[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    binary: "claude",
    kind: "cli",
    classification: "production-ready",
    autoEligible: true,
    // `claude --model` documents aliases and full names but exposes no listing command.
    modelDiscovery: "static",
    allowsCustomModelId: true,
    modelsVerifiedAt: "2026-09-13",
    docsUrl: "https://code.claude.com/docs/en/cli-reference",
    models: [
      { id: "opus", label: "Opus (alias)", description: "Latest Opus model available to this install." },
      { id: "sonnet", label: "Sonnet (alias)", description: "Latest Sonnet model available to this install." },
      { id: "haiku", label: "Haiku (alias)", description: "Latest Haiku model available to this install." },
      { id: "fable", label: "Fable (alias)", description: "Latest Fable model available to this install." },
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
    capabilities: ["Workspace actions", "Approvals", "Session resume", "Skills"],
    limitations: ["Approved shell commands still run with the local user's permissions."],
    setup: {
      install: [{ platform: "All platforms", command: "npm install -g @anthropic-ai/claude-code" }],
      signInCommand: "claude auth login",
      authCheck: "DayCrew reads `claude auth status` and uses only its signed-in flag.",
      authDetectable: true,
      notes: ["Claude Code keeps its own credentials. DayCrew never reads or stores them."],
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    binary: "codex",
    kind: "cli",
    classification: "read-only-preview",
    autoEligible: false,
    // `codex debug models` returns the installed catalogue as JSON.
    modelDiscovery: "dynamic",
    allowsCustomModelId: true,
    modelsVerifiedAt: "2026-09-13",
    docsUrl: "https://developers.openai.com/codex/cli",
    // Deliberately empty: the catalogue belongs to the local install, and DayCrew
    // does not guess model names when `codex debug models` cannot be read.
    models: [],
    capabilities: ["Planning", "Review", "Read-only repository inspection"],
    limitations: ["Writes and native approval bridging are disabled."],
    setup: {
      install: [{ platform: "All platforms", command: "npm install -g @openai/codex" }],
      signInCommand: "codex login",
      authCheck: "DayCrew reads `codex login status`.",
      authDetectable: true,
      notes: ["Codex keeps its own credentials. DayCrew never reads or stores them."],
    },
  },
  {
    id: "gemini",
    // Deliberately not called "Gemini CLI": this adapter drives the Antigravity
    // Agent API over its local bridge, which is a different program with different
    // capabilities. The Gemini CLI is not integrated.
    name: "Antigravity Agent API (Gemini models)",
    binary: "Antigravity language server",
    kind: "cli",
    classification: "restricted-experimental",
    autoEligible: false,
    // The Antigravity Agent API takes a fixed tier, not an arbitrary model id.
    modelDiscovery: "static",
    allowsCustomModelId: false,
    modelsVerifiedAt: "2026-09-13",
    docsUrl: "https://antigravity.google/",
    models: [
      { id: "flash", label: "Flash", description: "Default Antigravity tier." },
      { id: "flash_lite", label: "Flash Lite", description: "Lowest-latency Antigravity tier." },
      { id: "pro", label: "Pro", description: "Highest-capability Antigravity tier." },
    ],
    capabilities: ["Restricted planning preview"],
    limitations: [
      "This is the Antigravity desktop app's local Agent API, not the separate Gemini CLI.",
      "Automatic discovery of that local bridge is implemented for Windows only.",
      "Workspace confinement and provider tool controls are not enforceable enough for Auto.",
    ],
    setup: {
      install: [{ platform: "Windows", command: "Install the Antigravity desktop app from antigravity.google" }],
      authCheck: "DayCrew treats a readable authenticated model catalogue on the local bridge as signed in.",
      authDetectable: true,
      notes: [
        "Sign in inside the Antigravity app; there is no DayCrew-visible sign-in command.",
        "On macOS and Linux the local bridge is not discovered, so the state stays unknown.",
      ],
    },
  },
  {
    id: "cursor",
    name: "Cursor CLI",
    binary: "cursor-agent",
    kind: "cli",
    classification: "read-only-preview",
    autoEligible: false,
    // `cursor-agent models` lists what the signed-in account may use.
    modelDiscovery: "dynamic",
    allowsCustomModelId: true,
    modelsVerifiedAt: "2026-09-13",
    docsUrl: "https://cursor.com/docs/cli/reference/parameters",
    // Cursor publishes no canonical list of --model identifiers, and the catalogue
    // depends on the account's plan, so DayCrew reads it instead of guessing.
    models: [],
    capabilities: ["Planning", "Review", "Read-only repository inspection", "Session resume"],
    limitations: [
      "Cursor exposes no pre-execution approval callback, so DayCrew cannot bridge approvals.",
      "Available models depend on the signed-in account's plan.",
    ],
    setup: {
      install: [
        { platform: "macOS, Linux, WSL", command: "curl https://cursor.com/install -fsS | bash" },
        { platform: "Windows PowerShell", command: "irm 'https://cursor.com/install?win32=true' | iex" },
      ],
      signInCommand: "cursor-agent login",
      authCheck: "DayCrew reads `cursor-agent status`.",
      authDetectable: true,
      notes: [
        "Sign in with `cursor-agent login`; DayCrew never passes --api-key and never asks for one.",
        "DayCrew never passes --force or --yolo, so the CLI's own permission rules still apply.",
      ],
    },
  },
  {
    id: "grok",
    name: "Grok Build",
    binary: "grok",
    kind: "cli",
    classification: "read-only-preview",
    autoEligible: false,
    modelDiscovery: "dynamic",
    allowsCustomModelId: true,
    modelsVerifiedAt: "2026-09-14",
    docsUrl: "https://docs.x.ai/build/overview",
    models: [
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ],
    capabilities: ["Planning", "Review", "Read-only repository inspection", "Session resume"],
    limitations: [
      "Grok headless mode exposes no approval callback that DayCrew can bridge.",
      "The read-only launch policy has not been verified in a successful signed-in turn on this machine.",
    ],
    setup: {
      install: [
        { platform: "macOS, Linux, Git Bash", command: "curl -fsSL https://x.ai/cli/install.sh | bash" },
        { platform: "Windows PowerShell", command: "irm https://x.ai/cli/install.ps1 | iex" },
      ],
      signInCommand: "grok login --device-code",
      authCheck: "DayCrew reads `grok models`, which reports whether Grok Build is authenticated.",
      authDetectable: true,
      notes: ["Grok Build keeps its own credentials. DayCrew never reads or stores them."],
    },
  },
  {
    id: "demo",
    name: "Demo Mode",
    kind: "simulated",
    classification: "simulated",
    autoEligible: false,
    modelDiscovery: "unsupported",
    allowsCustomModelId: false,
    modelsVerifiedAt: "2026-09-13",
    docsUrl: "https://github.com/daycrew/daycrew/blob/main/docs/DEMO.md",
    models: [],
    capabilities: ["Deterministic simulated replies"],
    limitations: ["Simulated output. Never presented as real AI execution."],
  },
];

export const findEngine = (id: string | undefined): EngineDescriptor | undefined =>
  ENGINE_REGISTRY.find((engine) => engine.id === id);

export const engineSupportsModelSelection = (engine: EngineDescriptor): boolean =>
  engine.modelDiscovery !== "unsupported";

export type ModelValidation = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Server-side compatibility check. `known` is the live catalogue when one could be
 * read; without it the maintained list is used, so a save never depends on a CLI
 * being runnable at that moment.
 */
export const validateEngineModel = (
  engine: EngineDescriptor,
  model: string | undefined,
  known?: readonly EngineModel[],
): ModelValidation => {
  if (model === undefined) return { ok: true };
  if (!engineSupportsModelSelection(engine)) {
    return { ok: false, message: `${engine.name} does not accept a model choice. Use the CLI default model.` };
  }
  const parsed = ModelIdSchema.safeParse(model);
  if (!parsed.success) {
    return { ok: false, message: "Enter a model identifier using letters, digits, and . _ - : / characters." };
  }
  const catalogue = known ?? engine.models;
  if (catalogue.some((candidate) => candidate.id === parsed.data)) return { ok: true };
  if (engine.allowsCustomModelId) return { ok: true };
  const listed = catalogue.map((candidate) => candidate.id).join(", ");
  return {
    ok: false,
    message: `${engine.name} does not support the model "${parsed.data}".${listed ? ` Choose one of: ${listed}.` : ""}`,
  };
};

export const EngineModelCatalogSchema = z
  .object({
    engineId: IdSchema,
    models: z.array(EngineModelSchema),
    /** `live` came from the CLI, `catalog` from the maintained list above. */
    source: z.enum(["live", "catalog"]),
    allowsCustomModelId: z.boolean(),
    /** Present when the live command could not be run; the fallback list is still usable. */
    warning: z.string().optional(),
  })
  .strict();
export type EngineModelCatalog = z.infer<typeof EngineModelCatalogSchema>;

/**
 * Readiness has three independent, separately-unknown parts. A failed check never
 * proves absence: a timeout, a permission error, or an unsupported platform leaves
 * the answer `undefined`, which screens must render as "unknown", not "missing".
 */
export const EngineReadinessSchema = z
  .object({
    id: IdSchema,
    installed: z.boolean().optional(),
    authenticated: z.boolean().optional(),
    /** True only when the adapter says it can run a turn right now. */
    ready: z.boolean(),
    version: z.string().optional(),
    message: z.string(),
  })
  .strict();
export type EngineReadiness = z.infer<typeof EngineReadinessSchema>;

export type ReadinessState = "ready" | "signed-out" | "not-installed" | "unknown";

/** Collapses a readiness record into the single state a badge should show. */
export const readinessState = (readiness: EngineReadiness): ReadinessState => {
  if (readiness.ready) return "ready";
  if (readiness.installed === false) return "not-installed";
  if (readiness.installed === true && readiness.authenticated === false) return "signed-out";
  return "unknown";
};

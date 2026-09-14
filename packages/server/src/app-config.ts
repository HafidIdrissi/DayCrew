import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface RecentWorkspace {
  root: string;
  name: string;
  lastOpenedAt: string;
}
export interface AppConfig {
  version: 1;
  selectedWorkspace?: string;
  defaultAutonomy?: "assist" | "work-with-approval" | "autonomous";
  recentWorkspaces: RecentWorkspace[];
}

export class AppConfigError extends Error {
  readonly code = "APP_CONFIG_UNAVAILABLE";
  constructor(options?: ErrorOptions) {
    super("DayCrew could not read or save its local app configuration. Check the configuration file and its permissions.", options);
  }
}

export const appConfigDirectory = (
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string => {
  const override = env["DAYCREW_APP_CONFIG_DIR"];
  const directory = override ?? (platform === "win32"
    ? path.join(env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "DayCrew")
    : platform === "darwin"
      ? path.join(home, "Library", "Application Support", "DayCrew")
      : path.join(env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "daycrew"));
  if (!path.isAbsolute(directory)) throw new AppConfigError();
  return directory;
};

export class AppConfigStore {
  readonly filePath: string;
  constructor(directory = appConfigDirectory()) {
    if (!path.isAbsolute(directory)) throw new AppConfigError();
    this.filePath = path.join(directory, "app.json");
  }

  async load(): Promise<AppConfig> {
    try {
      const config = JSON.parse(await readFile(this.filePath, "utf8")) as AppConfig;
      if (config.version !== 1 || !Array.isArray(config.recentWorkspaces) ||
        (config.selectedWorkspace !== undefined && (typeof config.selectedWorkspace !== "string" || !path.isAbsolute(config.selectedWorkspace))) ||
        (config.defaultAutonomy !== undefined && !["assist", "work-with-approval", "autonomous"].includes(config.defaultAutonomy)) ||
        config.recentWorkspaces.some((item) => !item || typeof item.root !== "string" || !path.isAbsolute(item.root) ||
          typeof item.name !== "string" || typeof item.lastOpenedAt !== "string")) {
        throw new AppConfigError();
      }
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, recentWorkspaces: [] };
      throw new AppConfigError({ cause: error });
    }
  }

  async save(config: AppConfig): Promise<void> {
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new AppConfigError({ cause: error });
    }
  }

  async update(update: Partial<Pick<AppConfig, "defaultAutonomy">>): Promise<AppConfig> {
    const current = await this.load();
    const next: AppConfig = { ...current, ...update, version: 1 };
    await this.save(next);
    return next;
  }
}

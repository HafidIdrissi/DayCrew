import { buildServer } from "./index.js";

const port = Number.parseInt(process.env["DAYCREW_PORT"] ?? "5005", 10);
const explicitWorkspaceRoot = process.env["DAYCREW_WORKSPACE_ROOT"];
const server = buildServer({
  ...(explicitWorkspaceRoot === undefined ? {} : { workspaceRoot: explicitWorkspaceRoot }),
});

/** Reuses the public app contract so startup never reports a filesystem path. */
const readyMessage = async (): Promise<string> => {
  const response = await server.inject({ method: "GET", url: "/api/app" });
  if (response.statusCode !== 200) return "DayCrew server ready — no Workspace selected.\nOpen the web app or set DAYCREW_WORKSPACE_ROOT.";
  const { workspace, issue } = response.json() as {
    workspace: { selected: boolean; initialized: boolean; name?: string };
    issue?: { message: string };
  };
  if (workspace.initialized && workspace.name !== undefined) return `DayCrew server ready — Workspace: ${workspace.name}`;
  if (workspace.selected) return `DayCrew server ready — the remembered Workspace is unavailable. ${issue?.message ?? ""}`.trimEnd();
  return "DayCrew server ready — no Workspace selected.\nOpen the web app or set DAYCREW_WORKSPACE_ROOT.";
};

try {
  await server.listen({ host: "127.0.0.1", port });
  process.stdout.write(`Local API: http://127.0.0.1:${port}\n${await readyMessage()}\n`);
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}

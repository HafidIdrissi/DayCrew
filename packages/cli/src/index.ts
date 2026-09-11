import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ActivityService,
  ApprovalService,
  KnowledgeService,
  ManagerOrchestrator,
  MemoryService,
  requiresHumanApproval,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  installTeamPack,
  resolveWorkspaceRoot,
  WorkspaceStateError,
} from "@daycrew/core";
import { ClaudeCodeProvider, CodexProvider, createMvpMockProvider } from "@daycrew/providers";
import type { TeamMember } from "@daycrew/shared";

export const helpText = `DayCrew

Workspace:
  daycrew workspace create <name> [--path <directory>]
  daycrew workspace show [--path <directory>]
  daycrew workspace rename <name> [--path <directory>]

Teams:
  daycrew team install software-development [--path <directory>]
  daycrew team create <name> --manager <name> [--member <name:role>] [--path <directory>]
  daycrew team list [--path <directory>]

Knowledge and memory:
  daycrew knowledge add <team> <title> <content> [--path <directory>]
  daycrew knowledge list <team> [--path <directory>]
  daycrew memory add <team> <member> <note> [--path <directory>]
  daycrew memory show <team> <member> [--path <directory>]

Work:
  daycrew work start <team> <goal> [--engine <mock|codex|claude-code>] [--allow-unconfined-reads] [--allow-writes] [--path <directory>]
  daycrew work list [--path <directory>]
  daycrew work show <session> [--path <directory>]
  daycrew work pause <session> [--reason <text>] [--path <directory>]
  daycrew work resume <session> [--path <directory>]
  daycrew task list <session> [--path <directory>]
  daycrew needs-you list [--path <directory>]
  daycrew needs-you resolve <item> <approved|denied|resolved|dismissed> [--feedback <text>] [--path <directory>]
  daycrew activity list [session] [--path <directory>]

AI Engines:
  daycrew provider detect <codex|claude-code>`;

const optionValues = (args: readonly string[], name: string): string[] => {
  const values: string[] = [];
  args.forEach((argument, index) => {
    if (argument === name && args[index + 1]) values.push(args[index + 1]!);
  });
  return values;
};

const positionals = (args: readonly string[]): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--")) {
      index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
};

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const workspacePath = (args: readonly string[], cwd: string): string => {
  const explicitRoot = optionValues(args, "--path")[0];
  const resolution = resolveWorkspaceRoot({
    ...(explicitRoot === undefined ? {} : { explicitRoot: path.resolve(cwd, explicitRoot) }),
    discoveryStart: path.resolve(cwd),
  });
  if (!resolution) throw new WorkspaceStateError("WORKSPACE_NOT_SELECTED");
  return resolution.workspaceRoot;
};

const bundledPackPath = (packId: string): string =>
  fileURLToPath(new URL(`../../../team-packs/${packId}/`, import.meta.url));

const format = (value: unknown): string => JSON.stringify(value, null, 2);

export const runCli = async (
  args: readonly string[],
  cwd = process.cwd(),
): Promise<string> => {
  if (args.includes("--version") || args.includes("-v")) return "0.0.0";
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return helpText;

  const [area, action, ...rest] = args;
  const root = area === "workspace" && action === "create" && !rest.includes("--path")
    ? path.resolve(cwd) : area === "provider" ? "" : workspacePath(rest, cwd);
  const values = positionals(rest);

  if (area === "workspace" && action === "create") {
    const name = values[0];
    if (!name) throw new Error("Workspace name is required");
    return format(await new WorkspaceService(root).create(name));
  }
  if (area === "workspace" && action === "show") {
    return format(await new WorkspaceService(root).load());
  }
  if (area === "workspace" && action === "rename") {
    const name = values[0];
    if (!name) throw new Error("Workspace name is required");
    return format(await new WorkspaceService(root).updateName(name));
  }
  if (area === "team" && action === "install") {
    const packId = values[0];
    if (!packId) throw new Error("Team Pack id is required");
    return format(await installTeamPack(root, bundledPackPath(packId)));
  }
  if (area === "team" && action === "create") {
    const name = values[0];
    const managerName = optionValues(rest, "--manager")[0];
    if (!name || !managerName) throw new Error("Team name and --manager are required");
    const manager: TeamMember = {
      id: "manager",
      name: managerName,
      role: "Manager",
      instructions: `Manage the ${name} Team and coordinate its Members.`,
      isManager: true,
      engine: { mode: "auto" },
    };
    const members = optionValues(rest, "--member").map((definition): TeamMember => {
      const separator = definition.indexOf(":");
      const memberName = separator === -1 ? definition : definition.slice(0, separator);
      const role = separator === -1 ? definition : definition.slice(separator + 1);
      return {
        id: slugify(memberName),
        name: memberName,
        role,
        instructions: `Work as ${role} and report results to the Manager.`,
        isManager: false,
        engine: { mode: "auto" },
      };
    });
    return format(await new TeamService(root).create({ name, members: [manager, ...members] }));
  }
  if (area === "team" && action === "list") {
    return format(await new TeamService(root).list());
  }
  if (area === "knowledge" && action === "add") {
    const [teamId, title, content] = values;
    if (!teamId || !title || !content) throw new Error("Team, title, and content are required");
    return format(await new KnowledgeService(root).add(teamId, title, content));
  }
  if (area === "knowledge" && action === "list") {
    const teamId = values[0];
    if (!teamId) throw new Error("Team id is required");
    return format(await new KnowledgeService(root).list(teamId));
  }
  if (area === "memory" && action === "add") {
    const [teamId, memberId, note] = values;
    if (!teamId || !memberId || !note) throw new Error("Team, Member, and note are required");
    return format(await new MemoryService(root).remember(teamId, memberId, note));
  }
  if (area === "memory" && action === "show") {
    const [teamId, memberId] = values;
    if (!teamId || !memberId) throw new Error("Team and Member are required");
    return format(await new MemoryService(root).load(teamId, memberId));
  }
  if (area === "work" && action === "start") {
    const [teamId, goal] = values;
    if (!teamId || !goal) throw new Error("Team and goal are required");
    const team = await new TeamService(root).load(teamId);
    const engine = optionValues(rest, "--engine")[0] ?? "mock";
    if (engine !== "mock" && engine !== "codex" && engine !== "claude-code") {
      throw new Error(`Unknown AI Engine "${engine}"`);
    }
    const provider =
      engine === "codex"
        ? new CodexProvider({
            allowUnconfinedReads: rest.includes("--allow-unconfined-reads"),
            allowedWorkspaceRoots: [root],
          })
        : engine === "claude-code"
          ? new ClaudeCodeProvider({
              allowWrites: rest.includes("--allow-writes"),
              allowedWorkspaceRoots: [root],
              // DayCrew autonomy stays authoritative; the adapter never decides policy itself.
              requiresApproval: (action, risk) => requiresHumanApproval(team.autonomy, action, risk),
            })
          : createMvpMockProvider(team);
    return format(
      await new ManagerOrchestrator(root, {
        providers: new Map([[provider.id, provider]]),
        defaultProvider: provider.id,
      }).runGoal(teamId, goal),
    );
  }
  if (area === "work" && action === "list") {
    return format(await new WorkSessionService(root).list());
  }
  if (area === "work" && action === "show") {
    const sessionId = values[0];
    if (!sessionId) throw new Error("Work session id is required");
    const sessions = new WorkSessionService(root);
    return format({
      session: await sessions.load(sessionId),
      tasks: await sessions.listTasks(sessionId),
      messages: await sessions.listMessages(sessionId),
      activity: await new ActivityService(root).list(sessionId),
    });
  }
  if (area === "work" && action === "pause") {
    const sessionId = values[0];
    if (!sessionId) throw new Error("Work session id is required");
    return format(
      await new WorkSessionService(root).pause(
        sessionId,
        optionValues(rest, "--reason")[0] ?? "Paused by the user",
      ),
    );
  }
  if (area === "work" && action === "resume") {
    const sessionId = values[0];
    if (!sessionId) throw new Error("Work session id is required");
    return format(await new WorkSessionService(root).resume(sessionId));
  }
  if (area === "task" && action === "list") {
    const sessionId = values[0];
    if (!sessionId) throw new Error("Work session id is required");
    return format(await new WorkSessionService(root).listTasks(sessionId));
  }
  if (area === "needs-you" && action === "list") {
    return format(await new WorkSessionService(root).listNeedsYou());
  }
  if (area === "needs-you" && action === "resolve") {
    const [itemId, resolution] = values;
    if (!itemId || !resolution) throw new Error("Item id and resolution are required");
    if (!["approved", "denied", "resolved", "dismissed"].includes(resolution)) {
      throw new Error("Resolution must be approved, denied, resolved, or dismissed");
    }
    const sessions = new WorkSessionService(root);
    const item = (await sessions.listNeedsYou()).find((candidate) => candidate.id === itemId);
    const feedback = optionValues(rest, "--feedback")[0];
    if (item?.approvalId && (resolution === "approved" || resolution === "denied")) {
      return format(
        await new ApprovalService(root).decideNeedsYou(itemId, resolution, feedback, {
          type: "human",
          id: "local-cli",
        }),
      );
    }
    return format(
      await sessions.resolveNeedsYou(
        itemId,
        resolution as "approved" | "denied" | "resolved" | "dismissed",
        feedback,
      ),
    );
  }
  if (area === "activity" && action === "list") {
    return format(await new ActivityService(root).list(values[0]));
  }
  if (area === "provider" && action === "detect") {
    const providerId = values[0];
    if (providerId !== "codex" && providerId !== "claude-code") {
      throw new Error(`Unknown AI Engine "${providerId ?? ""}"`);
    }
    const provider =
      providerId === "claude-code" ? new ClaudeCodeProvider() : new CodexProvider();
    return format({
      id: provider.id,
      displayName: provider.displayName,
      capabilities: provider.capabilities,
      security: provider.security,
      detection: await provider.detect(),
    });
  }

  throw new Error(`Unknown command: ${args.join(" ")}`);
};

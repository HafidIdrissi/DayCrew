import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockProvider } from "@daycrew/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationService,
  TeamService,
  WorkSessionService,
  WorkspaceService,
  engineFailureNotice,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-chat-stop-"));
  directories.push(root);
  await new WorkspaceService(root).create("Chat stop");
  const team = await new TeamService(root).create({
    name: "Crew",
    autonomy: "assist",
    members: [
      {
        id: "manager",
        name: "Alex",
        role: "Manager",
        instructions: "Coordinate",
        isManager: true,
        engine: { mode: "manual", provider: "mock" },
      },
    ],
  });
  return { root, teamId: team.id };
};

describe("chat Stop", () => {
  it("stays a no-op once the reply has already settled", async () => {
    // Regression: a Stop arriving while a finished reply was still releasing its
    // disposable preview folder tried to cancel a terminal work session and threw,
    // which surfaced as a failed Stop request and a rejected shutdown hook.
    const { root, teamId } = await fixture();
    const service = new ConversationService(root);
    let reachedCleanup!: () => void;
    const inCleanup = new Promise<void>((resolve) => {
      reachedCleanup = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await service.send(teamId, "dm-manager", "Hello", undefined, async () => ({
      provider: new MockProvider({ id: "mock", script: [[{ type: "text", text: "Done" }, { type: "done" }]] }),
      workspacePath: root,
      cleanup: async () => {
        reachedCleanup();
        await held;
      },
    }));

    await inCleanup;
    const sessionId = (await new WorkSessionService(root).list())[0]?.id;
    expect(sessionId).toBeDefined();
    expect((await new WorkSessionService(root).load(sessionId!)).status).toBe("completed");

    await expect(service.stop(teamId, "dm-manager")).resolves.toBeUndefined();
    release();
    await service.close();

    const conversation = await service.load(teamId, "dm-manager");
    expect(conversation.messages.at(-1)).toMatchObject({ status: "complete", text: "Done" });
    expect((await new WorkSessionService(root).load(sessionId!)).status).toBe("completed");
  });
});

describe("engine failure notices", () => {
  it("names a provider limit the person can act on, without quoting the engine", () => {
    // Real Codex CLI message observed while its account limit was reached.
    const quota =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 14th, 2026 2:54 AM.";
    expect(engineFailureNotice(quota)).toMatch(/usage limit/i);
    expect(engineFailureNotice(quota)).toMatch(/stays signed in/i);
    // No provider URL, plan name, or raw diagnostic reaches the reader.
    expect(engineFailureNotice(quota)).not.toMatch(/http|Pro\b|credits/);
  });

  it("names a sign-in problem separately", () => {
    expect(engineFailureNotice('{"type":"error","message":"Not signed in. Run grok login."}')).toMatch(
      /not signed in/i,
    );
    expect(engineFailureNotice("Error authenticating: IneligibleTierError")).toMatch(/not signed in/i);
  });

  it("falls back to the general notice for anything it cannot classify", () => {
    for (const message of [undefined, "", "Codex exited without a turn.completed event"]) {
      expect(engineFailureNotice(message)).toMatch(/could not finish this reply/i);
    }
  });
});

import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentEvent } from "@daycrew/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  GeminiProvider,
  normalizeAntigravityTrajectoryStep,
  redactGeminiSecrets,
} from "./index.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const completedSteps = [
  {
    type: "CORTEX_STEP_TYPE_USER_INPUT",
    status: "CORTEX_STEP_STATUS_DONE",
    userInput: { userResponse: "Plan the endpoint" },
  },
  {
    type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
    status: "CORTEX_STEP_STATUS_DONE",
    metadata: { modelUsage: { inputTokens: "9", outputTokens: "3" } },
    plannerResponse: {
      toolCalls: [
        {
          id: "Call_1",
          name: "view_file",
          argumentsJson: JSON.stringify({ AbsolutePath: "README.md" }),
        },
      ],
    },
  },
  {
    type: "CORTEX_STEP_TYPE_VIEW_FILE",
    status: "CORTEX_STEP_STATUS_DONE",
    metadata: {
      toolCall: { id: "Call_1", name: "view_file" },
      toolSummary: "Viewed README.md",
    },
    viewFile: {},
  },
  {
    type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
    status: "CORTEX_STEP_STATUS_DONE",
    metadata: { modelUsage: { inputTokens: "12", outputTokens: "8" } },
    plannerResponse: {
      response: `DAYCREW_RESULT_START
${JSON.stringify({
  summary: "Plan ready.",
  complete: true,
  tasks: [
    {
      id: "hello-plan",
      title: "Plan endpoint",
      description: "Plan /hello.",
      status: "todo",
      ownerId: "manager",
      dependsOn: [],
      needsYou: false,
    },
  ],
})}
DAYCREW_RESULT_END`,
    },
  },
] as const;

const fakeCommandSource = String.raw`
const args = process.argv.slice(2);
if (args[0] !== "agentapi") process.exit(2);
if (args[1] === "new-conversation") {
  process.stdout.write(JSON.stringify({ response: { newConversation: { conversationId: "conversation-1" } } }));
} else if (args[1] === "send-message") {
  process.stdout.write(JSON.stringify({ response: { sendMessage: { recipientId: args[2] } } }));
} else process.exit(3);
`;

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-antigravity-unit-"));
  directories.push(root);
  const commandPath = path.join(root, "fake-antigravity.mjs");
  await writeFile(commandPath, fakeCommandSource, "utf8");
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  return { root, commandPath };
};

const startBridge = async (status = "CASCADE_RUN_STATUS_IDLE") => {
  let cancelled = false;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/GetAvailableModels")) {
        response.end(JSON.stringify({ response: { models: { flash: {} } } }));
      } else if (request.url?.endsWith("/GetCascadeTrajectory")) {
        response.end(JSON.stringify({ trajectory: { steps: completedSteps }, status }));
      } else if (request.url?.endsWith("/CancelCascadeInvocation")) {
        cancelled = objectValue(JSON.parse(body))?.["killBackgroundTasks"] === true;
        response.end("{}");
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "not found" }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return { endpoint: `http://127.0.0.1:${address.port}`, wasCancelled: () => cancelled };
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

const spec = (workspacePath: string) => ({
  sessionId: "session-1",
  memberId: "manager",
  role: "Manager",
  instructions: "Return one planning task.",
  goal: "Prepare a plan.",
  workspacePath,
});

describe("Antigravity trajectory normalization", () => {
  it("normalizes tool, text, usage, and error steps without leaking secrets", () => {
    expect(normalizeAntigravityTrajectoryStep(completedSteps[1])).toMatchObject({
      events: [{ type: "tool_call", callId: "call-1", name: "view_file" }],
      usage: { inputTokens: 9, outputTokens: 3 },
    });
    expect(normalizeAntigravityTrajectoryStep(completedSteps[2])).toMatchObject({
      events: [{ type: "tool_result", callId: "call-1", isError: false }],
    });
    expect(redactGeminiSecrets("Bearer abcdefghijklmnopqrstuvwxyz")).toBe("[redacted]");
  });
});

describe("GeminiProvider through Antigravity Agent API", () => {
  it("detects, starts, polls normalized events, records usage, and completes", async () => {
    const { root, commandPath } = await fixture();
    const bridge = await startBridge();
    const provider = new GeminiProvider({
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
      pollIntervalMs: 5,
      connection: {
        endpoint: bridge.endpoint,
        csrfToken: "test-only-token",
        languageServerCommand: [process.execPath, commandPath],
        version: "2.0.6.0",
      },
    });

    await expect(provider.detect()).resolves.toEqual({ available: true, version: "2.0.6.0" });
    const handle = await provider.startAgent(spec(root));
    await handle.send({ type: "goal", text: "Prepare the endpoint plan." });
    const events: AgentEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === "done" || event.type === "error") break;
    }
    await handle.stop();

    expect(handle.getSessionIdentity?.()).toBe("conversation-1");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_call", name: "view_file" }),
      expect.objectContaining({ type: "tool_result", isError: false }),
      expect.objectContaining({ type: "usage" }),
      expect.objectContaining({ type: "task_update", task: expect.objectContaining({ id: "hello-plan" }) }),
      expect.objectContaining({ type: "done", summary: "Plan ready." }),
    ]));
  });

  it("cancels by conversation id and fails closed without preview opt-in", async () => {
    const { root, commandPath } = await fixture();
    const bridge = await startBridge("CASCADE_RUN_STATUS_RUNNING");
    const connection = {
      endpoint: bridge.endpoint,
      csrfToken: "test-only-token",
      languageServerCommand: [process.execPath, commandPath] as const,
    };
    const provider = new GeminiProvider({
      connection,
      allowUnsafeDisposableWorkspace: true,
      allowedWorkspaceRoots: [root],
      pollIntervalMs: 5,
    });
    const handle = await provider.startAgent(spec(root));
    await handle.send({ type: "goal", text: "Keep working." });
    await handle.interrupt();
    expect(bridge.wasCancelled()).toBe(true);
    const iterator = handle.events[Symbol.asyncIterator]();
    let cancellation: AgentEvent | undefined;
    for (let index = 0; index < 10; index += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (event.value.type === "error") {
        cancellation = event.value;
        break;
      }
    }
    expect(cancellation).toMatchObject({ type: "error", recoverable: true });
    await handle.stop();

    await expect(new GeminiProvider({ connection }).startAgent(spec(root))).rejects.toThrow(
      "unavailable by default",
    );
  });
});

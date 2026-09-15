import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamService, WorkspaceService, writeJson, statePath } from "@daycrew/core";
import { ConversationSchema } from "@daycrew/shared";
import { MockProvider } from "@daycrew/providers";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./index.js";

const directories: string[] = [];
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const fixture = async (providers?: MockProvider[]) => {
  const root = await mkdtemp(path.join(tmpdir(), "daycrew-conversations-")); directories.push(root);
  await new WorkspaceService(root).create("Chat QA");
  await new TeamService(root).create({ id: "crew", name: "Crew", members: [
    { id: "manager", name: "Alex", role: "Manager", instructions: "Coordinate", isManager: true, engine: { mode: "manual", provider: "claude-code" } },
    { id: "dev", name: "Sam", role: "Developer", instructions: "Implement", isManager: false, engine: { mode: "manual", provider: "codex" } },
  ] });
  const server = buildServer({ workspaceRoot: root, appConfigDir: path.join(root, "config"), ...(providers ? { orchestration: { providers: new Map(providers.map((p) => [p.id, p])) } } : {}) }); servers.push(server);
  return { root, server };
};
const base = "/api/teams/crew/conversations";
const waitReply = async (server: ReturnType<typeof buildServer>, id: string, status = "complete") => {
  let data;
  for (let i = 0; i < 120; i++) {
    data = (await server.inject({ method: "GET", url: `${base}/${id}` })).json();
    if (data.messages?.at(-1)?.status === status) return data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Reply did not reach ${status}: ${JSON.stringify(data)}`);
};

describe("Team conversations", () => {
  it("persists two agents on one engine with isolated models and efforts and forwards each choice", async () => {
    const claude = new MockProvider({ id: "claude-code", script: [
      [{ type: "text", text: "Manager answer" }, { type: "done" }],
      [{ type: "text", text: "Specialist answer" }, { type: "done" }],
    ] });
    const { root, server } = await fixture([claude]);
    const managerValue = { name: "Alex", role: "Manager", instructions: "Coordinate", engine: { mode: "manual", provider: "claude-code", model: "claude-opus-4-7", reasoningEffort: "xhigh" } };
    expect((await server.inject({ method: "PATCH", url: "/api/teams/crew/members/manager", payload: managerValue })).statusCode).toBe(200);
    const specialistValue = { name: "Maya", role: "Researcher", instructions: "Research", engine: { mode: "manual", provider: "claude-code", model: "claude-sonnet-4-6", reasoningEffort: "low" } };
    const added = await server.inject({ method: "POST", url: "/api/teams/crew/members", payload: specialistValue });
    expect(added.statusCode).toBe(200);
    const specialistId = added.json().members.at(-1).id as string;
    await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Plan" } });
    await waitReply(server, "dm-manager");
    await server.inject({ method: "POST", url: `${base}/dm-${specialistId}/messages`, payload: { text: "Research" } });
    await waitReply(server, `dm-${specialistId}`);
    expect(claude.specs).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: "manager", model: "claude-opus-4-7", reasoningEffort: "xhigh" }),
      expect.objectContaining({ memberId: specialistId, model: "claude-sonnet-4-6", reasoningEffort: "low" }),
    ]));
    await server.close();
    const reopened = buildServer({ workspaceRoot: root, appConfigDir: path.join(root, "config") }); servers.push(reopened);
    const restored = (await reopened.inject({ method: "GET", url: "/api/teams/crew" })).json().team.members;
    expect(restored.find((member: { id: string }) => member.id === "manager").engine).toEqual(managerValue.engine);
    expect(restored.find((member: { id: string }) => member.id === specialistId).engine).toEqual(specialistValue.engine);
    const incompatible = await reopened.inject({ method: "PATCH", url: `/api/teams/crew/members/${specialistId}`, payload: { ...specialistValue, engine: { mode: "manual", provider: "gemini", model: "pro", reasoningEffort: "low" } } });
    expect(incompatible.statusCode).toBe(409);
    expect((await reopened.inject({ method: "GET", url: "/api/teams/crew" })).json().team.members.find((member: { id: string }) => member.id === specialistId).engine).toEqual(specialistValue.engine);
  });
  it("routes private messages and targeted channel replies to each Member's engine with persisted follow-up context", async () => {
    const claude = new MockProvider({ id: "claude-code", script: [[{ type: "text", text: "Alex reply" }, { type: "done" }]] });
    const codex = new MockProvider({ id: "codex", script: [[{ type: "text", text: "Sam reply" }, { type: "done" }]] });
    const { root, server } = await fixture([claude, codex]);
    expect((await server.inject({ method: "POST", url: `${base}/dm-dev/messages`, payload: { text: "Remember the name Daisy" } })).statusCode).toBe(200);
    await waitReply(server, "dm-dev");
    await server.inject({ method: "POST", url: `${base}/dm-dev/messages`, payload: { text: "What name?" } });
    const thread = await waitReply(server, "dm-dev");
    expect(thread.messages).toHaveLength(4);
    expect(thread.messages[3]).toMatchObject({ provider: "codex", memberId: "dev", text: "Sam reply" });
    expect(codex.inputs[1]?.input).toMatchObject({ type: "goal", text: expect.stringContaining("Daisy") });
    expect(codex.specs[0]).toMatchObject({ memberId: "dev", mode: "conversation" });
    expect(claude.specs).toHaveLength(0);
    await server.inject({ method: "POST", url: `${base}/channel/messages`, payload: { text: "Help coordinate" } });
    await waitReply(server, "channel");
    expect(claude.specs).toHaveLength(1);
    await server.inject({ method: "POST", url: `${base}/channel/messages`, payload: { text: "Sam, your view?", targetId: "dev" } });
    await waitReply(server, "channel");
    expect(codex.specs).toHaveLength(3);
    expect((await server.inject({ method: "GET", url: "/api/tasks" })).json()).toEqual([]);
    await server.close();
    const reopened = buildServer({ workspaceRoot: root, appConfigDir: path.join(root, "config") }); servers.push(reopened);
    expect((await reopened.inject({ method: "GET", url: `${base}/dm-dev` })).json().messages).toHaveLength(4);
  });
  it("pauses for a real backend approval and resumes the same reply/session after a decision", async () => {
    const claude = new MockProvider({ id: "claude-code", script: [
      [{ type: "approval_request", request: { requestId: "write-chat", action: "filesystem.write", risk: "medium", summary: "Save the draft", payload: { path: "draft.md" } } }],
      [{ type: "tool_result", callId: "write-chat", output: "saved" }, { type: "text", text: "Draft saved" }, { type: "done" }],
    ] });
    const { server } = await fixture([claude]);
    await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Save a draft" } });
    const waiting = await waitReply(server, "dm-manager", "waiting");
    const needs = (await server.inject({ method: "GET", url: "/api/needs-you?status=pending" })).json();
    expect(needs).toHaveLength(1);
    expect((await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Duplicate" } })).statusCode).toBe(409);
    await server.inject({ method: "POST", url: `/api/needs-you/${needs[0].id}/resolve`, payload: { resolution: "approved" } });
    const completed = await waitReply(server, "dm-manager");
    expect(completed.messages[1]).toMatchObject({ id: waiting.messages[1].id, sessionId: waiting.messages[1].sessionId, text: "Draft saved" });
    const approvals = (await server.inject({ method: "GET", url: "/api/approvals" })).json();
    expect(approvals[0]).toMatchObject({ status: "approved", outcome: "executed" });
  });
  it("requires explicit preview opt-in and rejects nonexistent recipients", async () => {
    const { server } = await fixture();
    const blocked = await server.inject({ method: "POST", url: `${base}/dm-dev/messages`, payload: { text: "Hello" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain("preview consent");
    expect((await server.inject({ method: "POST", url: `${base}/channel/messages`, payload: { text: "Hello", targetId: "outsider" } })).statusCode).toBe(409);
    expect((await server.inject({ method: "GET", url: `${base}/dm-dev` })).json().messages).toEqual([]);
  });
  it("creates and edits agents without changing identity, Manager status or existing Skills", async () => {
    const { server } = await fixture();
    const payload = { name: "Maya", role: "Researcher", instructions: "Research carefully", engine: { mode: "manual", provider: "gemini" } };
    const added = await server.inject({ method: "POST", url: "/api/teams/crew/members", payload });
    expect(added.statusCode).toBe(200);
    const member = added.json().members[2];
    expect(member).toMatchObject({ name: "Maya", engine: { provider: "gemini" }, isManager: false });
    const edited = await server.inject({ method: "PATCH", url: `/api/teams/crew/members/${member.id}`, payload: { ...payload, engine: { mode: "manual", provider: "codex" } } });
    expect(edited.json().members[2]).toMatchObject({ id: member.id, engine: { provider: "codex" } });
    expect(edited.json().members.filter((m: { isManager: boolean }) => m.isManager)).toHaveLength(1);
  });
  it("saves a chosen model, restores it on reload, and clears it when the engine changes", async () => {
    const { root, server } = await fixture();
    const payload = { name: "Maya", role: "Researcher", instructions: "Research carefully", engine: { mode: "manual", provider: "cursor", model: "composer-1" } };
    const added = await server.inject({ method: "POST", url: "/api/teams/crew/members", payload });
    expect(added.statusCode).toBe(200);
    const member = added.json().members[2];
    expect(member.engine).toEqual({ mode: "manual", provider: "cursor", model: "composer-1" });
    // The stored choice survives a restart, so the edit form can prefill it.
    await server.close();
    const reopened = buildServer({ workspaceRoot: root, appConfigDir: path.join(root, "config") }); servers.push(reopened);
    const reloaded = (await reopened.inject({ method: "GET", url: "/api/teams/crew" })).json();
    expect(reloaded.team.members[2].engine).toEqual({ mode: "manual", provider: "cursor", model: "composer-1" });
    const switched = await reopened.inject({ method: "PATCH", url: `/api/teams/crew/members/${member.id}`, payload: { ...payload, engine: { mode: "manual", provider: "gemini", model: "pro" } } });
    expect(switched.json().members[2].engine).toEqual({ mode: "manual", provider: "gemini", model: "pro" });
    const cleared = await reopened.inject({ method: "PATCH", url: `/api/teams/crew/members/${member.id}`, payload: { ...payload, engine: { mode: "manual", provider: "gemini" } } });
    expect(cleared.json().members[2].engine).toEqual({ mode: "manual", provider: "gemini" });
  });
  it("rejects a model the chosen engine cannot run and a model on Auto", async () => {
    const { server } = await fixture();
    const payload = { name: "Maya", role: "Researcher", instructions: "Research carefully", engine: { mode: "manual", provider: "gemini", model: "composer-1" } };
    const incompatible = await server.inject({ method: "POST", url: "/api/teams/crew/members", payload });
    expect(incompatible.statusCode).toBe(409);
    expect(incompatible.json().error.message).toContain("Antigravity");
    const unsafe = await server.inject({ method: "POST", url: "/api/teams/crew/members", payload: { ...payload, engine: { mode: "manual", provider: "codex", model: "gpt --sandbox danger" } } });
    expect(unsafe.statusCode).toBe(400);
    const onAuto = await server.inject({ method: "POST", url: "/api/teams/crew/members", payload: { ...payload, engine: { mode: "auto", model: "sonnet" } } });
    expect(onAuto.statusCode).toBe(409);
    expect(onAuto.json().error.message).toContain("Auto");
    const unknownEngine = await server.inject({ method: "POST", url: "/api/teams/crew/members", payload: { ...payload, engine: { mode: "manual", provider: "not-an-engine" } } });
    expect(unknownEngine.statusCode).toBe(409);
    expect((await server.inject({ method: "GET", url: "/api/teams/crew" })).json().team.members).toHaveLength(2);
  });
  it("records the model the engine confirms it ran beside the one that was asked for", async () => {
    const claude = new MockProvider({ id: "claude-code", script: [[
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2, costUsd: 0, model: "claude-haiku-4-5-20251001" } },
      { type: "text", text: "Hi" }, { type: "done" },
    ]] });
    const { server } = await fixture([claude]);
    await server.inject({ method: "PATCH", url: "/api/teams/crew/members/manager", payload: { name: "Alex", role: "Manager", instructions: "Coordinate", engine: { mode: "manual", provider: "claude-code", model: "haiku" } } });
    await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Hello" } });
    const thread = await waitReply(server, "dm-manager");
    expect(thread.messages[1]).toMatchObject({ model: "haiku", resolvedModel: "claude-haiku-4-5-20251001" });
  });
  it("sends the saved model to the provider and leaves older agents on the engine default", async () => {
    const claude = new MockProvider({ id: "claude-code", script: [[{ type: "text", text: "Alex reply" }, { type: "done" }]] });
    const codex = new MockProvider({ id: "codex", script: [[{ type: "text", text: "Sam reply" }, { type: "done" }]] });
    const { server } = await fixture([claude, codex]);
    await server.inject({ method: "PATCH", url: "/api/teams/crew/members/manager", payload: { name: "Alex", role: "Manager", instructions: "Coordinate", engine: { mode: "manual", provider: "claude-code", model: "claude-opus-5" } } });
    await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Hello" } });
    const thread = await waitReply(server, "dm-manager");
    expect(claude.specs[0]).toMatchObject({ memberId: "manager", model: "claude-opus-5" });
    expect(thread.messages[1]).toMatchObject({ provider: "claude-code", model: "claude-opus-5" });
    // The Developer was stored before model selection existed and must still run.
    await server.inject({ method: "POST", url: `${base}/dm-dev/messages`, payload: { text: "Hello", allowIsolatedPreview: true } });
    await waitReply(server, "dm-dev");
    expect(codex.specs[0]).toMatchObject({ memberId: "dev" });
    expect(codex.specs[0]).not.toHaveProperty("model");
  });
  it("stops a waiting reply without leaving a pending approval", async () => {
    const claude = new MockProvider({ id: "claude-code", script: [[{ type: "approval_request", request: { requestId: "approval", action: "filesystem.write", risk: "medium", summary: "Write", payload: {} } }]] });
    const { server } = await fixture([claude]);
    await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Wait for me" } });
    await waitReply(server, "dm-manager", "waiting");
    await server.inject({ method: "POST", url: `${base}/dm-manager/stop` });
    const stopped = await waitReply(server, "dm-manager", "stopped");
    expect((await server.inject({ method: "GET", url: "/api/needs-you?status=pending" })).json()).toEqual([]);
    // A stop must explain itself, including when it lands without an error.
    expect(stopped.messages.at(-1).notice).toMatch(/stopped/i);
  });
  it("shuts down cleanly right after a Stop, and answers a repeated Stop", async () => {
    const claude = new MockProvider({ id: "claude-code", script: [[{ type: "approval_request", request: { requestId: "approval", action: "filesystem.write", risk: "medium", summary: "Write", payload: {} } }]] });
    const { server } = await fixture([claude]);
    await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Wait for me" } });
    await waitReply(server, "dm-manager", "waiting");
    expect((await server.inject({ method: "POST", url: `${base}/dm-manager/stop` })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: `${base}/dm-manager/stop` })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/needs-you?status=pending" })).json()).toEqual([]);
    // The shutdown hook stops every live turn, so it must tolerate an already stopped one.
    await expect(server.close()).resolves.toBeUndefined();
  });
  it("tells the reader when a signed-in engine refused the turn over its own usage limit", async () => {
    // Codex CLI 0.154.0 reports a signed-in account whose every turn is refused this way,
    // and `codex login status` cannot see that, so the reply has to say it.
    const codex = new MockProvider({ id: "codex", script: [[{ type: "error", message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at Sep 14th, 2026 2:54 AM." }]] });
    const { server } = await fixture([new MockProvider({ id: "claude-code" }), codex]);
    await server.inject({ method: "POST", url: `${base}/dm-dev/messages`, payload: { text: "Hello", allowIsolatedPreview: true } });
    const failed = await waitReply(server, "dm-dev", "failed");
    expect(failed.messages.at(-1).notice).toMatch(/usage limit/i);
    // DayCrew's own sentence, never the engine's upgrade link.
    expect(failed.messages.at(-1).notice).not.toMatch(/http/);
  });
  it("keeps interrupted history stopped when the first action after restart is a new message", async () => {
    const claude = new MockProvider({ id: "claude-code" });
    const { root, server } = await fixture([claude]);
    await writeJson(statePath(root, "conversations", "crew", "dm-manager.json"), {
      id: "dm-manager", teamId: "crew", messages: [{ id: "old-reply", author: "agent", memberId: "manager", name: "Alex", text: "Partial reply", status: "responding", createdAt: new Date().toISOString() }],
    }, ConversationSchema);
    expect((await server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Continue" } })).statusCode).toBe(200);
    const thread = await waitReply(server, "dm-manager");
    expect(thread.messages[0]).toMatchObject({ status: "stopped", text: "Partial reply" });
    expect(thread.messages).toHaveLength(3);
  });
  it("does not share conversation history between Workspaces with the same Team and Member IDs", async () => {
    const claude = new MockProvider({ id: "claude-code" });
    const first = await fixture([claude]);
    const second = await fixture([claude]);
    await first.server.inject({ method: "POST", url: `${base}/dm-manager/messages`, payload: { text: "Private to the first Workspace" } });
    await waitReply(first.server, "dm-manager");
    expect((await second.server.inject({ method: "GET", url: `${base}/dm-manager` })).json().messages).toEqual([]);
  });
});

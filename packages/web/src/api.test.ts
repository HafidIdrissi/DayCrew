import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, detectEngines, requestJson } from "./api";

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

// Use the real HTTP parser: fetch mocks returning 200 miss empty JSON body errors.
const connect = () => {
  const server = Fastify();
  servers.push(server);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const response = await server.inject({
      method: init.method as "GET" | "POST" | undefined ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === "string" ? { payload: init.body } : {}),
    });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  });
  return server;
};

describe("Local API request encoding", () => {
  it("reaches engine detection without declaring an empty JSON body", async () => {
    const server = connect();
    server.post("/api/settings/engines/detect", async (request) => {
      expect(request.headers["content-type"]).toBeUndefined();
      expect(request.headers["x-daycrew-workspace"]).toBe("workspace-one");
      return [{ id: "claude-code", available: true, message: "Installed and authenticated" }];
    });
    expect(await detectEngines("workspace-one")).toEqual([{ id: "claude-code", available: true, message: "Installed and authenticated" }]);
  });

  it("also accepts bodyless stop requests", async () => {
    const server = connect();
    server.post("/stop", async () => ({ stopped: true }));
    expect(await requestJson("/stop", { method: "POST" }, "workspace-one")).toEqual({ stopped: true });
  });

  it("still encodes creation payloads as JSON", async () => {
    const server = connect();
    server.post("/api/app/workspace/create", async (request) => {
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body).toEqual({ root: "/tmp/project", name: "Project" });
      return { workspace: { initialized: true } };
    });
    expect(await createWorkspace("/tmp/project", "Project")).toEqual({ workspace: { initialized: true } });
  });
});

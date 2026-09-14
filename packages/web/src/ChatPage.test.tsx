// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentForm, ChatPage } from "./ChatPage";
import type { Engine } from "./types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const engine = (overrides: Partial<Engine> & Pick<Engine, "id" | "name">): Engine => ({
  kind: "cli", classification: "production-ready", autoEligible: false, modelDiscovery: "static",
  allowsCustomModelId: true, models: [], modelsVerifiedAt: "2026-09-13", docsUrl: "https://example.test",
  capabilities: [], limitations: [],
  ...overrides,
});
const engines: Engine[] = [
  engine({ id: "claude-code", name: "Claude Code", binary: "claude", autoEligible: true, models: [{ id: "sonnet", label: "Sonnet (alias)" }] }),
  engine({
    id: "cursor", name: "Cursor CLI", binary: "cursor-agent", classification: "read-only-preview",
    modelDiscovery: "dynamic", models: [],
    setup: { install: [{ platform: "All", command: "curl https://cursor.com/install -fsS | bash" }], signInCommand: "cursor-agent login", authCheck: "Reads cursor-agent status.", authDetectable: true, notes: [] },
  }),
  engine({ id: "gemini", name: "Antigravity Agent API (Gemini models)", classification: "restricted-experimental", allowsCustomModelId: false, models: [{ id: "pro", label: "Pro" }] }),
  engine({ id: "grok", name: "Grok Build", binary: "grok", classification: "read-only-preview", modelDiscovery: "dynamic", models: [{ id: "grok-4.6", label: "Grok 4.6" }] }),
  engine({ id: "demo", name: "Demo Mode", kind: "simulated", classification: "simulated", modelDiscovery: "unsupported", allowsCustomModelId: false }),
];

/** Stubs only the model-catalogue endpoint the form calls; nothing else is needed. */
const stubCatalog = (byEngine: Record<string, unknown>) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const id = /[/]api[/]engines[/]([^/]+)[/]models/.exec(url)?.[1] ?? "";
    const payload = byEngine[id];
    const headers = { get: () => "application/json" };
    if (payload instanceof Error) return { ok: false, status: 500, headers, json: async () => ({ error: { code: "REQUEST_INVALID" } }) } as unknown as Response;
    return { ok: true, status: 200, headers, json: async () => payload } as unknown as Response;
  }));
};

describe("Agent identity form", () => {
  it("fills a starting brief without overwriting custom instructions", () => {
    render(<AgentForm onSave={async () => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Developer/ }));
    const brief = screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
    expect(brief.value).toContain("maintainable changes");
    fireEvent.change(brief, { target: { value: "Follow our accessibility checklist." } });
    fireEvent.click(screen.getByRole("button", { name: /QA/ }));
    expect(brief.value).toBe("Follow our accessibility checklist.");
  });

  it("preserves Auto when editing an existing agent", async () => {
    const save = vi.fn(async () => undefined);
    render(<AgentForm member={{ id: "alex", name: "Alex", role: "Developer", instructions: "Build features.", isManager: false, engine: { mode: "auto" } }} onSave={save} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ engine: { mode: "auto" } })));
  });

  it("saves the chosen specialty with the name, instructions and engine", async () => {
    const save = vi.fn(async () => undefined);
    render(<AgentForm engines={engines} onSave={save} onCancel={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: " Alex " } });
    fireEvent.click(screen.getByRole("button", { name: /Researcher/ }));
    expect((screen.getByRole("textbox", { name: "Role" }) as HTMLInputElement).value).toBe("Researcher");
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Find primary sources." } });
    fireEvent.change(screen.getByRole("combobox", { name: "AI Engine" }), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to the crew" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ name: "Alex", role: "Researcher", instructions: "Find primary sources.", engine: { mode: "manual", provider: "demo" } }));
  });

  it("offers no model choice for an engine that takes none", async () => {
    render(<AgentForm engines={engines} selectionId="selection" onSave={async () => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox", { name: "AI Engine" }), { target: { value: "demo" } });
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
    expect(await screen.findByText(/takes no model choice/)).toBeTruthy();
  });

  it("loads the selected engine's models and saves the chosen one", async () => {
    stubCatalog({ cursor: { engineId: "cursor", source: "live", allowsCustomModelId: true, models: [{ id: "composer-1", label: "composer-1" }, { id: "gpt-5", label: "gpt-5" }] } });
    const save = vi.fn(async () => undefined);
    render(<AgentForm engines={engines} selectionId="selection" onSave={save} onCancel={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Robin" } });
    fireEvent.click(screen.getByRole("button", { name: /Developer/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "AI Engine" }), { target: { value: "cursor" } });
    const models = await screen.findByRole("combobox", { name: "Model" });
    await waitFor(() => expect(screen.getByRole("option", { name: /gpt-5/ })).toBeTruthy());
    expect(await screen.findByText(/2 models reported by Cursor CLI/)).toBeTruthy();
    fireEvent.change(models, { target: { value: "gpt-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to the crew" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ engine: { mode: "manual", provider: "cursor", model: "gpt-5" } })));
  });

  it("prefills the saved engine and model when editing, and keeps a model that is no longer listed", async () => {
    stubCatalog({ cursor: { engineId: "cursor", source: "live", allowsCustomModelId: true, models: [{ id: "composer-1", label: "composer-1" }] } });
    const save = vi.fn(async () => undefined);
    render(<AgentForm engines={engines} selectionId="selection" onSave={save} onCancel={() => undefined}
      member={{ id: "robin", name: "Robin", role: "Developer", instructions: "Build things.", isManager: false, engine: { mode: "manual", provider: "cursor", model: "cursor-retired" } }} />);
    expect((screen.getByRole("combobox", { name: "AI Engine" }) as HTMLSelectElement).value).toBe("cursor");
    const models = await screen.findByRole("combobox", { name: "Model" });
    expect((models as HTMLSelectElement).value).toBe("cursor-retired");
    expect(screen.getByRole("option", { name: /saved earlier/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ engine: { mode: "manual", provider: "cursor", model: "cursor-retired" } })));
  });

  it("returns to the engine default when the engine changes", async () => {
    stubCatalog({
      cursor: { engineId: "cursor", source: "live", allowsCustomModelId: true, models: [{ id: "composer-1", label: "composer-1" }] },
      gemini: { engineId: "gemini", source: "catalog", allowsCustomModelId: false, models: [{ id: "pro", label: "Pro" }] },
    });
    const save = vi.fn(async () => undefined);
    render(<AgentForm engines={engines} selectionId="selection" onSave={save} onCancel={() => undefined}
      member={{ id: "robin", name: "Robin", role: "Developer", instructions: "Build things.", isManager: false, engine: { mode: "manual", provider: "cursor", model: "composer-1" } }} />);
    await screen.findByRole("combobox", { name: "Model" });
    fireEvent.change(screen.getByRole("combobox", { name: "AI Engine" }), { target: { value: "gemini" } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe(""));
    // Gemini documents a fixed set of tiers, so no custom identifier is offered.
    expect(screen.queryByRole("option", { name: /Custom model identifier/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ engine: { mode: "manual", provider: "gemini" } })));
  });

  it("explains an empty or unreadable catalogue and still allows a custom identifier", async () => {
    stubCatalog({
      cursor: { engineId: "cursor", source: "catalog", allowsCustomModelId: true, models: [], warning: "Cursor CLI could not list its models." },
      "claude-code": new Error("unreadable"),
    });
    const save = vi.fn(async () => undefined);
    render(<AgentForm engines={engines} selectionId="selection" onSave={save} onCancel={() => undefined}
      member={{ id: "robin", name: "Robin", role: "Developer", instructions: "Build things.", isManager: false, engine: { mode: "manual", provider: "cursor" } }} />);
    expect(await screen.findByText(/Cursor CLI could not list its models/)).toBeTruthy();
    fireEvent.change(await screen.findByRole("combobox", { name: "Model" }), { target: { value: "__custom__" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Model identifier" }), { target: { value: "cursor-preview-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ engine: { mode: "manual", provider: "cursor", model: "cursor-preview-1" } })));

    cleanup();
    render(<AgentForm engines={engines} selectionId="selection" onSave={async () => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox", { name: "AI Engine" }), { target: { value: "claude-code" } });
    expect(await screen.findByText(/DayCrew could not complete this request/)).toBeTruthy();
  });

  it("keeps a saved model when the engine registry is unavailable", async () => {
    const save = vi.fn(async () => undefined);
    // No engines and no selectionId: the form cannot know what this engine supports.
    render(<AgentForm onSave={save} onCancel={() => undefined}
      member={{ id: "robin", name: "Robin", role: "Developer", instructions: "Build things.", isManager: false, engine: { mode: "manual", provider: "cursor", model: "composer-1" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ engine: { mode: "manual", provider: "cursor", model: "composer-1" } })));
  });

  it("points at the CLI's own sign-in command instead of asking for a key", async () => {
    stubCatalog({ cursor: { engineId: "cursor", source: "catalog", allowsCustomModelId: true, models: [] } });
    render(<AgentForm engines={engines} selectionId="selection" onSave={async () => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox", { name: "AI Engine" }), { target: { value: "cursor" } });
    expect(await screen.findByText(/never asks for an API key/)).toBeTruthy();
    expect(screen.getByText("cursor-agent login")).toBeTruthy();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  it("keeps the brief and exposes an error when saving fails", async () => {
    render(<AgentForm onSave={async () => { throw new Error("Local service unavailable"); }} onCancel={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Alex" } });
    fireEvent.click(screen.getByRole("button", { name: /Developer/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Build the app." } });
    fireEvent.click(screen.getByRole("button", { name: "Add to the crew" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Local service unavailable");
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Build the app.");
    expect((screen.getByRole("button", { name: "Add to the crew" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

const setup = (provider: string, available = true) => {
  const sent: string[] = [];
  const team = { id: "crew", name: "Crew", members: [{ id: "manager", name: "Alex", role: "Manager", isManager: true, instructions: "Help", engine: { mode: "manual", provider } }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let data: unknown;
    if (url === "/api/teams/crew") data = { team };
    else if (url === "/api/teams") data = [team];
    else if (url === "/api/workspace") data = { id: "ws", name: "Workspace" };
    else if (url === "/api/settings/engines/detect") data = [{ id: provider, ready: available, installed: true, authenticated: available, message: available ? "Installed and authenticated" : "Not ready on this machine" }];
    else if (url === "/api/engines") data = engines;
    else if (url.startsWith("/api/engines/")) data = { engineId: provider, source: "catalog", allowsCustomModelId: true, models: [] };
    else if (url === "/api/tasks/dashboard") data = { needsYou: [] };
    else if (url === "/api/teams/crew/members" && init?.method === "POST") {
      const value = JSON.parse(String(init.body)) as { name: string; role: string; instructions: string; engine: { mode: string; provider?: string } };
      data = { ...team, members: [...team.members, { ...value, id: "new-member", isManager: false }] };
    }
    else if (url.endsWith("/messages")) {
      sent.push(String(init?.body)); data = { id: "channel", teamId: "crew", messages: [] };
    } else data = { id: "channel", teamId: "crew", messages: [] };
    return { ok: true, status: 200, json: async () => data } as Response;
  }));
  render(<ChatPage teamId="crew" selectionId="selection" onSwitchWorkspace={() => undefined} onWorkspaceIssue={() => undefined} />);
  return sent;
};

describe("Chat composer", () => {
  it("confirms agent creation and opens the saved teammate's conversation", async () => {
    setup("claude-code");
    fireEvent.click(await screen.findByRole("button", { name: "Create agent" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Jules" } });
    fireEvent.click(screen.getByRole("button", { name: /Developer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to the crew" }));
    expect(await screen.findByText(/saved to your crew/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(await screen.findByRole("heading", { name: "Jules" })).toBeTruthy();
  });

  it("blocks buttons and keyboard submission for an unavailable engine", async () => {
    const sent = setup("claude-code", false);
    await screen.findByText("Not ready on this machine");
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Hello" } });
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(sent).toEqual([]);
  });
  it("requires preview consent for the keyboard shortcut and sends after consent", async () => {
    const sent = setup("grok");
    await screen.findByText("Installed and authenticated");
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.parse(sent[0]!)).toMatchObject({ text: "Hello", allowIsolatedPreview: true });
  });
});

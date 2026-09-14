import * as React from "react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, detectEngines, listEngines, listTeams, requestJson, startGoal } from "./api";
import { AppSidebar, Avatar, ConnectionStatus, Icon, NeedsYouBadge, WorkspaceSwitcher } from "./components";
import { Button, ErrorState, LoadingState } from "./ui";
import { AgentForm } from "./AgentForm";
import type { Engine, EngineDetection, GlobalNeedsYouItem, Team, TeamMember, Workspace } from "./types";

type ChatMessage = { id: string; author: "human" | "agent"; memberId?: string; name: string; provider?: string; model?: string; resolvedModel?: string; text: string; status: string; createdAt: string; notice?: string; sessionId?: string };
type Conversation = { id: string; teamId: string; messages: ChatMessage[] };
/** Engine display names come from the registry the server serves, not a local copy. */
const engineName = (catalog: Engine[], id?: string) =>
  catalog.find((engine) => engine.id === id)?.name ?? (id === undefined ? "Claude Code (Auto)" : id);

export { AgentForm } from "./AgentForm";

export const ChatPage = ({ teamId, selectionId, onSwitchWorkspace, onWorkspaceIssue }: { teamId: string; selectionId: string; onSwitchWorkspace: () => void; onWorkspaceIssue: () => void }) => {
  const [team, setTeam] = useState<Team>();
  const [teams, setTeams] = useState<Team[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [conversationId, setConversationId] = useState("channel");
  const [conversation, setConversation] = useState<Conversation>();
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TeamMember | "new">();
  const [savedAgent, setSavedAgent] = useState<{ id: string; name: string }>();
  const [previewConsent, setPreviewConsent] = useState(false);
  const [needs, setNeeds] = useState<GlobalNeedsYouItem[]>([]);
  const [detections, setDetections] = useState<EngineDetection[]>();
  const [engineCatalog, setEngineCatalog] = useState<Engine[]>([]);
  const [checkingEngine, setCheckingEngine] = useState(true);
  const [engineError, setEngineError] = useState<string>();
  const generation = useRef(0);
  const feed = useRef<HTMLDivElement>(null);
  const base = `/api/teams/${encodeURIComponent(teamId)}`;
  const conversationUrl = `${base}/conversations/${encodeURIComponent(conversationId)}`;
  const fail = (caught: unknown) => {
    if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
    else setError(caught instanceof Error ? caught.message : "DayCrew could not load this conversation.");
  };
  const checkEngines = async () => {
    setCheckingEngine(true); setEngineError(undefined);
    try { setDetections(await detectEngines(selectionId)); }
    catch (caught) {
      setDetections(undefined);
      if (caught instanceof ApiError && caught.code === "WORKSPACE_CHANGED") onWorkspaceIssue();
      setEngineError(caught instanceof Error ? `Could not check AI Engines: ${caught.message}` : "Could not check AI Engines. Retry or open Settings.");
    }
    finally { setCheckingEngine(false); }
  };
  useEffect(() => { void checkEngines(); }, [selectionId]);
  useEffect(() => {
    let active = true;
    // Do not trust a legacy backend that predates the engine registry endpoint.
    void listEngines(selectionId).then((next) => { if (active && Array.isArray(next)) setEngineCatalog(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [selectionId]);
  useEffect(() => {
    let active = true;
    void Promise.all([requestJson<{ team: Team }>(base, undefined, selectionId), listTeams(selectionId), requestJson<Workspace>("/api/workspace", undefined, selectionId)])
      .then(([next, all, ws]) => { if (active) { setTeam(next.team); setTeams(all); setWorkspace(ws); } }).catch((caught) => { if (active) fail(caught); });
    return () => { active = false; };
  }, [base, selectionId]);
  useEffect(() => {
    setConversation(undefined); setError(undefined); setPreviewConsent(false); setDraft("");
    const current = ++generation.current;
    let active = true; let fetching = false;
    const refresh = async () => {
      if (fetching) return; fetching = true;
      try {
        const [next, dashboard] = await Promise.all([requestJson<Conversation>(conversationUrl, undefined, selectionId), requestJson<{ needsYou: GlobalNeedsYouItem[] }>("/api/tasks/dashboard", undefined, selectionId)]);
        if (active && generation.current === current) { setConversation(next); setNeeds(dashboard.needsYou); }
      } catch (caught) { if (active) fail(caught); } finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 1_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversationUrl, selectionId]);
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [conversation?.messages.length, conversation?.messages.at(-1)?.text]);
  if (!team || !workspace) return <div className="app-frame"><AppSidebar activeView="Team" needsCount={0} /><main className="app-main">{error ? <ErrorState message={error} /> : <LoadingState label="Opening your Team conversations..." />}</main></div>;
  const channel = conversationId === "channel";
  const selected = channel ? team.members.find((m) => target ? m.id === target : m.isManager) : team.members.find((m) => `dm-${m.id}` === conversationId);
  const providerId = selected?.engine.mode === "manual" ? selected.engine.provider : "claude-code";
  const preview = providerId === "codex" || providerId === "gemini" || providerId === "cursor" || providerId === "grok";
  const detection = detections?.find((item) => item.id === providerId);
  const engineReady = providerId === "demo" || (!checkingEngine && detection?.ready === true);
  const last = conversation?.messages.at(-1);
  const responding = last?.status === "responding" || last?.status === "waiting";
  const pending = needs.filter((n) => n.team.id === teamId);
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!draft.trim() || !conversation || busy || responding || !engineReady || (preview && !previewConsent)) return;
    setBusy(true); setError(undefined);
    const current = generation.current;
    try {
      const next = await requestJson<Conversation>(`${conversationUrl}/messages`, { method: "POST", body: JSON.stringify({ text: draft, ...(channel && target ? { targetId: target } : {}), allowIsolatedPreview: previewConsent }) }, selectionId);
      if (current === generation.current) { setConversation(next); setDraft(""); }
    } catch (caught) { if (current === generation.current) fail(caught); } finally { setBusy(false); }
  };
  const stop = async () => { setBusy(true); try { await requestJson(`${conversationUrl}/stop`, { method: "POST" }, selectionId); } catch (caught) { fail(caught); } finally { setBusy(false); } };
  const launchGoal = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true); setError(undefined);
    try { await startGoal(teamId, draft.trim(), selectionId); window.location.hash = `teams/${teamId}/overview`; }
    catch (caught) { fail(caught); } finally { setBusy(false); }
  };
  const saveAgent = async (value: Pick<TeamMember, "name" | "role" | "instructions" | "engine">) => {
    const next = await requestJson<Team>(editing === "new" ? `${base}/members` : `${base}/members/${editing?.id}`, { method: editing === "new" ? "POST" : "PATCH", body: JSON.stringify(value) }, selectionId);
    const saved = editing === "new" ? next.members.find((item) => !team.members.some((current) => current.id === item.id)) : next.members.find((item) => item.id === editing?.id);
    if (saved) setSavedAgent({ id: saved.id, name: saved.name });
    setTeam(next); setEditing(undefined); setPreviewConsent(false);
  };
  return <div className="app-frame"><AppSidebar activeView="Team" needsCount={needs.length} /><main className="app-main chat-main">
    <header className="top-bar"><WorkspaceSwitcher workspace={workspace} onSwitch={onSwitchWorkspace} /><div className="top-actions"><ConnectionStatus /><NeedsYouBadge count={needs.length} /></div></header>
    {savedAgent && <div className="chat-save-feedback" role="status"><Icon name="check" size={18} /><span><strong>{savedAgent.name}</strong> saved to your crew.</span><button type="button" className="text-button" onClick={() => { setConversationId(`dm-${savedAgent.id}`); setSavedAgent(undefined); }}>Open conversation</button><button type="button" className="icon-button" aria-label="Dismiss saved confirmation" onClick={() => setSavedAgent(undefined)}><Icon name="close" size={16} /></button></div>}
    <div className={`chat-workspace ${editing ? "chat-editing" : ""}`}>
      <aside className="conversation-rail" aria-label="Conversations">
        <label className="chat-team-select">Team<select value={teamId} onChange={(e) => { window.location.hash = `teams/${e.target.value}`; }}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <div className="chat-rail-heading"><span>TEAM CHANNEL</span></div>
        <button type="button" className={`conversation-choice ${channel ? "selected" : ""}`} onClick={() => setConversationId("channel")}><span className="channel-symbol">#</span><span><strong>General</strong><small>Coordinate with your Team</small></span></button>
        <div className="chat-rail-heading"><span>DIRECT MESSAGES</span><button type="button" aria-label="Add a teammate" className="icon-button" onClick={() => setEditing("new")}>+</button></div>
        {team.members.map((m) => <button type="button" key={m.id} className={`conversation-choice ${conversationId === `dm-${m.id}` ? "selected" : ""}`} onClick={() => { setConversationId(`dm-${m.id}`); setEditing(undefined); }}><Avatar member={m} size="sm" /><span><strong>{m.name}</strong><small>{m.isManager ? "Manager" : m.role}</small></span></button>)}
        <Button type="button" variant="secondary" onClick={() => setEditing("new")}>Create agent</Button>
        <a className="chat-overview-link" href={`#teams/${teamId}/overview`}>Team overview & Skills →</a>
      </aside>
      <section className="conversation-pane" aria-label={channel ? "Team channel" : `Chat with ${selected?.name}`}>
        <header className="conversation-header"><div><h1>{channel ? "# General" : selected?.name}</h1><p>{channel ? "A shared conversation. Choose who replies; the Manager coordinates by default." : `${selected?.role} · Private conversation`}</p></div>{selected && <button type="button" className="secondary-button" onClick={() => setEditing(selected)}>Edit agent</button>}</header>
        <div className="chat-engine-line"><span className="ui-badge badge-info">{engineName(engineCatalog, providerId)}</span><span>{selected?.engine.model ?? "Default model of the CLI"}</span>{providerId === "demo" && <strong>Simulated replies</strong>}</div>
        {providerId !== "demo" && <div className="chat-engine-line" role="status"><span>{checkingEngine ? "Checking installation and authentication..." : engineError ?? detection?.message ?? "Engine unavailable"}</span><button type="button" className="secondary-button" disabled={checkingEngine} onClick={() => void checkEngines()}>Check again</button><a href="#settings">Engine settings</a></div>}
        <div className="message-feed" ref={feed} role="log" aria-label="Message history" aria-live="polite">
          {!conversation ? <LoadingState label="Loading messages..." /> : !conversation.messages.length ? <div className="chat-empty"><span>✦</span><h2>{channel ? "Bring your Team into the conversation." : `Say hello to ${selected?.name}.`}</h2><p>Ask a question, share an idea, or discuss the next step. Your conversation stays in this Workspace.</p></div> : conversation.messages.map((m) => <article key={m.id} className={`chat-message message-${m.author}`}>
            <span className={`chat-author-avatar ${m.author}`}>{m.author === "human" ? "You" : m.name.split(/\s+/).map((s) => s[0]).join("").slice(0, 2)}</span><div><header><strong>{m.name}</strong><time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{m.provider && <small>{engineName(engineCatalog, m.provider)}{m.model ? ` · ${m.model}` : ""}{m.resolvedModel && m.resolvedModel !== m.model ? ` → ran ${m.resolvedModel}` : ""}</small>}</header>{m.text && <div className="chat-message-text">{m.text}</div>}{m.status === "responding" && <span className="chat-response-state" role="status">Responding…</span>}{m.status === "waiting" && <a className="chat-approval-card" href="#needs-you">Approval needed — review in Needs You →</a>}{m.notice && <p className="chat-notice">{m.notice}</p>}</div>
          </article>)}
        </div>
        {pending.length > 0 && <a href="#needs-you" className="chat-attention">{pending.length} Team decision{pending.length === 1 ? "" : "s"} in Needs You →</a>}
        <form className="chat-composer" onSubmit={(e) => void send(e)}>
          {channel && <label className="chat-recipient">Reply from<select aria-label="Reply from" value={target} disabled={busy || responding} onChange={(e) => { setTarget(e.target.value); setPreviewConsent(false); }}><option value="">Manager (default)</option>{team.members.filter((m) => !m.isManager).map((m) => <option key={m.id} value={m.id}>@{m.name}</option>)}</select></label>}
          {preview && <label className="chat-preview-consent"><input type="checkbox" checked={previewConsent} onChange={(e) => setPreviewConsent(e.target.checked)} /><span>Enable restricted preview for this conversation. Messages go to the provider from a temporary folder; project files are not copied. The engine may access files outside that folder and cannot provide reliable approval controls. Use trusted prompts only.</span></label>}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <textarea aria-label="Message" placeholder={`Message ${selected?.name ?? "your Team"}…`} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={8_000} disabled={busy} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void send(e); } }} />
          <div className="chat-composer-footer"><small>Conversation history provides context · Ctrl / ⌘ + Enter to send</small><div>{channel && <Button type="button" variant="secondary" disabled={busy || responding || !draft.trim()} onClick={() => void launchGoal()}>Start Team Goal</Button>}{responding ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void stop()}>Stop reply</Button> : <Button disabled={busy || !conversation || !draft.trim() || !engineReady || (preview && !previewConsent)}>{busy ? "Connecting…" : "Send message"}</Button>}</div></div>
        </form>
      </section>
      {editing && <AgentForm key={editing === "new" ? "new" : editing.id} {...(editing === "new" ? {} : { member: editing })} engines={engineCatalog} detections={detections ?? []} selectionId={selectionId} onSave={saveAgent} onCancel={() => setEditing(undefined)} />}
    </div>
  </main></div>;
};

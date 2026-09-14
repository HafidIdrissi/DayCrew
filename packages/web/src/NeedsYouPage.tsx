import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, loadTasksDashboard, resolveNeedsYou } from "./api";
import { AppPage, Avatar, Icon, LoadingTeamPage, formatRelativeTime } from "./components";
import { memberShape } from "./taskUtils";
import type { GlobalNeedsYouItem, TasksData } from "./types";

export type NeedsResolution = "approved" | "denied" | "resolved" | "dismissed";
export type ResolveHandler = (item: GlobalNeedsYouItem, resolution: NeedsResolution, feedback?: string) => Promise<void>;

const groupNames: Record<GlobalNeedsYouItem["kind"], string> = {
  approval: "Approvals",
  decision: "Decisions",
  blocker: "Blockers",
  "failed-task": "Failed Tasks",
  review: "Review Requests",
};

export const NeedsYouActions = ({ item, busy, onResolve }: {
  item: GlobalNeedsYouItem;
  busy: boolean;
  onResolve: ResolveHandler;
}) => {
  const [replying, setReplying] = useState(false);
  const [feedback, setFeedback] = useState("");
  const submitFeedback = (resolution: "denied" | "resolved") => {
    if (!feedback.trim()) return;
    void onResolve(item, resolution, feedback).then(() => { setReplying(false); setFeedback(""); });
  };
  // The live provider session is gone: a decision could no longer reach it, so never offer one.
  if (item.recoveryRequired) return <div className="needs-item-actions">
    <p className="needs-recovery" role="status">Claude was interrupted before this action ran. The action did not run, and DayCrew cannot continue this Task from here.</p>
    {item.task && <a className="secondary-button" href={`#tasks/${item.task.sessionId}/${item.task.id}`}>Open Task</a>}
    <a className="secondary-button" href={`#teams/${item.team.id}`}>Open Team</a>
    <button className="text-button" disabled={busy} onClick={() => void onResolve(item, "resolved")}>Mark handled</button>
  </div>;
  if (item.kind === "approval") return <div className="needs-item-actions">
    <button className="primary-button" disabled={busy} onClick={() => void onResolve(item, "approved")}>Approve</button>
    <button className="secondary-button danger" disabled={busy} onClick={() => void onResolve(item, "denied")}>Deny</button>
    <button className="text-button" disabled={busy} onClick={() => setReplying((value) => !value)}>Deny with feedback</button>
    {replying && <div className="needs-feedback"><label>Feedback<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Explain the safer approach or required change." /></label><button className="secondary-button" disabled={busy || !feedback.trim()} onClick={() => submitFeedback("denied")}>Send denial</button></div>}
  </div>;
  if (item.kind === "decision") return <div className="needs-item-actions">
    <button className="primary-button" disabled={busy} onClick={() => setReplying(true)}>Reply with guidance</button>
    <button className="text-button" disabled={busy} onClick={() => void onResolve(item, "dismissed")}>Dismiss</button>
    {replying && <div className="needs-feedback"><label>Your decision<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="State your choice and any guidance for the Manager." /></label><button className="secondary-button" disabled={busy || !feedback.trim()} onClick={() => submitFeedback("resolved")}>Send guidance</button></div>}
  </div>;
  if (item.kind === "review") return <div className="needs-item-actions">
    <button className="primary-button" disabled={busy} onClick={() => void onResolve(item, "resolved")}>Accept</button>
    <button className="secondary-button" disabled={busy} onClick={() => setReplying(true)}>Send back</button>
    {replying && <div className="needs-feedback"><label>Review feedback<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Describe what should change." /></label><button className="secondary-button" disabled={busy || !feedback.trim()} onClick={() => submitFeedback("denied")}>Send feedback</button></div>}
  </div>;
  return <div className="needs-item-actions">
    {item.task && <a className="secondary-button" href={`#tasks/${item.task.sessionId}/${item.task.id}`}>Open Task</a>}
    <a className="text-button" href={`#teams/${item.team.id}`}>Open Team</a>
    <button className="text-button" disabled={busy} onClick={() => void onResolve(item, "resolved")}>{item.kind === "failed-task" ? "Mark handled" : "Mark resolved"}</button>
  </div>;
};

export const GlobalNeedsYou = ({ items, busyId, error, onResolve }: {
  items: readonly GlobalNeedsYouItem[];
  busyId?: string;
  error?: string;
  onResolve: ResolveHandler;
}) => {
  if (items.length === 0) return <div className="tasks-empty card-surface"><span><Icon name="check" size={25} /></span><div><h2>You are all caught up.</h2><p>Nothing needs your attention right now.</p></div></div>;
  return <div className="global-needs-list">
    {error && <p className="inline-error" role="alert">{error}</p>}
    {(Object.keys(groupNames) as GlobalNeedsYouItem["kind"][]).map((kind) => {
      const grouped = items.filter((item) => item.kind === kind);
      if (grouped.length === 0) return null;
      return <section className="needs-group" key={kind}><header><h2>{groupNames[kind]}</h2><span>{grouped.length}</span></header><div>{grouped.map((item) => <article className={`global-needs-card needs-kind-${kind}`} key={item.id}>
        <div className="global-needs-main">
          <div className="needs-who"><Avatar member={memberShape(item.who)} size="sm" /><span><strong>{item.who.name}</strong><small>{item.who.role}</small></span><time dateTime={item.createdAt}>{formatRelativeTime(item.createdAt)}</time></div>
          <h3>{item.what}</h3>
          {item.target && <div className="needs-target"><span>Target</span><code>{item.target}</code></div>}
          <dl className="needs-facts"><div><dt>Why</dt><dd>{item.why}</dd></div>{item.action && <div><dt>Action</dt><dd>{item.action}</dd></div>}{item.risk && <div><dt>Risk</dt><dd><span className={`risk-pill risk-${item.risk}`}>{item.risk}</span></dd></div>}{item.provider && item.kind === "failed-task" && <div><dt>Provider</dt><dd>{item.provider}</dd></div>}</dl>
          <p className="needs-next"><Icon name="knowledge" size={15} /><span><strong>Suggested next step</strong>{item.suggestedAction}</span></p>
          <NeedsYouActions item={item} busy={busyId === item.id} onResolve={onResolve} />
        </div>
        <aside><span>Related</span><a href={`#teams/${item.team.id}`}>{item.team.name}</a>{item.task && <a href={`#tasks/${item.task.sessionId}/${item.task.id}`}>{item.task.title}</a>}</aside>
      </article>)}</div></section>;
    })}
  </div>;
};

export const NeedsYouPage = ({ selectionId, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string;
  onSwitchWorkspace: () => void;
  onWorkspaceIssue: () => void;
}) => {
  const [data, setData] = useState<TasksData>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [teamId, setTeamId] = useState("all");
  const generation = useRef(0);

  const refresh = useCallback(async (quiet = false) => {
    const request = ++generation.current;
    if (!quiet) setError(undefined);
    try {
      const next = await loadTasksDashboard(selectionId);
      if (request === generation.current) setData(next);
    } catch (caught) {
      if (request !== generation.current) return;
      if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError(caught instanceof Error ? caught.message : "DayCrew could not load Needs You.");
    }
  }, [selectionId, onWorkspaceIssue]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(true); }, 4_000);
    return () => { ++generation.current; window.clearInterval(timer); };
  }, [refresh]);

  const resolve = async (item: GlobalNeedsYouItem, resolution: NeedsResolution, feedback?: string) => {
    setBusyId(item.id); setActionError(undefined);
    try {
      await resolveNeedsYou(item.id, resolution, selectionId, feedback);
      await refresh(true);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "DayCrew could not resolve this item.");
    } finally { setBusyId(undefined); }
  };

  const visible = useMemo(
    () => (data?.needsYou ?? []).filter((item) => teamId === "all" || item.team.id === teamId),
    [data, teamId],
  );

  if (!data && !error) return <AppPage view="Needs You" needsCount={0}><div className="state-main"><LoadingTeamPage /></div></AppPage>;
  if (!data) return <AppPage view="Needs You" needsCount={0}><div className="state-main"><section className="state-page error-state"><span className="state-icon"><Icon name="warning" size={30} /></span><h1>DayCrew needs a moment</h1><p>{error}</p><button className="primary-button" onClick={() => void refresh()}>Try again</button></section></div></AppPage>;

  return <AppPage view="Needs You" needsCount={data.needsYou.length} workspace={data.workspace} onSwitchWorkspace={onSwitchWorkspace}>
    <div className="tasks-content">
      <header className="tasks-heading">
        <div>
          <p>NEEDS YOU</p>
          <h1>Decisions waiting on you</h1>
          <span>Approvals, decisions, blockers, failures, and reviews across every Team in this Workspace.</span>
        </div>
        <nav aria-label="Needs You views"><a href="#tasks">Task board</a><a className="active" href="#needs-you" aria-current="page">Needs You{data.needsYou.length > 0 && <b>{data.needsYou.length}</b>}</a></nav>
      </header>
      {data.teams.length > 1 && <section className="task-filters needs-filters" aria-label="Needs You filters">
        <label><span>Team</span><select value={teamId} onChange={(event) => setTeamId(event.target.value)}><option value="all">All Teams</option>{data.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>
      </section>}
      <GlobalNeedsYou items={visible} {...(busyId ? { busyId } : {})} {...(actionError ? { error: actionError } : {})} onResolve={resolve} />
    </div>
  </AppPage>;
};

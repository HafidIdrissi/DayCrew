import { createContext, useContext, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";

import { connectionStore, loadHome, type ConnectionState } from "./api";
import { PixelAvatar, StatusMark, statusMeta } from "./avatar";
import { activeTaskFor } from "./skillCatalog";
import type {
  ActivityEvent,
  KnowledgeEntry,
  MemberSkill,
  MemberStatus,
  MissionIssue,
  HomeData,
  NeedsYouItem,
  Skill,
  SkillCompatibility,
  SkillRecommendation,
  Task,
  Team,
  TeamMember,
  WorkSession,
  Workspace,
} from "./types";

const failureLabel: Record<MissionIssue["failure"]["kind"], string> = {
  "engine-unavailable": "AI Engine unavailable",
  "engine-configuration": "AI Engine setup required",
  "usage-limit": "Usage limit reached",
  "command-failed": "AI Engine command failed",
  "permission-denied": "Permission denied",
  "invalid-response": "AI Engine response could not be used",
  unknown: "Mission failed",
};

/** One persisted Mission failure, rendered consistently in every operational view. */
export const MissionIssues = ({ issues, onRetry }: {
  issues: readonly MissionIssue[];
  onRetry: (issue: MissionIssue) => Promise<void>;
}) => {
  const [retrying, setRetrying] = useState<string>();
  const [retryError, setRetryError] = useState<string>();
  if (issues.length === 0) return null;
  const retry = async (issue: MissionIssue) => {
    setRetrying(issue.sessionId); setRetryError(undefined);
    try { await onRetry(issue); }
    catch (caught) { setRetryError(caught instanceof Error ? caught.message : "DayCrew could not retry this Mission."); }
    finally { setRetrying(undefined); }
  };
  return <section className="mission-issues" aria-label="Mission failures">
    {issues.map((issue) => <article className="mission-issue" role="alert" key={issue.sessionId}>
      <span className="mission-issue-icon"><Icon name="warning" size={19} /></span>
      <div>
        <small>{issue.teamName} · {failureLabel[issue.failure.kind]}</small>
        <h2>{issue.goal}</h2>
        <p>{issue.failure.message}</p>
        <strong>{issue.failure.resolution}</strong>
      </div>
      <div className="mission-issue-actions">
        {issue.failure.retryable && <button type="button" className="primary-button" disabled={retrying !== undefined} onClick={() => void retry(issue)}>{retrying === issue.sessionId ? "Retrying…" : "Retry Mission"}</button>}
        <a className="secondary-button" href="#settings">Engine settings</a>
        <a className="text-button" href={`#teams/${issue.teamId}`}>Open Mission</a>
      </div>
    </article>)}
    {retryError && <p className="inline-error" role="alert">{retryError}</p>}
  </section>;
};

type IconName =
  | "activity"
  | "arrow"
  | "bell"
  | "book"
  | "check"
  | "chevron"
  | "close"
  | "github"
  | "home"
  | "knowledge"
  | "logo"
  | "message"
  | "office"
  | "paperclip"
  | "search"
  | "send"
  | "settings"
  | "sparkle"
  | "tasks"
  | "team"
  | "warning";

export const Icon = ({ name, size = 20 }: { name: IconName; size?: number }) => {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.8 };
  const shapes: Record<Exclude<IconName, "logo">, ReactNode> = {
    activity: <><path d="M3 12h4l2-7 4 14 2-7h6" /><path d="M4 4v16h16" opacity=".25" /></>,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
    github: <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.1.68-.22.68-.48v-1.88c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.55 9.55 0 0 1 12 6.81c.85 0 1.71.12 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.78c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />,
    home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10M9 20v-6h6v6" /></>,
    knowledge: <><path d="M9 18h6" /><path d="M10 22h4" /><path d="M8.5 14.5A7 7 0 1 1 15.5 14.5c-1 .7-1.5 1.5-1.5 2.5h-4c0-1-.5-1.8-1.5-2.5Z" /></>,
    message: <><path d="M21 12a8 8 0 0 1-8 8H7l-4 2 1.2-4.3A8.5 8.5 0 1 1 21 12Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" strokeWidth="2.5" /></>,
    office: <><path d="M4 21V7l8-4v18" /><path d="M12 9h8v12M7 10h1M7 14h1M7 18h1M15 13h2M15 17h2" /></>,
    paperclip: <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 1 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9v-.1A1.7 1.7 0 0 0 7.9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2V9h.1A1.7 1.7 0 0 0 3.6 7.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2H14v.1A1.7 1.7 0 0 0 15.1 3.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8c.2.38.52.7.9.9.33.18.72.25 1.1.2h.1V14h-.1a1.7 1.7 0 0 0-2 1Z" /></>,
    sparkle: <><path d="m12 2 1.3 4.7L18 8l-4.7 1.3L12 14l-1.3-4.7L6 8l4.7-1.3Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z" /></>,
    tasks: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m7 12 3 3 7-7" /></>,
    team: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M15 14h1a5 5 0 0 1 5 5v1" /></>,
    warning: <><path d="M10.3 3.7 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  };

  if (name === "logo") {
    return (
      <svg className="icon logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <rect x="3" y="11" width="9" height="14" rx="4.5" fill="currentColor" opacity=".72" />
        <rect x="11" y="5" width="10" height="22" rx="5" fill="currentColor" />
        <rect x="20" y="8" width="9" height="16" rx="4.5" fill="currentColor" opacity=".62" />
      </svg>
    );
  }
  return <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...common}>{shapes[name]}</svg>;
};

export const Avatar = ({ member, size = "md", status, showStatus }: {
  member: TeamMember; size?: "xs" | "sm" | "md" | "lg"; status?: MemberStatus; showStatus?: boolean;
}) => <PixelAvatar member={member} size={size} {...(status ? { status } : {})} {...(showStatus ? { showStatus } : {})} />;

export const NeedsYouBadge = ({ count }: { count: number }) => (
  <GlobalNeedsYouBadge count={count} />
);
const NavigationHomeContext = createContext<HomeData | undefined>(undefined);

/** Keep the global Needs You badge and Team rail on the same Workspace snapshot. */
export const NavigationHomeProvider = ({ selectionId, children }: { selectionId: string; children: ReactNode }) => {
  const [home, setHome] = useState<HomeData>();
  useEffect(() => {
    let active = true;
    setHome(undefined);
    const refresh = () => { void loadHome(selectionId).then((next) => { if (active) setHome(next); }).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 6_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectionId]);
  return <NavigationHomeContext.Provider value={home}>{children}</NavigationHomeContext.Provider>;
};

const GlobalNeedsYouBadge = ({ count }: { count: number }) => {
  const home = useContext(NavigationHomeContext);
  const globalCount = home?.needsYou.count ?? count;
  return <a className={`needs-badge ${globalCount === 0 ? "is-clear" : ""}`} href="#needs-you" aria-label={`${globalCount} Needs You item${globalCount === 1 ? "" : "s"}`}>
    <Icon name={globalCount === 0 ? "check" : "warning"} size={17} />
    {globalCount === 0 ? "All clear" : "Needs You"}
    {globalCount > 0 && <b>{globalCount}</b>}
  </a>;
};
export const MemberAvatar = Avatar;

export const TeamTabs = ({ teamId, active }: { teamId: string; active: "Discussion" | "Tasks" | "Deliverables" | "Members" }) => <nav className="team-tabs" aria-label="Team sections">
  {(["Discussion", "Tasks", "Deliverables", "Members"] as const).map((tab) => <a key={tab} href={`#teams/${teamId}${tab === "Discussion" ? "" : `/${tab.toLowerCase()}`}`} aria-current={active === tab ? "page" : undefined}>{tab}</a>)}
</nav>;

export const TeamCard = ({ team }: { team: Team }) => <a className="recent-workspace" href={`#teams/${team.id}`}><strong>{team.name}</strong><small>{team.members.length} {team.members.length === 1 ? "Member" : "Members"} · {team.description || "Ready for your next Goal"}</small><Icon name="arrow" size={16} /></a>;

export type AppView = "Home" | "Team" | "Tasks" | "Needs You" | "Meetings" | "Office" | "Skills" | "Settings";

const navItems: { label: AppView; title: string; icon: IconName; href: string }[] = [
  { label: "Home", title: "HQ", icon: "home", href: "#home" },
  { label: "Needs You", title: "Needs You", icon: "warning", href: "#needs-you" },
  { label: "Tasks", title: "Tasks", icon: "tasks", href: "#tasks" },
  { label: "Meetings", title: "Meetings", icon: "team", href: "#meetings" },
  { label: "Skills", title: "Library", icon: "sparkle", href: "#skills" },
];

export const useConnection = (): ConnectionState =>
  useSyncExternalStore(connectionStore.subscribe, connectionStore.getSnapshot, () => "connecting" as const);

/** Reachability of the local service, stated plainly so a stale screen is never mistaken for a calm one. */
export const ConnectionStatus = () => {
  const state = useConnection();
  if (state === "online") return <span className="connection-status is-online" title="Connected to the local DayCrew service"><i />Local service</span>;
  if (state === "connecting") return <span className="connection-status is-connecting" role="status"><i />Connecting…</span>;
  return <span className="connection-status is-offline" role="alert"><i />Local service unreachable</span>;
};

export const AppSidebar = ({ needsCount, activeView = "Team" }: { needsCount: number; activeView?: AppView }) => {
  const home = useContext(NavigationHomeContext);
  const teams = home?.teams ?? [];
  const globalNeedsCount = home?.needsYou.count ?? needsCount;
  const [mobileOpen, setMobileOpen] = useState(false);
  return <aside className={`app-sidebar ${mobileOpen ? "context-open" : ""}`}>
    <a className="skip-content" href="#main-content" onClick={(event) => { event.preventDefault(); const main = document.querySelector("main"); if (main) { main.tabIndex = -1; main.focus(); } }}>Skip to content</a>
    <div className="hq-global-rail"><a className="hq-mark" href="#home" aria-label="DayCrew HQ"><Icon name="logo" size={30} /></a>
    <nav className="primary-nav" aria-label="Global navigation">
      {navItems.map((item) => (
        <a className={item.label === activeView ? "active" : ""} href={item.href} key={item.label} title={item.title} aria-label={item.title} aria-current={item.label === activeView ? "page" : undefined}>
          <Icon name={item.icon} size={22} />
          <span className="sr-only">{item.title}</span>
          {item.label === "Needs You" && globalNeedsCount > 0 && <em aria-label={`${globalNeedsCount} pending`}>{globalNeedsCount}</em>}
        </a>
      ))}
    </nav>
    <a className={`hq-rail-settings ${activeView === "Settings" ? "active" : ""}`} href="#settings" aria-label="Settings" title="Settings"><Icon name="settings" size={21} /></a></div>
    <div className="hq-context-rail" id="hq-context-menu"><div className="hq-context-heading"><strong>DayCrew</strong><small>Your teams, one Workspace</small></div>
      <nav aria-label="Team navigation" className="hq-team-nav"><div className="hq-team-heading"><span>TEAMS</span><a href="#teams" aria-label="Add team" title="Add team">+</a></div>
        {teams.length === 0 && <p className="hq-no-teams">No teams yet. <a href="#teams">Create one</a></p>}
        {teams.map((team) => <a key={team.id} href={`#teams/${team.id}`} className={window.location.hash.startsWith(`#teams/${team.id}`) ? "selected" : ""} onClick={() => setMobileOpen(false)}><span className="hq-team-avatar" aria-hidden="true">{team.name.trim().charAt(0).toUpperCase()}</span><span className="hq-team-text"><strong>{team.name}</strong><small>{team.status === "needs-you" ? "Needs You" : team.status === "working" ? "Working" : "Ready"}</small></span></a>)}
      </nav><div className="hq-context-footer"><a href="#office"><Icon name="office" size={18} />Office view</a><a href="#teams"><Icon name="team" size={18} />All Teams</a></div>
    </div>
    <button type="button" className="hq-mobile-teams" aria-expanded={mobileOpen} aria-controls="hq-context-menu" onClick={() => setMobileOpen((open) => !open)}><Icon name="team" size={18} /> Teams <Icon name="chevron" size={16} /></button>
  </aside>
};

/** One frame for every working view: same sidebar, same Workspace line, same connection truth. */
export const AppPage = ({ view, needsCount, workspace, onSwitchWorkspace, actions, children }: {
  view: AppView;
  needsCount: number;
  workspace?: Workspace;
  onSwitchWorkspace?: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <div className="app-frame">
    <AppSidebar needsCount={needsCount} activeView={view} />
    <main className="app-main">
      <header className="top-bar">
        {workspace && onSwitchWorkspace
          ? <WorkspaceSwitcher workspace={workspace} onSwitch={onSwitchWorkspace} />
          : <span className="workspace-switcher is-static">No Workspace open</span>}
        <div className="top-actions">{actions}<ConnectionStatus /><NeedsYouBadge count={needsCount} /></div>
      </header>
      {children}
    </main>
  </div>
);

export const WorkspaceSwitcher = ({ workspace, onSwitch }: { workspace: Workspace; onSwitch: () => void }) => (
  <button className="workspace-switcher" type="button" onClick={onSwitch} aria-label={`Current workspace: ${workspace.name}`}>
    <span className="workspace-grid" aria-hidden="true">••<br />••</span>
    <strong>{workspace.name}</strong>
    <Icon name="chevron" size={16} />
  </button>
);

export const TopBar = ({ workspace, query, needsCount, onQueryChange, onSwitchWorkspace }: { workspace: Workspace; query: string; needsCount: number; onQueryChange: (value: string) => void; onSwitchWorkspace: () => void }) => (
  <header className="top-bar">
    <WorkspaceSwitcher workspace={workspace} onSwitch={onSwitchWorkspace} />
    <div className="top-actions">
      <label className="search-box">
        <Icon name="search" size={19} />
        <span className="sr-only">Search this team</span>
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search this team..." />
      </label>
      <ConnectionStatus />
      <NeedsYouBadge count={needsCount} />
    </div>
  </header>
);

export const TeamHeader =({ team, activeCount, needsCount, onOpenSkills }: { team: Team; activeCount: number; needsCount: number; onOpenSkills: () => void }) => (
  <section className="team-header">
    <div className="team-title-wrap">
      <span className="team-icon"><Icon name="team" size={28} /></span>
      <div><h1>{team.name}</h1><p>{team.description || "Your AI crew, coordinated around shared work."}</p></div>
    </div>
    <div className="team-header-actions">
      <span className="working-pill"><i />{activeCount} working</span>
      <NeedsYouBadge count={needsCount} />
      <button className="secondary-button skill-library-button" type="button" onClick={onOpenSkills}><Icon name="sparkle" size={17} /> Skills</button>
    </div>
  </section>
);

const summaryItems = (
  team: Team,
  sessions: WorkSession[],
  tasks: Task[],
  knowledge: KnowledgeEntry[],
  needsYou: NeedsYouItem[],
) => [
  { icon: "team" as const, value: String(team.members.length), label: "Team members", tone: "blue" },
  { icon: "tasks" as const, value: String(tasks.filter((task) => task.status !== "done").length), label: "Open tasks", tone: "violet" },
  { icon: "knowledge" as const, value: String(knowledge.length), label: "Knowledge items", tone: "amber" },
  { icon: "activity" as const, value: String(sessions.filter((session) => ["planning", "working", "review"].includes(session.status)).length), label: "Active sessions", tone: "green" },
  { icon: "warning" as const, value: String(needsYou.length), label: "Need attention", tone: needsYou.length ? "red" : "green" },
];

export const TeamSummary = (props: { team: Team; sessions: WorkSession[]; tasks: Task[]; knowledge: KnowledgeEntry[]; needsYou: NeedsYouItem[] }) => (
  <section className="team-summary" aria-label="Team summary">
    {summaryItems(props.team, props.sessions, props.tasks, props.knowledge, props.needsYou).map((item) => (
      <article className="summary-card" key={item.label}>
        <span className={`summary-icon tone-${item.tone}`}><Icon name={item.icon} size={19} /></span>
        <div><strong>{item.value}</strong><small>{item.label}</small></div>
      </article>
    ))}
  </section>
);

export const MemberStatusBadge = ({ status }: { status: MemberStatus }) => {
  const meta = statusMeta[status];
  // Shape plus label: colour alone never carries the state.
  return <span className={`member-status status-${meta.tone}`}><StatusMark status={status} />{meta.label}</span>;
};

export const EngineBadge = ({ member }: { member: TeamMember }) => {
  const label = member.engine.mode === "auto"
    ? "Auto engine"
    : member.engine.provider === "demo" ? "Demo Mode" : [member.engine.provider, member.engine.model].filter(Boolean).join(" · ");
  return <span className="engine-badge" title="AI Engine"><span>AI</span>{label}</span>;
};

export const SkillChip = ({ skill }: { skill: Skill }) => <span className="skill-chip">{skill.name}</span>;

export const ManagerComposer = ({ team, session, isSubmitting, error, onSubmit }: { team: Team; session?: WorkSession; isSubmitting: boolean; error?: string; onSubmit: (goal: string) => Promise<void> }) => {
  const manager = team.members.find((member) => member.isManager);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const goal = String(form.get("goal") ?? "").trim();
    if (!goal) return;
    void onSubmit(goal).then(() => formElement.reset());
  };
  if (!manager) return null;
  return (
    <section className="manager-composer card-surface">
      <div className="card-heading-row">
        <div className="heading-with-icon"><span className="round-icon"><Icon name="message" size={19} /></span><div><h2>Ask your Manager</h2><p>Share a goal, ask for an update, or coordinate the crew.</p></div></div>
        {session && <span className={`session-state session-${session.status}`}>{session.status.replaceAll("-", " ")}</span>}
      </div>
      {session ? (
        <div className="conversation-preview">
          <div className="conversation-line user-line"><span className="user-avatar mini">JD</span><div><b>You</b><small>{formatRelativeTime(session.startedAt)}</small><p>{session.goal}</p></div></div>
          <div className="conversation-line manager-line"><Avatar member={manager} size="sm" /><div><b>{manager.name}</b><small>Latest update</small><p>{session.status === "failed" ? sessionMessage(session) : session.summary ?? session.pausedReason ?? sessionMessage(session)}</p></div></div>
        </div>
      ) : <div className="composer-welcome"><Avatar member={manager} size="sm" /><p><strong>Your team is ready.</strong> Give your Manager a goal to get started.</p></div>}
      <form className="composer-form" onSubmit={submit}>
        <span className="attach-button" aria-hidden="true"><Icon name="paperclip" size={19} /></span>
        <input name="goal" aria-label={`Message ${manager.name}`} placeholder={`Message ${manager.name}...`} disabled={isSubmitting} />
        <button className="send-button" type="submit" disabled={isSubmitting} aria-label="Send goal"><Icon name="send" size={18} /></button>
      </form>
      {error && <p className="inline-error"><Icon name="warning" size={15} />{error}</p>}
    </section>
  );
};

const sessionMessage = (session: WorkSession): string => {
  if (session.status === "completed") return "The work session is complete. Review the task handoffs below.";
  if (session.status === "failed") return "The session stopped after an error. Check Needs You and recent activity.";
  if (session.status === "waiting-for-human" || session.status === "waiting-for-you") return "The crew is waiting for your input before continuing.";
  return "I’m coordinating the team and will keep this page updated as work progresses.";
};

export const ManagerCard = ({ member, status, skills, knowledgeCount, onAddSkill }: { member: TeamMember; status: MemberStatus; skills: Skill[]; knowledgeCount: number; onAddSkill: () => void }) => (
  <article className="manager-card card-surface">
    <div className="manager-profile">
      <Avatar member={member} size="lg" status={status} showStatus />
      <div className="member-identity"><p className="member-kicker">Team Manager</p><h3>{member.name}</h3><p>{member.role}</p><MemberStatusBadge status={status} /></div>
    </div>
    <div className="manager-meta">
      <div><span>Knowledge</span><strong><Icon name="book" size={17} />{knowledgeCount} shared items</strong></div>
      <div><span>AI Engine</span><EngineBadge member={member} /></div>
    </div>
    <div className="skill-row">{skills.map((skill) => <SkillChip skill={skill} key={skill.id} />)}<button className="add-skill-link" type="button" onClick={onAddSkill}>+ Add skill</button></div>
  </article>
);

export const MemberCard = ({ member, status, skills, currentTask, onAddSkill }: { member: TeamMember; status: MemberStatus; skills: Skill[]; currentTask?: Task; onAddSkill: () => void }) => (
  <article className="member-card card-surface">
    <div className="member-card-top"><Avatar member={member} status={status} showStatus /><div className="member-identity"><h3>{member.name}</h3><p>{member.role}</p><MemberStatusBadge status={status} /></div></div>
    <div className="current-work"><span>Current work</span><p>{currentTask?.title ?? "Available for the next task"}</p></div>
    <div className="skill-row compact">{skills.slice(0, 3).map((skill) => <SkillChip skill={skill} key={skill.id} />)}{skills.length === 0 && <span className="no-skills">No skills attached</span>}</div>
    <div className="member-card-footer"><EngineBadge member={member} /><button className="add-skill-link" type="button" onClick={onAddSkill}>+ Add skill</button></div>
  </article>
);

export const HandoffTimeline = ({ tasks, members }: { tasks: Task[]; members: TeamMember[] }) => {
  const byId = new Map(members.map((member) => [member.id, member]));
  const visible = [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5);
  return (
    <section className="content-section task-section">
      <div className="section-heading"><div><span className="round-icon"><Icon name="tasks" size={18} /></span><h2>Task handoff</h2></div><span>{tasks.length} total</span></div>
      {visible.length ? <div className="task-strip">{visible.map((task) => {
        const owner = task.ownerId ? byId.get(task.ownerId) : undefined;
        return <article className="task-card card-surface" key={task.id}>
          <div className="task-card-head"><span className={`task-status task-${task.status}`}>{task.status.replace("-", " ")}</span>{task.needsYou && <Icon name="warning" size={16} />}</div>
          <h3>{task.title}</h3>
          <div className="task-owner">{owner ? <><Avatar member={owner} size="sm" /><span>{owner.name}</span></> : <span>Unassigned</span>}</div>
          {task.handoffs.at(-1) ? <p className="handoff-note"><Icon name="arrow" size={14} />{task.handoffs.at(-1)?.note || "Handed off"}</p> : <time dateTime={task.updatedAt}>{formatRelativeTime(task.updatedAt)}</time>}
        </article>;
      })}</div> : <div className="quiet-empty"><Icon name="tasks" size={22} /><p><strong>No tasks yet.</strong> Give your Manager a goal to start the first handoff.</p></div>}
    </section>
  );
};

const readableStatus = (status: unknown): string => ({
  "blocked-on-approval": "waiting for approval",
  "waiting-for-human": "waiting for your input",
  "waiting-for-you": "waiting for your input",
  "in-progress": "in progress",
  created: "getting ready",
  planning: "planning",
  working: "working",
  thinking: "thinking",
  idle: "idle",
  waiting: "waiting",
  paused: "paused",
  review: "in review",
  completed: "complete",
  done: "complete",
  failed: "stopped after an error",
  stopped: "stopped",
  cancelled: "cancelled",
  todo: "ready to start",
}[String(status)] ?? "updated");

const activityCategory = (kind: string): string => ({
  "member.status_changed": "Team member",
  "session.status_changed": "Work session",
  "approval.requested": "Approval",
  "approval.resolved": "Approval",
  "approval.decided": "Approval",
  "approval.action_outcome": "Approval",
  "needs_you.created": "Needs You",
  "needs_you.resolved": "Needs You",
  "task.created": "Task",
  "task.updated": "Task",
  "task.handed_off": "Task handoff",
  "message.sent": "Team update",
  "member.resumed": "Team member",
  "member.tool_used": "Team member",
  "member.text": "Team member",
  "usage.updated": "AI Engine",
  "session.completed": "Work session",
  "session.failed": "Work session",
}[kind] ?? "Team activity");

const activitySummary = (event: ActivityEvent, members: ReadonlyMap<string, TeamMember>): string => {
  const memberId = typeof event.data["memberId"] === "string" ? event.data["memberId"] : undefined;
  const member = memberId ? members.get(memberId) : undefined;
  if (event.kind === "member.status_changed") {
    return `${member?.name ?? "A Team Member"} is ${readableStatus(event.data["status"])}`;
  }
  if (event.kind === "session.status_changed") return `Work session is ${readableStatus(event.data["to"])}`;
  if (event.kind === "task.updated") return event.summary.replace(/ to [a-z-]+$/i, ` — ${readableStatus(event.data["status"])}`);
  if (event.kind === "task.handed_off") {
    const ownerId = typeof event.data["ownerId"] === "string" ? event.data["ownerId"] : undefined;
    return event.summary.replace(/ to [^ ]+$/i, ` to ${ownerId ? members.get(ownerId)?.name ?? "a Team Member" : "a Team Member"}`);
  }
  if (event.kind === "message.sent") {
    const fromId = typeof event.data["fromMemberId"] === "string" ? event.data["fromMemberId"] : undefined;
    const toId = typeof event.data["toMemberId"] === "string" ? event.data["toMemberId"] : undefined;
    const subject = event.summary.match(/ sent (.+) to [^ ]+$/i)?.[1] ?? "an update";
    return `${fromId ? members.get(fromId)?.name ?? "A Team Member" : "A Team Member"} sent “${subject}” to ${toId ? members.get(toId)?.name ?? "a Team Member" : "a Team Member"}`;
  }
  if (event.kind === "approval.decided") {
    const decision = event.data["status"] === "approved" ? "approved" : event.data["status"] === "denied" ? "denied" : "resolved";
    return `You ${decision} the requested action.`;
  }
  if (event.kind === "approval.action_outcome") return "The approved action completed.";
  if (event.kind === "member.resumed") return `${member?.name ?? "A Team Member"} resumed after your decision.`;
  if (event.kind === "member.tool_used") return `${member?.name ?? "A Team Member"} received the approved result.`;
  if (event.kind === "session.failed") return "The work session stopped after an error.";
  return event.summary;
};

export const ActivityFeed = ({ activity, members }: { activity: ActivityEvent[]; members: TeamMember[] }) => {
  const byId = new Map(members.map((member) => [member.id, member]));
  const visible = [...activity].sort((a, b) => b.sequence - a.sequence).slice(0, 7);
  return (
    <section className="activity-card card-surface">
      <div className="section-heading"><div><span className="round-icon"><Icon name="activity" size={18} /></span><h2>Recent activity</h2></div><span>Live history</span></div>
      {visible.length ? <div className="activity-list">{visible.map((event) => {
        const memberId = typeof event.data["memberId"] === "string" ? event.data["memberId"] : undefined;
        const member = memberId ? byId.get(memberId) : undefined;
        return <article key={event.id}>{member ? <Avatar member={member} size="sm" /> : <span className={`event-icon event-${event.kind.split(".")[0]}`}><Icon name={event.kind.includes("approval") || event.kind.includes("needs_you") ? "warning" : "activity"} size={15} /></span>}<div><p>{activitySummary(event, byId)}</p><small>{activityCategory(event.kind)}</small></div><time dateTime={event.timestamp}>{formatRelativeTime(event.timestamp)}</time></article>;
      })}</div> : <div className="quiet-empty small"><p>Activity will appear as the crew begins work.</p></div>}
    </section>
  );
};

export const SkillDrawer = ({ open, team, member, tasks, library, assignments, availability, recommendations, onClose, onMemberChange, onAttach, onRemove }: {
  open: boolean; team: Team; member: TeamMember; tasks: Task[]; library: Skill[]; assignments: MemberSkill[];
  availability: { skill: Skill; compatibility: SkillCompatibility }[]; recommendations: SkillRecommendation[];
  onClose: () => void; onMemberChange: (memberId: string) => void;
  onAttach: (scope: "task" | "member", skillId: string, taskId?: string) => Promise<void>;
  onRemove: (assignment: MemberSkill) => Promise<void>;
}) => {
  const [selectedId, setSelectedId] = useState(library[0]?.id ?? "");
  const [scope, setScope] = useState<"task" | "member">("task");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recommendationDismissed, setRecommendationDismissed] = useState(false);
  const recommended = recommendations[0];
  useEffect(() => {
    setSelectedId(recommended?.skill.id ?? library[0]?.id ?? "");
    setRecommendationDismissed(false);
    setError(undefined);
  }, [member.id, recommended?.skill.id, library]);
  const selected = library.find((skill) => skill.id === selectedId) ?? library[0];
  const activeTask = activeTaskFor(tasks, member.id);
  const compatibility = selected ? availability.find((item) => item.skill.id === selected.id)?.compatibility : undefined;
  const existing = selected ? assignments.some((item) => item.skill.id === selected.id && item.scope === (scope === "member" ? "permanent" : "temporary") && (scope === "member" || item.taskId === activeTask?.id)) : false;
  if (!open) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : "DayCrew could not update this Skill."); }
    finally { setBusy(false); }
  };
  const attach = () => selected && run(() => onAttach(scope, selected.id, activeTask?.id));
  return (
    <aside className="skill-drawer" aria-label="Skills Library">
      <div className="drawer-header"><div><span className="drawer-title-icon"><Icon name="sparkle" size={21} /></span><div><h2>Skills Library</h2><p>Add focused know-how to a teammate.</p></div></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close Skills Library"><Icon name="close" size={19} /></button></div>
      <label className="drawer-field">Team member<select value={member.id} onChange={(event) => onMemberChange(event.target.value)}>{team.members.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.role}</option>)}</select></label>
      {recommended && !recommendationDismissed && <section className="recommended-skill"><p className="drawer-eyebrow"><Icon name="sparkle" size={14} />Recommended for {member.name}</p><h3>{recommended.skill.name}</h3><p>{recommended.reason}</p>{!recommended.compatibility.compatible && <p className="skill-incompatible">{recommended.compatibility.reason}</p>}<div className="recommendation-actions"><button type="button" disabled={busy || !activeTask || !recommended.compatibility.compatible} onClick={() => void run(() => onAttach("task", recommended.skill.id, activeTask?.id))}>Add for this task</button><button type="button" disabled={busy || !recommended.compatibility.compatible} onClick={() => void run(() => onAttach("member", recommended.skill.id))}>Keep for this Team</button><button type="button" onClick={() => setRecommendationDismissed(true)}>Not now</button></div></section>}
      {assignments.length > 0 && <section className="attached-skills"><p className="drawer-eyebrow">Skills on {member.name}</p>{assignments.map((assignment) => <div key={`${assignment.scope}-${assignment.taskId ?? "team"}-${assignment.skill.id}`}><span><strong>{assignment.skill.name}</strong><small>{assignment.scope === "permanent" ? "Permanent" : `Temporary · ${tasks.find((task) => task.id === assignment.taskId)?.title ?? assignment.taskId}`}</small></span><button type="button" disabled={busy} onClick={() => void run(() => onRemove(assignment))} aria-label={`Remove ${assignment.skill.name}`}>Remove</button>{!assignment.compatibility.compatible && <p className="skill-incompatible">{assignment.compatibility.reason} {assignment.compatibility.resolution}</p>}</div>)}</section>}
      <div className="skills-list" role="listbox" aria-label="Available skills">{library.map((skill) => <button type="button" role="option" aria-selected={skill.id === selected?.id} className={skill.id === selected?.id ? "selected" : ""} onClick={() => setSelectedId(skill.id)} key={skill.id}><span className="skill-list-icon"><Icon name="knowledge" size={17} /></span><span><strong>{skill.name}</strong><small>{skill.description}</small></span>{skill.id === selected?.id && <span className="selected-check"><Icon name="check" size={14} /></span>}</button>)}</div>
      {selected && <section className="skill-attach-panel">
        <div className="selected-skill-summary"><span className="skill-list-icon"><Icon name="knowledge" size={18} /></span><div><small>Selected skill</small><strong>{selected.name}</strong></div></div>
        <div className="scope-choice"><button className={scope === "task" ? "active" : ""} type="button" onClick={() => setScope("task")} disabled={!activeTask}><strong>For this task</strong><span>{activeTask?.title ?? "No active task"}</span></button><button className={scope === "member" ? "active" : ""} type="button" onClick={() => setScope("member")}><strong>Keep for this Team</strong><span>Permanent for this teammate</span></button></div>
        {compatibility && !compatibility.compatible && <div className="permission-note incompatible"><Icon name="warning" size={17} /><p><strong>Capabilities unavailable.</strong> {compatibility.reason} {compatibility.resolution}</p></div>}
        <div className="permission-note"><Icon name="warning" size={17} /><p><strong>Permissions stay in control.</strong> A skill adds know-how, not tool access. DayCrew’s <b>{team.autonomy.replaceAll("-", " ")}</b> policy still applies.</p></div>
        {error && <p className="inline-error"><Icon name="warning" size={15} />{error}</p>}
        <button className="primary-button" type="button" onClick={attach} disabled={busy || existing || compatibility?.compatible === false || (scope === "task" && !activeTask)}>{existing ? "Already added" : scope === "task" ? "Add for this task" : "Keep for this Team"}</button>
      </section>}
      <a className="drawer-contribute" href="https://github.com/daycrew/daycrew/blob/main/docs/SKILLS.md"><Icon name="github" size={22} /><div><strong>Build a skill for DayCrew</strong><p>Open the contributor guide.</p></div><Icon name="arrow" size={17} /></a>
    </aside>
  );
};

export const LoadingTeamPage = () => <div className="state-page" aria-live="polite"><span className="loading-orbit"><i /><i /><i /></span><h1>Gathering your crew…</h1><p>Loading the latest team, work, approvals, and activity.</p></div>;

export const EmptyTeamPage = () => <div className="state-page"><span className="state-icon"><Icon name="team" size={30} /></span><h1>Your Workspace is ready.</h1><p>Create your first AI Team.</p><a className="primary-button" href="#teams">Create Team</a></div>;

export const ErrorTeamPage = ({ message, onRetry }: { message: string; onRetry: () => void }) => <div className="state-page error-state"><span className="state-icon"><Icon name="warning" size={30} /></span><h1>DayCrew needs a moment</h1><p>{message}</p><button className="primary-button" type="button" onClick={onRetry}>Try again</button></div>;

export const formatRelativeTime = (timestamp: string): string => {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export const StateFrame = ({ children, activeView = "Home" }: { children: ReactNode; activeView?: AppView }) =>
  <div className="app-frame"><AppSidebar needsCount={0} activeView={activeView} /><main className="app-main state-main">{children}</main></div>;

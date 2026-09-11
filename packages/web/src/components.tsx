import { useState, type FormEvent, type ReactNode } from "react";

import {
  PREVIEW_SKILL_CATALOG,
  activeTaskFor,
  recommendedSkillFor,
  type SkillAttachment,
  type SkillDefinition,
} from "./skillCatalog";
import type {
  ActivityEvent,
  KnowledgeEntry,
  MemberStatus,
  NeedsYouItem,
  Task,
  Team,
  TeamMember,
  WorkSession,
  Workspace,
} from "./types";

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

const initials = (name: string): string =>
  name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

export const Avatar = ({ member, size = "md" }: { member: TeamMember; size?: "sm" | "md" | "lg" }) => (
  <span className={`avatar avatar-${size}`} data-seed={member.id.length % 4} title={member.name}>
    {initials(member.name)}
  </span>
);

export const NeedsYouBadge = ({ count }: { count: number }) => (
  <span className={`needs-badge ${count === 0 ? "is-clear" : ""}`}>
    <Icon name={count === 0 ? "check" : "warning"} size={17} />
    {count === 0 ? "All clear" : "Needs You"}
    {count > 0 && <b>{count}</b>}
  </span>
);

export const AppSidebar = ({ needsCount }: { needsCount: number }) => {
  const navItems: { label: string; icon: IconName }[] = [
    { label: "Home", icon: "home" },
    { label: "Teams", icon: "team" },
    { label: "Tasks", icon: "tasks" },
    { label: "Office", icon: "office" },
    { label: "Settings", icon: "settings" },
  ];
  return (
    <aside className="app-sidebar">
      <div className="brand-block">
        <a className="brand" href="#teams" aria-label="DayCrew Teams">
          <Icon name="logo" size={34} />
          <span>DayCrew</span>
        </a>
        <p>AI workers for<br />a brighter tomorrow.</p>
      </div>
      <nav className="primary-nav" aria-label="Primary navigation">
        {navItems.map((item) => (
          <a className={item.label === "Teams" ? "active" : ""} href={`#${item.label.toLowerCase()}`} key={item.label}>
            <Icon name={item.icon} size={21} />
            <span>{item.label}</span>
            {item.label === "Tasks" && needsCount > 0 && <em>{needsCount}</em>}
          </a>
        ))}
      </nav>
      <div className="contribute-card">
        <Icon name="github" size={26} />
        <strong>Open source,<br />stronger together.</strong>
        <p>Join our community and help shape DayCrew.</p>
        <a href="#contribute">Contribute on GitHub <Icon name="arrow" size={15} /></a>
      </div>
    </aside>
  );
};

export const WorkspaceSwitcher = ({ workspace, onSwitch }: { workspace: Workspace; onSwitch: () => void }) => (
  <button className="workspace-switcher" type="button" onClick={onSwitch} aria-label={`Current workspace: ${workspace.name}`}>
    <span className="workspace-grid" aria-hidden="true">••<br />••</span>
    <strong>{workspace.name}</strong>
    <Icon name="chevron" size={16} />
  </button>
);

export const TopBar = ({ workspace, query, onQueryChange, onSwitchWorkspace }: { workspace: Workspace; query: string; onQueryChange: (value: string) => void; onSwitchWorkspace: () => void }) => (
  <header className="top-bar">
    <WorkspaceSwitcher workspace={workspace} onSwitch={onSwitchWorkspace} />
    <div className="top-actions">
      <label className="search-box">
        <Icon name="search" size={19} />
        <span className="sr-only">Search this team</span>
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search this team..." />
      </label>
      <button className="icon-button notification-button" type="button" aria-label="Notifications">
        <Icon name="bell" size={21} /><span />
      </button>
      <span className="user-avatar" aria-label="Local user">JD</span>
    </div>
  </header>
);

export const TeamHeader = ({ team, activeCount, needsCount, onOpenSkills }: { team: Team; activeCount: number; needsCount: number; onOpenSkills: () => void }) => (
  <section className="team-header">
    <div className="team-title-wrap">
      <span className="team-icon"><Icon name="team" size={28} /></span>
      <div><h1>{team.name}</h1><p>{team.description || "Your AI crew, coordinated around shared work."}</p></div>
    </div>
    <div className="team-header-actions">
      <span className="working-pill"><i />{activeCount} working</span>
      <NeedsYouBadge count={needsCount} />
      <button className="secondary-button skill-library-button" type="button" onClick={onOpenSkills}><Icon name="sparkle" size={17} /> Skills</button>
      <button className="icon-button" type="button" aria-label="More team actions">•••</button>
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

const statusMeta: Record<MemberStatus, { label: string; tone: string }> = {
  idle: { label: "Idle", tone: "muted" },
  thinking: { label: "Thinking", tone: "violet" },
  working: { label: "Working", tone: "green" },
  waiting: { label: "Waiting", tone: "amber" },
  "blocked-on-approval": { label: "Waiting for approval", tone: "red" },
  paused: { label: "Paused", tone: "amber" },
  completed: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  stopped: { label: "Stopped", tone: "muted" },
};

export const MemberStatusBadge = ({ status }: { status: MemberStatus }) => {
  const meta = statusMeta[status];
  return <span className={`member-status status-${meta.tone}`}><i />{meta.label}</span>;
};

export const EngineBadge = ({ member }: { member: TeamMember }) => {
  const label = member.engine.mode === "auto"
    ? "Auto engine"
    : [member.engine.provider, member.engine.model].filter(Boolean).join(" · ");
  return <span className="engine-badge" title="AI Engine"><span>AI</span>{label}</span>;
};

export const SkillChip = ({ skill }: { skill: SkillDefinition }) => <span className="skill-chip">{skill.name}</span>;

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
          <div className="conversation-line manager-line"><Avatar member={manager} size="sm" /><div><b>{manager.name}</b><small>Latest update</small><p>{session.summary ?? session.pausedReason ?? sessionMessage(session)}</p></div></div>
        </div>
      ) : <div className="composer-welcome"><Avatar member={manager} size="sm" /><p><strong>Your team is ready.</strong> Give your Manager a goal to get started.</p></div>}
      <form className="composer-form" onSubmit={submit}>
        <button className="attach-button" type="button" aria-label="Attach context"><Icon name="paperclip" size={19} /></button>
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

export const ManagerCard = ({ member, status, skills, knowledgeCount, onAddSkill }: { member: TeamMember; status: MemberStatus; skills: SkillDefinition[]; knowledgeCount: number; onAddSkill: () => void }) => (
  <article className="manager-card card-surface">
    <div className="manager-profile">
      <Avatar member={member} size="lg" />
      <div className="member-identity"><p className="member-kicker">Team Manager</p><h3>{member.name}</h3><p>{member.role}</p><MemberStatusBadge status={status} /></div>
    </div>
    <div className="manager-meta">
      <div><span>Knowledge</span><strong><Icon name="book" size={17} />{knowledgeCount} shared items</strong></div>
      <div><span>AI Engine</span><EngineBadge member={member} /></div>
    </div>
    <div className="skill-row">{skills.map((skill) => <SkillChip skill={skill} key={skill.id} />)}<button className="add-skill-link" type="button" onClick={onAddSkill}>+ Add skill</button></div>
  </article>
);

export const MemberCard = ({ member, status, skills, currentTask, onAddSkill }: { member: TeamMember; status: MemberStatus; skills: SkillDefinition[]; currentTask?: Task; onAddSkill: () => void }) => (
  <article className="member-card card-surface">
    <div className="member-card-top"><Avatar member={member} /><div className="member-identity"><h3>{member.name}</h3><p>{member.role}</p><MemberStatusBadge status={status} /></div></div>
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

export const ActivityFeed = ({ activity, members }: { activity: ActivityEvent[]; members: TeamMember[] }) => {
  const byId = new Map(members.map((member) => [member.id, member]));
  const visible = [...activity].sort((a, b) => b.sequence - a.sequence).slice(0, 7);
  return (
    <section className="activity-card card-surface">
      <div className="section-heading"><div><span className="round-icon"><Icon name="activity" size={18} /></span><h2>Recent activity</h2></div><span>Live history</span></div>
      {visible.length ? <div className="activity-list">{visible.map((event) => {
        const memberId = typeof event.data["memberId"] === "string" ? event.data["memberId"] : undefined;
        const member = memberId ? byId.get(memberId) : undefined;
        return <article key={event.id}>{member ? <Avatar member={member} size="sm" /> : <span className={`event-icon event-${event.kind.split(".")[0]}`}><Icon name={event.kind.includes("approval") || event.kind.includes("needs_you") ? "warning" : "activity"} size={15} /></span>}<div><p>{event.summary}</p><small>{event.kind.replaceAll(".", " · ")}</small></div><time dateTime={event.timestamp}>{formatRelativeTime(event.timestamp)}</time></article>;
      })}</div> : <div className="quiet-empty small"><p>Activity will appear as the crew begins work.</p></div>}
    </section>
  );
};

export const SkillDrawer = ({ open, team, member, tasks, attachments, onClose, onMemberChange, onAttach }: { open: boolean; team: Team; member: TeamMember; tasks: Task[]; attachments: SkillAttachment[]; onClose: () => void; onMemberChange: (memberId: string) => void; onAttach: (attachment: SkillAttachment) => void }) => {
  const [selectedId, setSelectedId] = useState(recommendedSkillFor(member).id);
  const [scope, setScope] = useState<"task" | "member">("task");
  const selected = PREVIEW_SKILL_CATALOG.find((skill) => skill.id === selectedId) ?? PREVIEW_SKILL_CATALOG[0]!;
  const activeTask = activeTaskFor(tasks, member.id);
  const existing = attachments.some((item) => item.memberId === member.id && item.skillId === selected.id && item.scope === scope && (scope === "member" || item.taskId === activeTask?.id));

  if (!open) return null;
  const attach = () => onAttach({ memberId: member.id, skillId: selected.id, scope, ...(scope === "task" && activeTask ? { taskId: activeTask.id } : {}) });
  return (
    <aside className="skill-drawer" aria-label="Skills Library">
      <div className="drawer-header"><div><span className="drawer-title-icon"><Icon name="sparkle" size={21} /></span><div><h2>Skills Library</h2><p>Add focused know-how to a teammate.</p></div></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close Skills Library"><Icon name="close" size={19} /></button></div>
      <div className="preview-notice"><span>Preview catalog</span><p>Skill persistence is local until the DayCrew Skills API lands.</p></div>
      <label className="drawer-field">Team member<select value={member.id} onChange={(event) => onMemberChange(event.target.value)}>{team.members.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.role}</option>)}</select></label>
      <section className="recommended-skill"><p className="drawer-eyebrow"><Icon name="sparkle" size={14} />Recommended for {member.name}</p><h3>{recommendedSkillFor(member).name}</h3><p>{recommendedSkillFor(member).description}</p><button type="button" onClick={() => setSelectedId(recommendedSkillFor(member).id)}>Select recommendation <Icon name="arrow" size={15} /></button></section>
      <div className="skills-list" role="listbox" aria-label="Available skills">{PREVIEW_SKILL_CATALOG.map((skill) => <button type="button" role="option" aria-selected={skill.id === selected.id} className={skill.id === selected.id ? "selected" : ""} onClick={() => setSelectedId(skill.id)} key={skill.id}><span className="skill-list-icon"><Icon name="knowledge" size={17} /></span><span><strong>{skill.name}</strong><small>{skill.description}</small></span>{skill.id === selected.id && <span className="selected-check"><Icon name="check" size={14} /></span>}</button>)}</div>
      <section className="skill-attach-panel">
        <div className="selected-skill-summary"><span className="skill-list-icon"><Icon name="knowledge" size={18} /></span><div><small>Selected skill</small><strong>{selected.name}</strong></div></div>
        <div className="scope-choice"><button className={scope === "task" ? "active" : ""} type="button" onClick={() => setScope("task")} disabled={!activeTask}><strong>For this task</strong><span>{activeTask?.title ?? "No active task"}</span></button><button className={scope === "member" ? "active" : ""} type="button" onClick={() => setScope("member")}><strong>Keep for this teammate</strong><span>Available on future work</span></button></div>
        <div className="permission-note"><Icon name="warning" size={17} /><p><strong>Permissions stay in control.</strong> A skill adds know-how, not tool access. DayCrew’s <b>{team.autonomy.replaceAll("-", " ")}</b> policy still applies.</p></div>
        <button className="primary-button" type="button" onClick={attach} disabled={existing || (scope === "task" && !activeTask)}>{existing ? "Already added" : scope === "task" ? "Add for this task" : "Keep for this teammate"}</button>
      </section>
      <div className="drawer-contribute"><Icon name="github" size={22} /><div><strong>Build a skill for DayCrew</strong><p>Contribute reusable know-how to the open-source catalog.</p></div><button type="button" aria-label="View contribution guide"><Icon name="arrow" size={17} /></button></div>
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

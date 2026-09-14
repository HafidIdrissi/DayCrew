import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, addPermanentSkill, listSkills, loadTeamDashboard, removePermanentSkill } from "./api";
import { AppPage, Avatar, Icon, LoadingTeamPage } from "./components";
import type { Skill, TeamDashboardData } from "./types";

const isDashboard = (value: unknown): value is TeamDashboardData =>
  typeof value === "object" && value !== null && "team" in value && !("kind" in value);

/** A Skill carries instructions, never access. The page says so where the assignment happens. */
const SkillDetail = ({ skill }: { skill: Skill }) => (
  <div className="skill-detail-facts">
    <p>{skill.description}</p>
    <dl>
      <div><dt>Version</dt><dd>{skill.version}</dd></div>
      <div><dt>Source</dt><dd>{skill.source.reference ?? skill.source.type}</dd></div>
      {skill.author && <div><dt>Author</dt><dd>{skill.author}</dd></div>}
      <div><dt>Compatible roles</dt><dd>{skill.compatibleRoles.length ? skill.compatibleRoles.join(", ") : "Any role"}</dd></div>
      <div><dt>Required capabilities</dt><dd>{skill.requiredCapabilities.length ? skill.requiredCapabilities.join(", ") : "None"}</dd></div>
      {skill.recommendedTools.length > 0 && <div><dt>Recommended tools</dt><dd>{skill.recommendedTools.join(", ")}</dd></div>}
    </dl>
    {skill.tags.length > 0 && <div className="skill-tag-row">{skill.tags.map((tag) => <span className="skill-chip" key={tag}>{tag}</span>)}</div>}
  </div>
);

export const SkillsPage = ({ selectionId, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string;
  onSwitchWorkspace: () => void;
  onWorkspaceIssue: () => void;
}) => {
  const [library, setLibrary] = useState<Skill[]>();
  const [dashboard, setDashboard] = useState<TeamDashboardData | null>();
  const [teamId, setTeamId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async (requestedTeamId?: string) => {
    const request = ++generation.current;
    setError(undefined);
    try {
      const [skills, board] = await Promise.all([
        listSkills(selectionId),
        loadTeamDashboard(requestedTeamId, selectionId),
      ]);
      if (request !== generation.current) return;
      setLibrary(skills);
      if (board !== null && "kind" in board) { onWorkspaceIssue(); return; }
      setDashboard(board);
      if (isDashboard(board)) setTeamId(board.team.id);
    } catch (caught) {
      if (request !== generation.current) return;
      if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError(caught instanceof Error ? caught.message : "DayCrew could not load Skills.");
    }
  }, [selectionId, onWorkspaceIssue]);

  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [refresh]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (library ?? []).filter((skill) => !needle ||
      `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase().includes(needle));
  }, [library, query]);

  const selected = visible.find((skill) => skill.id === selectedId) ?? visible[0];
  const board = isDashboard(dashboard) ? dashboard : undefined;
  const needsCount = board?.needsYou.length ?? 0;

  const assign = async (memberId: string, skillId: string, attached: boolean) => {
    if (!board) return;
    setBusy(true); setActionError(undefined);
    try {
      if (attached) await removePermanentSkill(board.team.id, memberId, skillId, selectionId);
      else await addPermanentSkill(board.team.id, memberId, skillId, selectionId);
      await refresh(board.team.id);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "DayCrew could not update this Skill assignment.");
    } finally { setBusy(false); }
  };

  if (!library && !error) return <AppPage view="Skills" needsCount={0}><div className="state-main"><LoadingTeamPage /></div></AppPage>;
  if (!library) return <AppPage view="Skills" needsCount={0}><div className="state-main"><section className="state-page error-state"><span className="state-icon"><Icon name="warning" size={30} /></span><h1>DayCrew needs a moment</h1><p>{error}</p><button className="primary-button" onClick={() => void refresh()}>Try again</button></section></div></AppPage>;

  return <AppPage view="Skills" needsCount={needsCount} {...(board ? { workspace: board.workspace, onSwitchWorkspace } : {})}>
    <div className="skills-content">
      <header className="page-heading">
        <p>SKILLS</p>
        <h1>What your crew knows.</h1>
        <span>Give your agents reusable instructions and workflows. Browse a skill to see what it does and add it to a teammate. Skills do not grant tool access.</span>
      </header>

      {library.length === 0
        ? <section className="tasks-empty card-surface"><span><Icon name="sparkle" size={25} /></span><div><h2>No Skills in this Workspace.</h2><p>Skills live under <code>.daycrew/skills</code>. Add one from the contributor guide, then reload this page.</p></div><a className="primary-button" href="https://github.com/daycrew/daycrew/blob/main/docs/SKILLS.md">Skill guide</a></section>
        : <>
          <section className="skills-toolbar" aria-label="Skill filters">
            <label className="task-filter-search"><span>Search</span><div><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Skill name, tag, or description" /></div></label>
            {board && board.teams.length > 1 && <label><span>Team</span><select value={teamId ?? board.team.id} onChange={(event) => { setTeamId(event.target.value); void refresh(event.target.value); }}>{board.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label>}
            <p className="task-filter-count">{visible.length} of {library.length} Skills</p>
          </section>

          <div className="skills-layout">
            <div className="skills-list-column" role="listbox" aria-label="Skill library">
              {visible.map((skill) => {
                const assigned = board?.memberSkills.reduce(
                  (total, state) => total + state.assignments.filter((item) => item.skill.id === skill.id && item.scope === "permanent").length, 0,
                ) ?? 0;
                return <button
                  type="button"
                  role="option"
                  aria-selected={skill.id === selected?.id}
                  className={`skill-option ${skill.id === selected?.id ? "selected" : ""}`}
                  key={skill.id}
                  onClick={() => setSelectedId(skill.id)}
                >
                  <span className="skill-list-icon"><Icon name="knowledge" size={17} /></span>
                  <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                  {assigned > 0 && <em title={`Attached to ${assigned} Member${assigned === 1 ? "" : "s"}`}>{assigned}</em>}
                </button>;
              })}
              {visible.length === 0 && <p className="detail-empty">No Skill matches this search.</p>}
            </div>

            {selected && <section className="skills-detail-column card-surface" aria-label={`${selected.name} detail`}>
              <header><h2>{selected.name}</h2></header>
              <SkillDetail skill={selected} />

              <h3>Attach to a Team Member</h3>
              {!board
                ? <p className="detail-empty">Create a Team before attaching Skills. <a href="#teams">Open Teams</a></p>
                : <>
                  <p className="skills-scope-note"><Icon name="warning" size={15} /> Attaching here is permanent for the Member of <strong>{board.team.name}</strong>. Task-scoped Skills are added from the Team page while a Task is active.</p>
                  {actionError && <p className="inline-error" role="alert">{actionError}</p>}
                  <div className="skills-member-list">
                    {board.team.members.map((member) => {
                      const state = board.memberSkills.find((item) => item.memberId === member.id);
                      const attached = state?.assignments.some((item) => item.skill.id === selected.id && item.scope === "permanent") ?? false;
                      const compatibility = state?.availability.find((item) => item.skill.id === selected.id)?.compatibility;
                      const blocked = !attached && compatibility?.compatible === false;
                      return <article key={member.id}>
                        <Avatar member={member} size="sm" />
                        <div>
                          <strong>{member.name}</strong>
                          <small>{member.isManager ? "Manager" : member.role}</small>
                          {blocked && <small className="skill-incompatible">{compatibility?.reason} {compatibility?.resolution}</small>}
                        </div>
                        <button
                          type="button"
                          className={attached ? "secondary-button" : "primary-button"}
                          disabled={busy || blocked}
                          title={blocked ? "This Member's AI Engine does not provide the capabilities this Skill requires." : undefined}
                          onClick={() => void assign(member.id, selected.id, attached)}
                        >{attached ? "Remove" : "Attach"}</button>
                      </article>;
                    })}
                  </div>
                </>}
            </section>}
          </div>
        </>}
    </div>
  </AppPage>;
};

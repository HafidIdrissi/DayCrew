import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, loadOffice, startGoal } from "./api";
import { PixelAvatar } from "./avatar";
import { AppPage, Avatar, Icon, MemberStatusBadge, MissionIssues, formatRelativeTime } from "./components";
import { OfficeFloor } from "./OfficeFloor";
import type { MissionIssue, OfficeData, OfficeMember, OfficeTeam } from "./types";
import { EmptyState, ErrorState, LoadingState } from "./ui";

const engineLabel = (member: OfficeMember): string => {
  if (member.engine.mode === "auto") return "Auto engine";
  if (member.engine.provider === "demo") return "Demo Mode (simulated)";
  return [member.engine.provider, member.engine.model].filter(Boolean).join(" · ") || "Manual engine";
};

const sessionLabel = (team: OfficeTeam): string => {
  if (!team.sessionStatus) return "No Work Session yet";
  return `Session ${team.sessionStatus.replaceAll("-", " ")}`;
};

/**
 * The floor is a read-out of persisted Member runtime, never an animation of
 * imagined work: a Member with no runtime record stays plainly idle.
 */
export const OfficePage = ({ selectionId, onSwitchWorkspace, onWorkspaceIssue }: {
  selectionId: string;
  onSwitchWorkspace: () => void;
  onWorkspaceIssue: () => void;
}) => {
  const [data, setData] = useState<OfficeData>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<{ teamId: string; memberId: string }>();
  // The floor is the richer read; the list is the one that survives a narrow screen.
  // matchMedia is missing in some embedders, so its absence must not take the page down.
  const [view, setView] = useState<"floor" | "list">(() =>
    typeof window?.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches ? "list" : "floor");
  const generation = useRef(0);

  const refresh = useCallback(async (quiet = false) => {
    const request = ++generation.current;
    if (!quiet) setError(undefined);
    try {
      const next = await loadOffice(selectionId);
      if (request === generation.current) { setData(next); setError(undefined); }
    } catch (caught) {
      if (request !== generation.current) return;
      if (caught instanceof ApiError && caught.code?.startsWith("WORKSPACE_")) onWorkspaceIssue();
      else setError(caught instanceof Error ? caught.message : "DayCrew could not load Office.");
    }
  }, [selectionId, onWorkspaceIssue]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(true); }, 5_000);
    return () => { ++generation.current; window.clearInterval(timer); };
  }, [refresh]);

  const detail = useMemo(() => {
    if (!data || !selected) return undefined;
    const team = data.teams.find((item) => item.id === selected.teamId);
    const member = team?.members.find((item) => item.id === selected.memberId);
    return team && member ? { team, member } : undefined;
  }, [data, selected]);

  if (!data && !error) return <AppPage view="Office" needsCount={0}><div className="state-main"><LoadingState label="Opening the Office..." /></div></AppPage>;
  if (!data) return <AppPage view="Office" needsCount={0}><div className="state-main"><ErrorState message={error ?? "Office is unavailable."} onRetry={() => void refresh()} /></div></AppPage>;

  const retryMission = async (issue: MissionIssue) => {
    await startGoal(issue.teamId, issue.goal, selectionId);
    await refresh(true);
  };

  return <AppPage view="Office" needsCount={data.needsYouCount} workspace={data.workspace} onSwitchWorkspace={onSwitchWorkspace}>
    <div className="office-content">
      <header className="page-heading office-heading">
        <div>
          <p>OFFICE</p>
          <h1>See where the crew is.</h1>
          <span>Every desk reflects persisted Member state from this Workspace. Decorations are drawn; work signals come from the server.</span>
        </div>
        <div className="view-switch" role="group" aria-label="Office view">
          <button type="button" className={view === "floor" ? "active" : ""} aria-pressed={view === "floor"} onClick={() => setView("floor")}><Icon name="office" size={16} />Floor</button>
          <button type="button" className={view === "list" ? "active" : ""} aria-pressed={view === "list"} onClick={() => setView("list")}><Icon name="tasks" size={16} />List</button>
        </div>
      </header>
      <MissionIssues issues={data.missionIssues} onRetry={retryMission} />
      {data.teams.length === 0
        ? <EmptyState title="The Office is quiet." message="Create a Team to give your first crew a place to work." action={<a className="primary-button" href="#teams">Create Team</a>} />
        : <div className={`office-layout ${detail ? "has-detail" : ""}`}>
          <div className="office-team-list">{data.teams.map((team) => <section className="office-team card-surface" key={team.id}>
            <header>
              <div>
                <span className="team-icon small"><Icon name="team" size={20} /></span>
                <div>
                  <h2>{team.name} {team.demoMode && <span className="demo-inline">Demo Mode</span>}</h2>
                  <p>{team.goal ?? "Ready for the next goal"}</p>
                </div>
              </div>
              <a href={`#teams/${team.id}`}>Open Team <Icon name="arrow" size={14} /></a>
            </header>
            <p className="office-session-line"><span className={`session-state session-${team.sessionStatus ?? "created"}`}>{sessionLabel(team)}</span><span className="office-autonomy">Autonomy: {team.autonomy.replaceAll("-", " ")}</span></p>
            {view === "floor"
              ? <OfficeFloor
                team={team}
                {...(detail?.team.id === team.id ? { selectedId: detail.member.id } : {})}
                onSelect={(memberId) => setSelected(
                  detail?.member.id === memberId && detail.team.id === team.id ? undefined : { teamId: team.id, memberId },
                )}
              />
              : <div className="office-member-grid" role="listbox" aria-label={`${team.name} members`}>{team.members.map((member) => {
                const active = detail?.member.id === member.id && detail.team.id === team.id;
                return <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`office-member ${member.isManager ? "manager" : ""} ${active ? "is-selected" : ""}`}
                  key={member.id}
                  onClick={() => setSelected(active ? undefined : { teamId: team.id, memberId: member.id })}
                >
                  <PixelAvatar member={member} size="md" status={member.status} />
                  <h3>{member.name}</h3>
                  <p>{member.isManager ? "Manager" : member.role}</p>
                  <MemberStatusBadge status={member.status} />
                  <small>{member.currentTask ?? (member.isManager ? "Coordinating the Team" : "Available for work")}</small>
                  {member.needsYouCount > 0 && <span className="office-needs-flag"><Icon name="warning" size={12} />{member.needsYouCount}</span>}
                </button>;
              })}</div>}
          </section>)}</div>

          {detail && <aside className="office-detail card-surface" aria-label={`${detail.member.name} detail`}>
            <header>
              <div>
                <Avatar member={{ ...detail.member, instructions: "" }} size="lg" status={detail.member.status} />
                <div><h2>{detail.member.name}</h2><p>{detail.member.isManager ? "Manager" : detail.member.role}</p></div>
              </div>
              <button className="icon-button" type="button" onClick={() => setSelected(undefined)} aria-label="Close agent detail"><Icon name="close" size={18} /></button>
            </header>
            <MemberStatusBadge status={detail.member.status} />
            <dl className="office-detail-facts">
              <div><dt>Team</dt><dd>{detail.team.name}</dd></div>
              <div><dt>AI Engine</dt><dd>{engineLabel(detail.member)}</dd></div>
              <div><dt>Current work</dt><dd>{detail.member.currentTask ?? "No assigned Task"}</dd></div>
              <div><dt>Permanent Skills</dt><dd>{detail.member.skillCount}</dd></div>
              <div><dt>Needs You</dt><dd>{detail.member.needsYouCount === 0 ? "Nothing pending" : `${detail.member.needsYouCount} pending`}</dd></div>
              {detail.member.lastActiveAt && <div><dt>Last active</dt><dd>{formatRelativeTime(detail.member.lastActiveAt)}</dd></div>}
            </dl>
            {detail.team.demoMode && <p className="demo-mode-banner"><strong>Demo Mode</strong> This Team runs the deterministic demo provider. Its output is simulated, not real AI execution.</p>}
            <div className="office-detail-actions">
              <a className="primary-button" href={`#teams/${detail.team.id}`}>Message this Team</a>
              {detail.member.currentTaskId && detail.team.sessionId && <a className="secondary-button" href={`#tasks/${encodeURIComponent(detail.team.sessionId)}/${encodeURIComponent(detail.member.currentTaskId)}`}>Open current Task</a>}
              {detail.member.needsYouCount > 0 && <a className="secondary-button" href="#needs-you">Review Needs You</a>}
            </div>
          </aside>}
        </div>}
    </div>
  </AppPage>;
};

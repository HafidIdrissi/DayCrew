import { PixelAvatar, statusMeta } from "./avatar";
import { Icon } from "./components";
import type { OfficeMember, OfficeTeam } from "./types";

/**
 * A drawn room, not a simulation. Desks, plants and screens are decoration and
 * may idle-animate; every work signal on this floor — who is busy, who is
 * blocked, what they are on — is read straight from server state. Nothing here
 * invents movement, conversation or progress.
 */

const WORKING = new Set(["working", "thinking"]);

const Desk = ({ member, team, selected, onSelect }: {
  member: OfficeMember;
  team: OfficeTeam;
  selected: boolean;
  onSelect: () => void;
}) => {
  const meta = statusMeta[member.status];
  const busy = WORKING.has(member.status);
  const label = `${member.name}, ${member.isManager ? "Manager" : member.role}, ${meta.label}${member.currentTask ? `, working on ${member.currentTask}` : ""}`;
  return (
    <button
      type="button"
      className={`desk ${member.isManager ? "desk-manager" : ""} ${selected ? "is-selected" : ""}`}
      data-status={member.status}
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
    >
      <span className="desk-character">
        <PixelAvatar member={member} size="lg" variant="full" status={member.status} />
        <span className={`desk-chair ${busy ? "is-busy" : ""}`} aria-hidden="true" />
      </span>
      <span className="desk-surface" aria-hidden="true">
        <span className={`desk-screen ${busy ? "is-on" : ""}`} />
        {member.isManager ? <span className="desk-plate">{team.name.slice(0, 18)}</span> : <span className="desk-paper" />}
        {member.skillCount > 0 && <span className="desk-books" title={`${member.skillCount} Skills`} />}
      </span>
      <span className="desk-label">
        <strong>{member.name}</strong>
        <small>{member.isManager ? "Manager" : member.role}</small>
        <span className={`desk-state status-${meta.tone}`}>
          <i className={`state-mark mark-${meta.mark}`} aria-hidden="true" />{meta.label}
        </span>
      </span>
      {member.needsYouCount > 0 && <span className="desk-flag" aria-hidden="true"><Icon name="warning" size={12} />{member.needsYouCount}</span>}
    </button>
  );
};

export const OfficeFloor = ({ team, selectedId, onSelect }: {
  team: OfficeTeam;
  selectedId?: string;
  onSelect: (memberId: string) => void;
}) => {
  const manager = team.members.find((member) => member.isManager);
  const crew = team.members.filter((member) => !member.isManager);
  return (
    <div className="office-floor" data-crew={Math.min(crew.length, 8)}>
      <div className="floor-wall" aria-hidden="true">
        <span className="wall-window" />
        <span className="wall-board">
          <i /><i /><i />
        </span>
        <span className="wall-clock" />
      </div>
      <div className="floor-room">
        {manager && <section className="floor-zone zone-manager" aria-label="Manager's corner">
          <span className="zone-tag">Manager's corner</span>
          <Desk member={manager} team={team} selected={selectedId === manager.id} onSelect={() => onSelect(manager.id)} />
          <span className="decor decor-plant decor-large" aria-hidden="true" />
        </section>}
        <section className="floor-zone zone-crew" aria-label="Team desks">
          {crew.length === 0
            ? <p className="floor-empty">No Members on this Team yet. The Manager works alone until you add one.</p>
            : crew.map((member) => (
              <Desk key={member.id} member={member} team={team} selected={selectedId === member.id} onSelect={() => onSelect(member.id)} />
            ))}
        </section>
      </div>
      <div className="floor-decor" aria-hidden="true">
        <span className="decor decor-plant" />
        <span className="decor decor-cooler" />
        <span className="decor decor-rug" />
      </div>
    </div>
  );
};

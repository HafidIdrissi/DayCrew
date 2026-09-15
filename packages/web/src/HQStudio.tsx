import { PixelAvatar } from "./avatar";
import { Icon } from "./components";
import type { HomeData } from "./types";

export const HQStudio = ({ team, focus }: { team: HomeData["teams"][number]; focus: boolean }) => <article className={`hq-studio card-surface status-${team.status} ${focus ? "is-focus" : ""}`}>
  <header><span className="hq-studio-symbol" aria-hidden="true">{team.name.trim().charAt(0).toUpperCase()}</span><div><h3>{team.name}</h3><small>Manager: {team.manager.name}{team.demoMode ? " · Demo — simulated" : ""}</small></div><span className="hq-studio-state"><i />{team.status === "needs-you" ? "Needs You" : team.status === "working" ? "Working" : "Ready"}</span></header>
  {!focus && <div className="hq-studio-scene" aria-label={`${team.name} members`}><span className="hq-studio-floor" />{team.members.slice(0, 6).map((member) => <a key={member.id} href={`#teams/${team.id}/members/${member.id}`} title={`${member.name} · ${member.role}`} aria-label={`Open ${member.name}, ${member.role}`}><PixelAvatar member={member} size="md" variant="full" /><small>{member.name}</small></a>)}</div>}
  <div className="hq-studio-work"><small>CURRENT MISSION</small><strong>{team.currentObjective ?? "No active Mission"}</strong>{team.progress && <p>{team.progress.completed} of {team.progress.total} recorded Tasks complete</p>}{team.recentResult && <p className="hq-studio-result"><Icon name="check" size={15} /> Recent result: {team.recentResult.summary}</p>}</div>
  <footer><a href={`#teams/${team.id}`}>Open Team <Icon name="arrow" size={15} /></a>{team.status === "needs-you" && <a href="#needs-you">Review decisions <Icon name="arrow" size={15} /></a>}</footer>
</article>;

import type { Team, WorkFailure, WorkSession } from "@daycrew/shared";

export interface MissionIssue {
  readonly sessionId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly goal: string;
  readonly failedAt: string;
  readonly failure: WorkFailure;
}

const fallbackFailure = (session: WorkSession): WorkFailure => ({
  kind: "unknown",
  message: session.summary?.trim() || "The work session stopped before it could complete.",
  resolution: "Review recent activity, then retry the Mission or choose another AI Engine.",
  retryable: true,
});

/**
 * A Team has one current Mission state. An older failure stops being current as
 * soon as a newer session exists, while its session and activity remain auditable.
 */
export const currentMissionIssues = (
  teams: readonly Team[],
  sessions: readonly WorkSession[],
): MissionIssue[] => teams.flatMap((team) => {
  const latest = sessions
    .filter((session) => session.teamId === team.id)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (!latest || latest.status !== "failed") return [];
  return [{
    sessionId: latest.id,
    teamId: team.id,
    teamName: team.name,
    goal: latest.goal,
    failedAt: latest.completedAt ?? latest.startedAt,
    failure: latest.failure ?? fallbackFailure(latest),
  }];
});

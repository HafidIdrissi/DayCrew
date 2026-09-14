import type { AgentEvent, Team } from "@daycrew/shared";

import { MockProvider, type MockScript } from "./mock.js";

/**
 * Creates a deterministic, zero-cost provider that exercises the complete
 * Manager -> specialist -> Manager lifecycle for a Team.
 */
export const createMvpMockProvider = (team: Team, options: { approval?: boolean; id?: string; displayName?: string } = {}): MockProvider => {
  const manager = team.members.find((member) => member.isManager);
  if (!manager) throw new Error("Team Manager was not found");
  const specialists = team.members.filter((member) => !member.isManager);
  if (specialists.length === 0) {
    return new MockProvider({
      ...(options.id ? { id: options.id } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
    });
  }

  const planningEvents: AgentEvent[] = specialists.map((member, index) => ({
    type: "task_update",
    task: {
      id: `task-${member.id}`,
      title: `${member.role}: contribute to the goal`,
      description: `Complete the ${member.role} part of the user's goal and report to the Manager.`,
      ownerId: member.id,
      dependsOn: index === 0 ? [] : [`task-${specialists[index - 1]!.id}`],
    },
  }));
  planningEvents.push({ type: "turn_end" });

  const managerScript: AgentEvent[][] = [planningEvents];
  specialists.forEach((member, index) => {
    const reviewEvents: AgentEvent[] = [
      { type: "task_update", task: { id: `task-${member.id}`, status: "done" } },
    ];
    reviewEvents.push(
      index === specialists.length - 1
        ? { type: "done", summary: "The Team completed and reviewed every delegated task." }
        : { type: "turn_end" },
    );
    managerScript.push(reviewEvents);
  });

  const scriptsByMember: Record<string, MockScript> = {
    [manager.id]: managerScript,
  };
  const approvalMember = options.approval ? specialists.find((member) => /developer|implementation/i.test(member.role)) : undefined;
  for (const member of specialists) {
    scriptsByMember[member.id] = member.id === approvalMember?.id ? [
      [{
        type: "approval_request",
        request: {
          requestId: `demo-write-${member.id}`,
          action: "filesystem.write",
          risk: "medium",
          summary: `${member.name} wants to add the hello endpoint`,
          payload: { path: "src/hello.ts", demo: true },
        },
      }],
      [
        { type: "tool_result", callId: `demo-write-${member.id}`, output: "Demo action approved and simulated." },
        { type: "text", text: `${member.name} completed the assigned contribution.` },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 10, costUsd: 0 } },
        { type: "done", summary: `${member.role} work completed.` },
      ],
    ] : [[
      { type: "text", text: `${member.name} completed the assigned contribution.` },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 10, costUsd: 0 } },
      { type: "done", summary: `${member.role} work completed.` },
    ]];
  }
  return new MockProvider({
    scriptsByMember,
    ...(options.id ? { id: options.id } : {}),
    ...(options.displayName ? { displayName: options.displayName } : {}),
  });
};

export const createAlphaDemoProvider = (team: Team): MockProvider => createMvpMockProvider(team, {
  approval: true,
  id: "demo",
  displayName: "Deterministic Demo Mode",
});

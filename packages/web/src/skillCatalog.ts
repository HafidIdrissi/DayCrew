import type { Task, TeamMember } from "./types";

export type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  recommendedRoles: string[];
};

export type SkillAttachment = {
  memberId: string;
  skillId: string;
  scope: "task" | "member";
  taskId?: string;
};

// The core service does not yet expose a Skill schema or attachment endpoint.
// Keep this preview catalog and its browser-only repository isolated so it can be
// replaced by the real API without changing the reusable SkillDrawer component.
export const PREVIEW_SKILL_CATALOG: SkillDefinition[] = [
  {
    id: "code-review",
    name: "Code review",
    description: "Review changes for correctness, clarity, maintainability, and team conventions.",
    capabilities: ["Read repository files", "Suggest changes"],
    recommendedRoles: ["manager", "quality", "architecture"],
  },
  {
    id: "release-planning",
    name: "Release planning",
    description: "Break a release into sequenced work, owners, dependencies, and checkpoints.",
    capabilities: ["Plan tasks", "Coordinate handoffs"],
    recommendedRoles: ["manager", "architecture"],
  },
  {
    id: "typescript",
    name: "TypeScript",
    description: "Implement and reason about strict, production TypeScript codebases.",
    capabilities: ["Edit code", "Run validation"],
    recommendedRoles: ["implementation", "developer", "architecture"],
  },
  {
    id: "test-design",
    name: "Test design",
    description: "Design focused automated coverage for behavior, boundaries, and regressions.",
    capabilities: ["Create tests", "Run test commands"],
    recommendedRoles: ["quality", "developer", "implementation"],
  },
  {
    id: "technical-writing",
    name: "Technical writing",
    description: "Turn complex implementation details into clear contributor documentation.",
    capabilities: ["Edit documentation", "Summarize decisions"],
    recommendedRoles: ["manager", "architecture", "implementation"],
  },
  {
    id: "security-review",
    name: "Security review",
    description: "Identify risky boundaries and recommend safer implementation patterns.",
    capabilities: ["Inspect code", "Flag risky actions"],
    recommendedRoles: ["quality", "architecture"],
  },
];

const storageKey = (teamId: string): string => `daycrew.preview-skills.${teamId}`;

export const loadSkillAttachments = (teamId: string): SkillAttachment[] => {
  try {
    const raw = localStorage.getItem(storageKey(teamId));
    return raw ? (JSON.parse(raw) as SkillAttachment[]) : [];
  } catch {
    return [];
  }
};

export const saveSkillAttachments = (teamId: string, attachments: SkillAttachment[]): void => {
  localStorage.setItem(storageKey(teamId), JSON.stringify(attachments));
};

export const recommendedSkillFor = (member: TeamMember): SkillDefinition => {
  const role = `${member.role} ${member.name}`.toLowerCase();
  return (
    PREVIEW_SKILL_CATALOG.find((skill) =>
      skill.recommendedRoles.some((recommendedRole) => role.includes(recommendedRole)),
    ) ?? PREVIEW_SKILL_CATALOG[0]!
  );
};

export const activeTaskFor = (tasks: Task[], memberId: string): Task | undefined =>
  tasks.find((task) => task.ownerId === memberId && task.status !== "done") ??
  tasks.find((task) => task.status !== "done");

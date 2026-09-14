import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  SkillManifestSchema,
  SkillSchema,
  type ProviderCapabilities,
  type Skill,
  type SkillCompatibility,
  type SkillRecommendation,
  type Task,
  type TeamMember,
} from "@daycrew/shared";

import { statePath } from "./storage.js";
import { WorkSessionService } from "./session.js";
import { TeamService, WorkspaceService } from "./workspace.js";

const MAX_EFFECTIVE_CONTEXT_CHARS = 32_000;

const bundled = (value: Omit<Skill, "source">): Skill => SkillSchema.parse({
  ...value,
  source: { type: "bundled", reference: "daycrew" },
});

export const BUNDLED_SKILLS: readonly Skill[] = [
  bundled({
    id: "api-design", name: "API Design", version: "1.0.0", author: "DayCrew contributors",
    description: "Design stable, clear APIs with explicit contracts, errors, versioning, and compatibility.",
    instructions: "Define the consumer and contract before implementation. Use consistent resource names and status semantics. Specify validation, error shapes, pagination, idempotency, and compatibility behavior. Include concrete request and response examples. Keep provider-specific details behind adapters.",
    tags: ["software", "api", "architecture"], requiredCapabilities: [], recommendedTools: [],
    compatibleRoles: ["Architecture", "Developer", "Manager"],
  }),
  bundled({
    id: "unit-testing", name: "Unit Testing", version: "1.0.0", author: "DayCrew contributors",
    description: "Write focused tests for observable behavior, boundaries, regressions, and failure paths.",
    instructions: "Test observable behavior and meaningful boundaries. Reproduce regressions before fixing them. Keep fixtures small and deterministic. Avoid tests that only mirror implementation details. Run the narrowest relevant test first, then the project test command when appropriate.",
    tags: ["software", "testing", "quality"], requiredCapabilities: ["filesystem.read", "command.run"], recommendedTools: ["test-runner"],
    compatibleRoles: ["Developer", "Implementation", "Quality assurance", "QA Engineer"],
  }),
  bundled({
    id: "code-review", name: "Code Review", version: "1.0.0", author: "DayCrew contributors",
    description: "Review changes for correctness, maintainability, regressions, and clear evidence.",
    instructions: "Inspect the changed behavior and its callers. Prioritize correctness, data loss, security, concurrency, and compatibility risks. Cite concrete files or behavior for each finding. Separate confirmed defects from questions. Verify tests cover the important behavior and report when evidence is missing.",
    tags: ["software", "review", "quality"], requiredCapabilities: ["filesystem.read"], recommendedTools: ["repository-reader"],
    compatibleRoles: ["Manager", "Architecture", "Developer", "Quality assurance"],
  }),
  bundled({
    id: "documentation", name: "Documentation", version: "1.0.0", author: "DayCrew contributors",
    description: "Write concise contributor and user documentation grounded in the current product behavior.",
    instructions: "Write for a reader who has not seen the implementation discussion. Lead with the behavior and purpose. Use short concrete examples for setup, configuration, and errors. Keep terms consistent with the product model. Verify commands and paths when tools are available, and state any unverified assumption.",
    tags: ["software", "documentation", "contributors"], requiredCapabilities: [], recommendedTools: ["repository-reader"],
    compatibleRoles: ["Manager", "Architecture", "Developer", "Technical Writer"],
  }),
  bundled({
    id: "playwright-e2e", name: "Playwright E2E", version: "1.0.0", author: "DayCrew contributors",
    description: "Build resilient browser tests around user-visible workflows with useful failure evidence.",
    instructions: "Test user-visible outcomes through accessible roles and stable labels. Keep each test independent. Wait for application state rather than fixed delays. Capture useful traces or screenshots on failure. Cover the primary workflow and one meaningful failure path without duplicating unit coverage.",
    tags: ["software", "testing", "browser"], requiredCapabilities: ["browser", "command.run"], recommendedTools: ["playwright"],
    compatibleRoles: ["Quality assurance", "QA Engineer", "Developer"],
  }),
  bundled({
    id: "accessibility-review", name: "Accessibility Review", version: "1.0.0", author: "DayCrew contributors",
    description: "Review interfaces for keyboard use, semantics, focus, contrast, and understandable feedback.",
    instructions: "Check the complete workflow with keyboard navigation. Verify semantic structure, accessible names, focus order and visible focus. Check form errors and dynamic updates are announced clearly. Evaluate contrast and motion. Report each issue with user impact, reproduction steps, and a specific remediation.",
    tags: ["software", "accessibility", "quality"], requiredCapabilities: ["browser"], recommendedTools: ["browser"],
    compatibleRoles: ["Quality assurance", "QA Engineer", "Designer", "Developer"],
  }),
  bundled({
    id: "security-review", name: "Security Review", version: "1.0.0", author: "DayCrew contributors",
    description: "Review trust boundaries, authorization, input handling, secrets, and risky side effects.",
    instructions: "Map trusted and untrusted inputs before reviewing details. Check authorization at every state-changing boundary. Look for path traversal, injection, secret exposure, unsafe defaults, confused-deputy behavior, and bypasses of approval policy. Describe exploit conditions and impact. Recommend the smallest enforceable fix and a regression test.",
    tags: ["software", "security", "review"], requiredCapabilities: ["filesystem.read"], recommendedTools: ["repository-reader"],
    compatibleRoles: ["Architecture", "Quality assurance", "Developer", "Security Engineer"],
  }),
  bundled({
    id: "literature-review", name: "Literature Review", version: "1.0.0", author: "DayCrew contributors",
    description: "Synthesize a bounded body of research while separating evidence, interpretation, and uncertainty.",
    instructions: "Define the research question, scope, inclusion criteria, and date boundary. Prefer primary sources. Group findings by claim rather than source, identify disagreement and evidence quality, and state important gaps. Never imply that an unread source was reviewed.",
    tags: ["research", "synthesis", "evidence"], requiredCapabilities: ["network"], recommendedTools: ["web-search"],
    compatibleRoles: ["Researcher", "Analyst", "Manager"],
  }),
  bundled({
    id: "citation-check", name: "Citation Check", version: "1.0.0", author: "DayCrew contributors",
    description: "Verify that citations exist, support the nearby claim, and are represented without distortion.",
    instructions: "Check each citation against the exact claim it supports. Record whether the source is accessible, primary or secondary, current enough, and accurately characterized. Flag unsupported leaps, stale facts, and circular citations. Do not invent replacement citations.",
    tags: ["research", "citations", "quality"], requiredCapabilities: ["network"], recommendedTools: ["web-search"],
    compatibleRoles: ["Researcher", "Analyst", "Quality assurance", "Technical Writer"],
  }),
  bundled({
    id: "cv-review", name: "CV Review", version: "1.0.0", author: "DayCrew contributors",
    description: "Review a CV for clarity, evidence, relevance, and applicant-tracking compatibility.",
    instructions: "Evaluate the CV against the stated role without inventing experience. Prefer concrete outcomes and concise action-result bullets. Flag vague claims, inconsistent dates, excessive formatting, and missing relevant evidence. Treat personal data as sensitive and avoid unnecessary reproduction.",
    tags: ["career", "cv", "review"], requiredCapabilities: ["filesystem.read"], recommendedTools: ["document-reader"],
    compatibleRoles: ["Career Coach", "Recruiter", "Reviewer", "Manager"],
  }),
  bundled({
    id: "seo-audit", name: "SEO Audit", version: "1.0.0", author: "DayCrew contributors",
    description: "Audit discoverability, crawlability, metadata, content structure, and technical SEO fundamentals.",
    instructions: "Start from target audience and search intent. Check indexing controls, canonical URLs, titles, descriptions, headings, structured data, internal links, performance signals, and accessibility overlap. Separate observed defects from recommendations and avoid promising ranking outcomes.",
    tags: ["marketing", "seo", "web"], requiredCapabilities: ["browser", "network"], recommendedTools: ["browser"],
    compatibleRoles: ["Marketing", "SEO Specialist", "Quality assurance", "Developer"],
  }),
  bundled({
    id: "product-sourcing", name: "Product Sourcing", version: "1.0.0", author: "DayCrew contributors",
    description: "Compare product and supplier options using explicit requirements, evidence, and risk checks.",
    instructions: "Define requirements, budget, geography, quantity, lead time, and disqualifiers before searching. Compare landed cost, minimum order, certifications, warranty, supplier evidence, and fulfillment risk. Mark prices and availability with a checked date. Never purchase or contact suppliers without explicit approval.",
    tags: ["ecommerce", "sourcing", "research"], requiredCapabilities: ["network"], recommendedTools: ["web-search"],
    compatibleRoles: ["Sourcing Specialist", "E-commerce", "Researcher", "Manager"],
  }),
];

const contains = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export const loadSkillDirectory = async (
  skillRoot: string,
  sourceType = "workspace",
): Promise<Skill> => {
  const canonicalRoot = await realpath(skillRoot);
  if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error("A Skill must be a directory");
  const manifestPath = await realpath(path.join(canonicalRoot, "skill.json"));
  const instructionsPath = await realpath(path.join(canonicalRoot, "instructions.md"));
  if (!contains(canonicalRoot, manifestPath) || !contains(canonicalRoot, instructionsPath)) {
    throw new Error("Skill files must not escape their Skill directory");
  }
  const manifest = SkillManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (path.basename(canonicalRoot) !== manifest.id) {
    throw new Error(`Skill directory must be named "${manifest.id}"`);
  }
  const { instructionsFile: _instructionsFile, ...definition } = manifest;
  return SkillSchema.parse({
    ...definition,
    source: {
      type: sourceType,
      reference: sourceType === "workspace" ? `.daycrew/skills/${manifest.id}` : canonicalRoot,
    },
    instructions: await readFile(instructionsPath, "utf8"),
  });
};

export const assessSkillCompatibility = (
  skill: Skill,
  capabilities: ProviderCapabilities,
): SkillCompatibility => {
  const available = new Set(capabilities.skillCapabilities ?? []);
  const missingCapabilities = skill.requiredCapabilities.filter((required) => !available.has(required));
  if (missingCapabilities.length === 0) return { compatible: true, missingCapabilities: [] };
  return {
    compatible: false,
    missingCapabilities,
    reason: `This Skill requires capabilities that this Member does not currently have: ${missingCapabilities.join(", ")}.`,
    resolution: "Choose an AI Engine and tool policy that provide these capabilities, or remove the Skill from this work.",
  };
};

export const unavailableAssignedSkill = (skillId: string): Skill => SkillSchema.parse({
  id: skillId,
  name: skillId,
  description: "This assigned Skill is no longer available in the current Workspace library.",
  version: "0.0.0",
  source: { type: "missing", reference: skillId },
  instructions: "Unavailable Skill instructions.",
  tags: [], requiredCapabilities: [], recommendedTools: [], compatibleRoles: [],
});

export interface EffectiveSkillContext {
  readonly instructions: string;
  readonly skills: readonly Skill[];
  readonly issues: readonly string[];
}

export interface SkillSourceLoader {
  readonly id: string;
  load(): Promise<readonly Skill[]>;
}

export class BundledSkillSource implements SkillSourceLoader {
  readonly id = "bundled";
  async load(): Promise<readonly Skill[]> { return BUNDLED_SKILLS; }
}

export class WorkspaceSkillSource implements SkillSourceLoader {
  readonly id = "workspace";
  constructor(private readonly workspaceRoot: string) {}

  async load(): Promise<readonly Skill[]> {
    const directory = statePath(this.workspaceRoot, "skills");
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const skills: Skill[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      skills.push(await loadSkillDirectory(statePath(this.workspaceRoot, "skills", entry.name)));
    }
    return skills;
  }
}

export class SkillService {
  private readonly sources: readonly SkillSourceLoader[];

  constructor(private readonly workspaceRoot: string, sources?: readonly SkillSourceLoader[]) {
    this.sources = sources ?? [new BundledSkillSource(), new WorkspaceSkillSource(workspaceRoot)];
  }

  async list(): Promise<Skill[]> {
    await new WorkspaceService(this.workspaceRoot).load();
    const byId = new Map<string, Skill>();
    for (const source of this.sources) {
      for (const value of await source.load()) {
        const skill = SkillSchema.parse(value);
        if (byId.has(skill.id)) throw new Error(`Duplicate Skill id "${skill.id}" from source "${source.id}"`);
        byId.set(skill.id, skill);
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(skillId: string): Promise<Skill> {
    const skill = (await this.list()).find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error(`Skill "${skillId}" was not found`);
    return skill;
  }

  async addPermanent(teamId: string, memberId: string, skillId: string): Promise<TeamMember> {
    await this.get(skillId);
    const teams = new TeamService(this.workspaceRoot);
    const team = await teams.load(teamId);
    const member = team.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new Error(`Member "${memberId}" does not belong to Team "${teamId}"`);
    const skillIds = [...new Set([...(member.skillIds ?? []), skillId])];
    const updated = await teams.update(teamId, {
      members: team.members.map((candidate) => candidate.id === memberId ? { ...candidate, skillIds } : candidate),
    });
    return updated.members.find((candidate) => candidate.id === memberId)!;
  }

  async removePermanent(teamId: string, memberId: string, skillId: string): Promise<TeamMember> {
    const teams = new TeamService(this.workspaceRoot);
    const team = await teams.load(teamId);
    const member = team.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new Error(`Member "${memberId}" does not belong to Team "${teamId}"`);
    const updated = await teams.update(teamId, {
      members: team.members.map((candidate) => candidate.id === memberId
        ? { ...candidate, skillIds: (candidate.skillIds ?? []).filter((id) => id !== skillId) }
        : candidate),
    });
    return updated.members.find((candidate) => candidate.id === memberId)!;
  }

  async findTask(taskId: string, sessionId?: string): Promise<{ sessionId: string; teamId: string; task: Task }> {
    const sessions = new WorkSessionService(this.workspaceRoot);
    if (sessionId) {
      const session = await sessions.load(sessionId);
      const task = (await sessions.listTasks(session.id)).find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Task "${taskId}" was not found in Work Session "${sessionId}"`);
      return { sessionId: session.id, teamId: session.teamId, task };
    }
    const matches: Array<{ sessionId: string; teamId: string; task: Task }> = [];
    for (const session of await sessions.list()) {
      const task = (await sessions.listTasks(session.id)).find((candidate) => candidate.id === taskId);
      if (task) matches.push({ sessionId: session.id, teamId: session.teamId, task });
    }
    if (matches.length !== 1) throw new Error(matches.length ? `Task "${taskId}" is ambiguous` : `Task "${taskId}" was not found`);
    return matches[0]!;
  }

  async addTemporary(taskId: string, memberId: string, skillId: string, sessionId?: string): Promise<Task> {
    await this.get(skillId);
    const found = await this.findTask(taskId, sessionId);
    const team = await new TeamService(this.workspaceRoot).load(found.teamId);
    if (!team.members.some((member) => member.id === memberId)) throw new Error(`Member "${memberId}" does not belong to this Task's Team`);
    const current = found.task.skillAssignments ?? [];
    const existing = current.find((assignment) => assignment.memberId === memberId);
    const skillIds = [...new Set([...(existing?.skillIds ?? []), skillId])];
    const skillAssignments = existing
      ? current.map((assignment) => assignment.memberId === memberId ? { memberId, skillIds } : assignment)
      : [...current, { memberId, skillIds }];
    return new WorkSessionService(this.workspaceRoot).updateTask(found.sessionId, taskId, { skillAssignments });
  }

  async removeTemporary(taskId: string, memberId: string, skillId: string, sessionId?: string): Promise<Task> {
    const found = await this.findTask(taskId, sessionId);
    const skillAssignments = (found.task.skillAssignments ?? []).map((assignment) => assignment.memberId === memberId
      ? { ...assignment, skillIds: assignment.skillIds.filter((id) => id !== skillId) }
      : assignment).filter((assignment) => assignment.skillIds.length > 0);
    return new WorkSessionService(this.workspaceRoot).updateTask(found.sessionId, taskId, { skillAssignments });
  }

  async recommend(teamId: string, memberId: string, capabilities: ProviderCapabilities, task?: Task): Promise<SkillRecommendation[]> {
    const team = await new TeamService(this.workspaceRoot).load(teamId);
    const member = team.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new Error(`Member "${memberId}" does not belong to Team "${teamId}"`);
    const assigned = new Set([
      ...(member.skillIds ?? []),
      ...(task?.skillAssignments?.find((assignment) => assignment.memberId === memberId)?.skillIds ?? []),
    ]);
    const role = member.role.toLowerCase();
    const taskText = `${task?.title ?? ""} ${task?.description ?? ""}`.toLowerCase();
    const scored = (await this.list()).map((skill) => {
      const roleMatch = skill.compatibleRoles.some((candidate) => {
        const normalized = candidate.toLowerCase();
        return role.includes(normalized) || normalized.includes(role);
      });
      const taskMatch = task !== undefined && [...skill.tags, ...skill.id.split("-")].some((token) => taskText.includes(token));
      return { skill, roleMatch, taskMatch, score: Number(taskMatch) * 2 + Number(roleMatch) };
    }).filter((candidate) => !assigned.has(candidate.skill.id) && candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
    return scored.map(({ skill, taskMatch }) => ({
      skill,
      reason: taskMatch
        ? `${skill.name} may help ${member.name} with the current Task: ${task!.title}. Adding it still requires your choice.`
        : `${skill.name} is suggested for ${member.name}'s ${member.role} role. Adding it still requires your choice.`,
      compatibility: assessSkillCompatibility(skill, capabilities),
    }));
  }

  async effectiveContext(
    teamId: string,
    memberId: string,
    taskId: string | undefined,
    capabilities: ProviderCapabilities,
    sessionId?: string,
  ): Promise<EffectiveSkillContext> {
    const team = await new TeamService(this.workspaceRoot).load(teamId);
    const member = team.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new Error(`Member "${memberId}" does not belong to Team "${teamId}"`);
    const library = new Map((await this.list()).map((skill) => [skill.id, skill]));
    const permanentIds = [...new Set(member.skillIds ?? [])];
    const foundTask = taskId ? await this.findTask(taskId, sessionId) : undefined;
    if (foundTask && foundTask.teamId !== teamId) throw new Error("Task does not belong to this Team");
    const task = foundTask?.task;
    const temporaryIds = [...new Set(task?.skillAssignments?.find((assignment) => assignment.memberId === memberId)?.skillIds ?? [])];
    const temporary = new Set(temporaryIds);
    const orderedIds = [...permanentIds.filter((id) => !temporary.has(id)), ...temporaryIds];
    const issues: string[] = [];
    const chosen: Skill[] = [];
    for (const id of orderedIds) {
      const skill = library.get(id);
      if (!skill) { issues.push(`Assigned Skill "${id}" is unavailable.`); continue; }
      const compatibility = assessSkillCompatibility(skill, capabilities);
      if (!compatibility.compatible) { issues.push(compatibility.reason!); continue; }
      const conflict = chosen.find((candidate) => candidate.conflictsWith?.includes(skill.id) || skill.conflictsWith?.includes(candidate.id));
      if (conflict) {
        const skillIsTemporary = temporary.has(skill.id);
        const conflictIsTemporary = temporary.has(conflict.id);
        if (skillIsTemporary !== conflictIsTemporary) {
          const loser = skillIsTemporary ? conflict : skill;
          const winner = skillIsTemporary ? skill : conflict;
          const index = chosen.findIndex((candidate) => candidate.id === loser.id);
          if (index >= 0) chosen.splice(index, 1);
          if (!chosen.some((candidate) => candidate.id === winner.id)) chosen.push(winner);
          issues.push(`Skill conflict: task-scoped "${winner.id}" took precedence over permanent "${loser.id}".`);
          continue;
        }
        issues.push(`Material Skill conflict: "${skill.id}" conflicts with "${conflict.id}"; neither instruction set was injected.`);
        const index = chosen.findIndex((candidate) => candidate.id === conflict.id);
        if (index >= 0) chosen.splice(index, 1);
        continue;
      }
      chosen.push(skill);
    }
    const sections = chosen.map((skill) => `## Skill: ${skill.name} (${temporary.has(skill.id) ? "task-scoped" : "permanent"})\n${skill.instructions}`);
    const instructions = [member.instructions, ...sections].join("\n\n");
    if (instructions.length > MAX_EFFECTIVE_CONTEXT_CHARS) throw new Error("Effective Skill context exceeds the 32,000 character limit");
    return { instructions, skills: chosen, issues };
  }
}

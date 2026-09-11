import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  TeamPackDefinitionSchema,
  TeamPackManifestSchema,
  type Team,
  type TeamPackDefinition,
  type TeamPackManifest,
} from "@daycrew/shared";

import { TeamService, type ServiceOptions } from "./workspace.js";

export interface LoadedTeamPack {
  readonly manifest: TeamPackManifest;
  readonly definition: TeamPackDefinition;
  readonly instructions: ReadonlyMap<string, string>;
  readonly rootPath: string;
}

const readParsedJson = async <T>(filePath: string, parse: (value: unknown) => T): Promise<T> => {
  const source = await readFile(filePath, "utf8");
  return parse(JSON.parse(source));
};

const resolvePackFile = async (packRoot: string, relativePath: string): Promise<string> => {
  if (path.isAbsolute(relativePath)) throw new Error("Team Pack paths must be relative");
  const canonicalRoot = await realpath(packRoot);
  const canonicalFile = await realpath(path.resolve(packRoot, relativePath));
  const relative = path.relative(canonicalRoot, canonicalFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Team Pack path escapes its directory: ${relativePath}`);
  }
  return canonicalFile;
};

export const loadTeamPack = async (packRoot: string): Promise<LoadedTeamPack> => {
  const manifest = await readParsedJson(path.join(packRoot, "pack.json"), (value) =>
    TeamPackManifestSchema.parse(value),
  );
  const definition = await readParsedJson(path.join(packRoot, "team.json"), (value) =>
    TeamPackDefinitionSchema.parse(value),
  );
  const instructions = new Map<string, string>();
  for (const member of definition.members) {
    const instructionPath = await resolvePackFile(packRoot, member.instructionsFile);
    instructions.set(member.id, await readFile(instructionPath, "utf8"));
  }
  return { manifest, definition, instructions, rootPath: await realpath(packRoot) };
};

export const installTeamPack = async (
  workspaceRoot: string,
  packRoot: string,
  options: ServiceOptions = {},
): Promise<Team> => {
  const pack = await loadTeamPack(packRoot);
  return new TeamService(workspaceRoot, options).create({
    id: pack.manifest.id,
    name: pack.definition.name,
    description: pack.definition.description,
    autonomy: pack.definition.autonomy,
    members: pack.definition.members.map(({ instructionsFile: _instructionsFile, ...member }) => ({
      ...member,
      instructions: pack.instructions.get(member.id) ?? "",
    })),
  });
};


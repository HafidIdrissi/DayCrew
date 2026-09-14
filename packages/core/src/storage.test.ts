import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { readJson, writeJson } from "./storage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JSON persistence", () => {
  it("serializes concurrent atomic replacements without leaving temporary files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "daycrew-storage-"));
    directories.push(directory);
    const filePath = path.join(directory, "state.json");
    const schema = z.object({ sequence: z.number().int() });

    await Promise.all(Array.from({ length: 32 }, (_, sequence) => writeJson(filePath, { sequence }, schema)));

    expect(await readJson(filePath, schema)).toEqual({ sequence: 31 });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

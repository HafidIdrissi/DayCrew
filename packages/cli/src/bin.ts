#!/usr/bin/env node
import { runCli } from "./index.js";

try {
  process.stdout.write(`${await runCli(process.argv.slice(2))}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`DayCrew: ${message}\n`);
  process.exitCode = 1;
}

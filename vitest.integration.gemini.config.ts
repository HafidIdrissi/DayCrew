import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@daycrew/core": fromRoot("./packages/core/src/index.ts"),
      "@daycrew/providers": fromRoot("./packages/providers/src/index.ts"),
      "@daycrew/shared": fromRoot("./packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["integration/gemini.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});

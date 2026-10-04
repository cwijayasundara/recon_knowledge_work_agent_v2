import { defineConfig } from "vitest/config";

// Runs against the real scripted API (uv run python -m tests.e2e.serve_scripted); Node environment, no Office globals.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/contract/**/*.test.ts"],
    globalSetup: ["tests/contract/globalSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});

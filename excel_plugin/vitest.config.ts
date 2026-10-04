import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/contract/**"],
    coverage: { provider: "v8", include: ["src/api/**", "src/state/**", "src/office/**", "src/ui/**", "src/copilot/**"], thresholds: { lines: 85, functions: 85, branches: 75 } },
  },
});

import { defineConfig } from "@playwright/test";

const API_PORT = 8010;
const WEB_PORT = 3010;
const PYTHONPATH = ["..", "../src", "../packages/onboarding_sdk", "../../../advance_research/string_matcher_v1/src"].join(":");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: { baseURL: `http://localhost:${WEB_PORT}`, screenshot: "on", trace: "retain-on-failure" },
  webServer: [
    {
      // The API with the fixture agent: no live model, no network.
      command: `../.venv/bin/python -m tests.e2e.serve_scripted --port ${API_PORT}`,
      cwd: ".",
      env: { PYTHONPATH, ONB_CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}` },
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx next dev -p ${WEB_PORT}`,
      env: { NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-e2e" },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

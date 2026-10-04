// The production build `pnpm check` runs (VITE_AUTH=entra, cross-platform). VITE_API_BASE falls back to a placeholder
// origin so the check needs no deployment config. It builds into a temporary directory, never dist/, so a real
// deployment build in dist/ can never be overwritten by a placeholder-API bundle.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { ...process.env, VITE_AUTH: "entra", VITE_API_BASE: process.env.VITE_API_BASE ?? "https://api.example.invalid" };
const shell = process.platform === "win32";
const out = mkdtempSync(join(tmpdir(), "onb-addin-check-"));
let status = 1;
try {
  const steps = [
    ["pnpm", ["exec", "vite", "build", "--outDir", out, "--emptyOutDir"]],
    ["node", ["scripts/check-bundle.mjs", out]],
  ];
  status = 0;
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { stdio: "inherit", env, shell });
    if (r.status !== 0) { status = r.status ?? 1; break; }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(status);

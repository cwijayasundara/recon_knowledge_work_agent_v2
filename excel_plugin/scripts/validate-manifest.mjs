// Builds the production manifest from placeholder values into a temporary file and runs Microsoft's validator on it.
// Never writes manifest.prod.xml. The validator may contact Microsoft's online service, so this is not part of `pnpm check`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "./build-manifest.mjs";

const PLACEHOLDER = {
  ADDIN_HOST: "https://addin.example.com",
  ADDIN_ID: "00000000-0000-4000-8000-000000000001",
  ADDIN_VERSION: "1.0.0.0",
  ADDIN_CLIENT_ID: "00000000-0000-4000-8000-000000000002",
  ADDIN_API_RESOURCE: "api://addin.example.com/00000000-0000-4000-8000-000000000002",
};
const env = Object.fromEntries(Object.entries(PLACEHOLDER).map(([k, v]) => [k, process.env[k] ?? v]));
const dir = mkdtempSync(join(tmpdir(), "onb-manifest-"));
let status = 1;
try {
  const file = join(dir, "manifest.xml");
  writeFileSync(file, buildManifest(readFileSync(new URL("../manifest.template.xml", import.meta.url), "utf8"), env));
  const r = spawnSync("pnpm", ["exec", "office-addin-manifest", "validate", file], { stdio: "inherit", shell: process.platform === "win32" });
  status = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);

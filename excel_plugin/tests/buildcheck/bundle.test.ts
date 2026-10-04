import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { checkBundle } from "../../scripts/check-bundle.mjs";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function dist(files: Record<string, string | Buffer>): string {
  const d = mkdtempSync(join(tmpdir(), "bundle-"));
  dirs.push(d);
  mkdirSync(join(d, "assets"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}

it("passes a clean bundle", () => {
  expect(checkBundle(dist({ "index.html": "<html></html>", "assets/a.js": "console.warn(1)" }))).toEqual([]);
});

it.each(["X-Actor", "devAuth", "localhost:3000"])("flags %s", (s) => {
  expect(checkBundle(dist({ "assets/a.js": `var x="${s}"` })).join("\n")).toContain("forbidden string");
});

it("flags source maps and scripts over 250 KB gzipped", () => {
  const problems = checkBundle(dist({ "assets/a.js.map": "{}", "assets/big.js": randomBytes(400 * 1024).toString("base64") }));
  expect(problems.some((p) => p.includes("source map"))).toBe(true);
  expect(problems.some((p) => p.includes("exceeds budget"))).toBe(true);
});

it("the CLI checks the directory it is given", () => {
  const bad = dist({ "assets/a.js": 'var x="devAuth"' });
  const r = spawnSync(process.execPath, ["scripts/check-bundle.mjs", bad], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("forbidden string");
  const good = dist({ "index.html": "<html></html>" });
  expect(spawnSync(process.execPath, ["scripts/check-bundle.mjs", good], { encoding: "utf8" }).status).toBe(0);
});

it("the pnpm check build writes to a temporary directory, never dist/", () => {
  const src = readFileSync("scripts/prod-build.mjs", "utf8");
  expect(src).toMatch(/--outDir", out/);
  expect(src).toContain("mkdtempSync");
  expect(src).not.toMatch(/["'`]dist/);
});

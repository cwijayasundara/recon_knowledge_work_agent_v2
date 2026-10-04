// `pnpm test:contract`: runs the contract suite and tees its full output to excel_plugin/.contract-last.log
// (gitignored), so a one-off failure is kept. A failing or interrupted run is also copied to
// .contract-fail-<timestamp>.log, which later green runs do not overwrite. Exits with vitest's own status (a shell
// `| tee` would hide it); on SIGINT/SIGTERM it forwards the signal, keeps the log and exits 130/143.
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The package directory, whatever the caller's cwd: the logs must land where excel_plugin/.gitignore covers them.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAST = path.join(ROOT, ".contract-last.log");
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

const log = createWriteStream(LAST);
let interrupted = null;
let finished = false;

function finish(status, why) {
  if (finished) return;
  finished = true;
  log.end(`\n[contract-log] exit ${status}${why ? ` (${why})` : ""} at ${new Date().toISOString()}\n`, () => {
    if (status !== 0) {
      const kept = path.join(ROOT, `.contract-fail-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
      copyFileSync(LAST, kept);
      process.stderr.write(`[contract-log] output kept in ${kept}\n`);
    }
    process.exit(status);
  });
}

const child = spawn("pnpm", ["exec", "vitest", "run", "-c", "vitest.contract.config.ts", ...process.argv.slice(2)], {
  cwd: ROOT,
  shell: process.platform === "win32",
  stdio: ["inherit", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { process.stdout.write(d); log.write(d); });
child.stderr.on("data", (d) => { process.stderr.write(d); log.write(d); });
child.on("error", (e) => {
  const line = `[contract-log] could not run vitest: ${e.message}\n`;
  process.stderr.write(line);
  log.write(line);
  finish(1, "spawn error");
});
for (const sig of Object.keys(SIGNAL_EXIT)) {
  process.on(sig, () => {
    interrupted = sig;
    child.kill(sig); // the child tears down the API server (globalSetup) and exits; its output is still logged
  });
}
child.on("close", (code, signal) => {
  if (interrupted) finish(SIGNAL_EXIT[interrupted], interrupted);
  else finish(code ?? (signal ? 1 : 0), signal ?? undefined);
});

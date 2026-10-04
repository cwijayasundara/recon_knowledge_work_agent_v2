import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let server: ChildProcess | null = null;
let cleanup: { exit: () => void; sigint: () => void; sigterm: () => void } | null = null;

// `uv run` is the parent of the Python server, so signal the whole process group (the child is spawned detached).
function killGroup(sig: NodeJS.Signals): void {
  const pid = server?.pid;
  if (!pid) return;
  try { process.kill(-pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
}
const groupAlive = (): boolean => {
  const pid = server?.pid;
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
};
function unreg(): void {
  if (!cleanup) return;
  process.off("exit", cleanup.exit);
  process.off("SIGINT", cleanup.sigint);
  process.off("SIGTERM", cleanup.sigterm);
  cleanup = null;
}
function register(): void {
  const signalHandler = (sig: NodeJS.Signals) => () => {
    killGroup("SIGKILL");
    unreg();
    process.kill(process.pid, sig); // re-raise so the default exit semantics apply
  };
  cleanup = { exit: () => killGroup("SIGKILL"), sigint: signalHandler("SIGINT"), sigterm: signalHandler("SIGTERM") };
  // Prepend: vitest's own handlers call process.exit() synchronously, which would skip ours if they ran first.
  process.prependListener("exit", cleanup.exit);
  process.prependListener("SIGINT", cleanup.sigint);
  process.prependListener("SIGTERM", cleanup.sigterm);
}

// macOS Python 3.12 skips hidden editable .pth files (see CLAUDE.md), so put the packages on the path explicitly.
const pythonPath = (): string =>
  [
    path.join(REPO_ROOT, "src"),
    path.join(REPO_ROOT, "packages/onboarding_sdk"),
    process.env.STRING_MATCHER_PATH ? path.resolve(process.env.STRING_MATCHER_PATH, "src") : path.resolve(REPO_ROOT, "../../advance_research/string_matcher_v1/src"),
    process.env.PYTHONPATH ?? "",
  ].filter(Boolean).join(path.delimiter);

function freePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => {
      const any = net.createServer();
      any.once("error", reject);
      any.listen(0, "127.0.0.1", () => { const p = (any.address() as net.AddressInfo).port; any.close(() => resolve(p)); });
    });
    probe.listen(preferred, "127.0.0.1", () => probe.close(() => resolve(preferred)));
  });
}

export async function setup(): Promise<void> {
  const port = await freePort(8765);
  const url = `http://127.0.0.1:${port}`;
  let log = "";
  server = spawn("uv", ["run", "python", "-m", "tests.e2e.serve_scripted", "--port", String(port)], { detached: true, cwd: REPO_ROOT, env: { ...process.env, PYTHONPATH: pythonPath() }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
  server.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
  register();
  let exited: number | null = null;
  server.once("exit", (code) => { exited = code ?? -1; });
  server.once("error", (e) => { log += String(e); exited = -1; });

  try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`scripted API exited (${exited}):\n${log}`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).status === 200) { process.env.CONTRACT_API_URL = url; return; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`scripted API did not become healthy in 30 s:\n${log}`);
  } catch (e) {
    killGroup("SIGKILL");
    unreg();
    throw e;
  }
}

export async function teardown(): Promise<void> {
  unreg();
  if (!server) return;
  killGroup("SIGTERM");
  for (let i = 0; i < 30 && groupAlive(); i++) await new Promise((r) => setTimeout(r, 100));
  if (groupAlive()) killGroup("SIGKILL");
}

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Two scripted servers: the main one with the scripted copilot on (CONTRACT_API_URL = COPILOT_ON_URL, step slots
// limited to 1 so a busy 503 can be provoked) and one with the copilot off (COPILOT_OFF_URL).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const servers: ChildProcess[] = [];
let cleanup: { exit: () => void; sigint: () => void; sigterm: () => void } | null = null;

// `uv run` is the parent of the Python server, so signal the whole process group (each child is spawned detached).
function killGroup(server: ChildProcess, sig: NodeJS.Signals): void {
  const pid = server.pid;
  if (!pid) return;
  try { process.kill(-pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
}
const killAll = (sig: NodeJS.Signals): void => servers.forEach((s) => killGroup(s, sig));
const groupAlive = (server: ChildProcess): boolean => {
  const pid = server.pid;
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
    killAll("SIGKILL");
    unreg();
    process.kill(process.pid, sig); // re-raise so the default exit semantics apply
  };
  cleanup = { exit: () => killAll("SIGKILL"), sigint: signalHandler("SIGINT"), sigterm: signalHandler("SIGTERM") };
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

/**
 * The server environment: the developer's ONB_COPILOT_* settings are dropped (an exported ONB_COPILOT_ENABLED would
 * turn the "off" server on, and changed caps would move the over-cap threshold), then `extra` is applied.
 */
function serverEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: pythonPath() };
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith("ONB_COPILOT_")) delete env[k];
  return { ...env, ...extra };
}

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

/** Spawns one scripted server and resolves with its URL once /health answers 200 (30 s bound). */
async function launch(name: string, port: number, args: string[], extraEnv: Record<string, string>): Promise<string> {
  const url = `http://127.0.0.1:${port}`;
  let log = "";
  const server = spawn("uv", ["run", "python", "-m", "tests.e2e.serve_scripted", "--port", String(port), ...args], { detached: true, cwd: REPO_ROOT, env: serverEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
  servers.push(server);
  server.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
  server.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
  let exited: number | null = null;
  server.once("exit", (code) => { exited = code ?? -1; });
  server.once("error", (e) => { log += String(e); exited = -1; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`scripted API (${name}) exited (${exited}):\n${log}`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).status === 200) return url;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`scripted API (${name}) did not become healthy in 30 s:\n${log}`);
}

export async function setup(): Promise<void> {
  // Distinct preferred ports: two probes of the same free port would both succeed before either server binds it.
  const onPort = await freePort(8765);
  const offPort = await freePort(onPort === 8766 ? 8767 : 8766);
  register();
  try {
    const [on, off] = await Promise.all([
      launch("copilot on", onPort, ["--copilot"], { ONB_COPILOT_MAX_CONCURRENT_STEPS: "1" }),
      launch("copilot off", offPort, [], { ONB_COPILOT_ENABLED: "false" }),
    ]);
    process.env.CONTRACT_API_URL = on;
    process.env.COPILOT_ON_URL = on;
    process.env.COPILOT_OFF_URL = off;
  } catch (e) {
    killAll("SIGKILL");
    unreg();
    throw e;
  }
}

export async function teardown(): Promise<void> {
  unreg();
  if (!servers.length) return;
  killAll("SIGTERM");
  for (let i = 0; i < 30 && servers.some(groupAlive); i++) await new Promise((r) => setTimeout(r, 100));
  servers.filter(groupAlive).forEach((s) => killGroup(s, "SIGKILL"));
}

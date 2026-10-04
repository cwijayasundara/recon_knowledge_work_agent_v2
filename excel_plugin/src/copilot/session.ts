// The Copilot loop driver: one server session per run, one user turn at a time. It posts the user's message, runs the
// workbook tools the server asks for (sequentially, in Excel), posts their results, and repeats until a final answer.
// Server semantics it relies on (engine.py step): a tool_results post must answer pending call ids only (409
// otherwise); a partial answer gets the still-pending calls back; a new user_message closes pending calls and drops
// the interrupted turn's proposals; a session refuses a step or a close while another step runs (409).
// Errors carry fixed messages only: server detail and Office text never pass through.
import { ApiError, copilotErrorKind, type Client, type CopilotErrorKind } from "../api/client";
import type { ExcelRun } from "../office/highlight";
import { parseRange, validSheetName } from "./rules";
import { runClientTool } from "./tools";
import { COPILOT_CLIENT_TOOLS, type CopilotChange, type CopilotLimits, type StepBody, type StepOut, type ToolCall, type ToolResult, type WriteProposal } from "./types";

export const DEFAULT_MAX_CLIENT_STEPS = 12;
/** Below the server's 2 MiB body cap, with room for the request's own framing. */
export const DEFAULT_MAX_BODY_BYTES = 1_500_000;
/** The server's per-result cap: MAX_CONTENT_BYTES of json.dumps(content) (ensure_ascii) in schemas.py. */
export const MAX_RESULT_CONTENT_BYTES = 1_000_000;
/** The server's StepIn.tool_results max_length. */
export const MAX_RESULTS_PER_POST = 32;
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
/** Retries of one request the server refused as busy (503 with Retry-After). */
export const BUSY_RETRIES = 2;
export const MAX_BUSY_WAIT_S = 60;
/** Waits before re-posting a user message the server refused because the session's previous step still runs. */
export const STEP_RUNNING_WAITS_S = [2, 5] as const;
/** Waits between attempts to close a session whose step still runs; then the server's TTL ends it. */
export const CLOSE_RETRY_WAITS_S = [2, 5, 15, 30, 60] as const;
/** Re-opens when the run changed while its session was starting, before a turn gives up. */
export const MAX_REOPENS = 2;
export const TOOL_FAILED = "tool failed";
export const RESULT_TOO_LARGE = "result too large";
export const stepCapNote = (n: number): string => `Stopped after ${n} tool rounds.`;

export type CopilotFailure = CopilotErrorKind | "aborted" | "in_progress" | "step_running" | "turn_timeout" | "closed" | "run_not_found" | "run_changed" | "protocol";

export const COPILOT_MESSAGES: Record<CopilotFailure, string> = {
  disabled: "The copilot is turned off on this server.",
  session_lost: "The copilot conversation was lost again. Try again.",
  busy: "The copilot is busy. Try again in a minute.",
  too_many: "Too many copilot conversations are open. Close another pane and try again.",
  conflict: "The copilot conversation got out of step. Send your message again.",
  too_large: "The request was too large for the copilot. Ask about a smaller range.",
  bad_request: "The copilot refused the request as malformed.",
  timeout: "The copilot did not answer in time.",
  other: "The copilot request failed.",
  aborted: "Stopped.",
  in_progress: "The copilot is still answering the last message.",
  step_running: "The copilot is still finishing the previous request. Try again in a moment.",
  turn_timeout: "The copilot took too long on this message and was stopped.",
  closed: "The copilot pane was closed.",
  run_not_found: "The run was not found. Reload it and try again.",
  run_changed: "The run kept changing while the copilot was starting. Try again.",
  protocol: "The copilot server sent an unexpected answer.",
};

export class CopilotError extends Error {
  constructor(readonly kind: CopilotFailure, readonly requestId?: string) {
    super(COPILOT_MESSAGES[kind]);
    this.name = "CopilotError";
  }
}
/** The server has the copilot turned off (403). */
export class CopilotDisabled extends CopilotError {
  constructor(requestId?: string) {
    super("disabled", requestId);
    this.name = "CopilotDisabled";
  }
}
/** The turn was stopped (stop(), close() or the caller's signal). */
export class CopilotAborted extends CopilotError {
  constructor() {
    super("aborted");
    this.name = "CopilotAborted";
  }
}
/** A send while another is running; nothing was sent. */
export class CopilotBusy extends CopilotError {
  constructor() {
    super("in_progress");
    this.name = "CopilotBusy";
  }
}

/** One workbook tool run, for the panel's "read" list: addresses and counts only, never cell text. */
export interface ReadLogEntry {
  tool: string;
  sheet?: string;
  range?: string;
  cells: number;
  ok: boolean;
}

export interface TurnResult {
  text: string;
  proposedChanges: CopilotChange[];
  proposedWrites: WriteProposal[];
  notes: string[];
  read: ReadLogEntry[];
  /** A new server session served this turn: the run changed or the old session was lost (earlier context is gone). */
  restarted: boolean;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface CopilotSessionDeps {
  client: Pick<Client, "copilotStart" | "copilotStep" | "copilotClose">;
  run: ExcelRun;
  /** The run the session is bound to; a function is read before each turn (a changed run gets a new session). */
  runId?: string | (() => string | undefined);
  runTool?: typeof runClientTool;
  /** Client backstop on tool rounds per turn (the server ends a turn after 8 model steps by default). */
  maxClientSteps?: number;
  maxBodyBytes?: number;
  /** Bound on one whole turn, retries and tool runs included. */
  turnTimeoutMs?: number;
  sleep?: Sleep;
}

export interface CopilotSession {
  readonly sessionId: string | undefined;
  /** The current server session's limits (undefined while there is none); the panel needs them for writes. */
  readonly limits: CopilotLimits | undefined;
  /** Starts the server session if there is none (sends start for the current run); `signal` ends only this wait. */
  ensureSession(signal?: AbortSignal): Promise<string>;
  send(text: string, opts?: { signal?: AbortSignal }): Promise<TurnResult>;
  /**
   * Stops the running turn at once: its send rejects with CopilotAborted and a new send may follow immediately. The
   * server session is kept: the next user message closes the stopped turn's pending calls there.
   */
  stop(): void;
  /** For unmount: stops any turn and any start, closes the server session, and refuses later sends. */
  close(): Promise<void>;
}

interface Live {
  id: string;
  runId: string | undefined;
  limits: CopilotLimits;
}

const noop = () => undefined;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const length = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const bytesOf = (body: StepBody): number => new TextEncoder().encode(JSON.stringify(body)).length;

function sheetOf(v: unknown): string | undefined {
  try {
    return typeof v === "string" ? validSheetName(v) : undefined;
  } catch {
    return undefined;
  }
}

function rangeOf(v: unknown): string | undefined {
  try {
    return typeof v === "string" ? parseRange(v).a1() : undefined;
  } catch {
    return undefined;
  }
}

/** Addresses from the call's arguments (or the result's own address fields) and a count from the result's shape. */
export function readLogEntry(call: ToolCall, result: ToolResult): ReadLogEntry {
  const tool = (COPILOT_CLIENT_TOOLS as readonly string[]).includes(call.name) ? call.name : "unknown";
  const args = isRecord(call.args) ? call.args : {};
  const c = result.ok && isRecord(result.content) ? result.content : null;
  let sheet = sheetOf(args.sheet);
  let range: string | undefined;
  let cells = 0;
  switch (tool) {
    case "list_sheets":
      cells = length(c?.sheets);
      break;
    case "describe_sheet":
      range = rangeOf(c?.used_range);
      cells = length(c?.headers);
      break;
    case "read_range":
      range = rangeOf(c?.address) ?? rangeOf(args.range);
      cells = count(c?.rows) * count(c?.cols);
      break;
    case "find":
      cells = length(c?.hits);
      break;
    case "get_selection":
      sheet = sheetOf(c?.sheet);
      range = rangeOf(c?.address);
      cells = count(c?.cells);
      break;
  }
  return { tool, ...(sheet !== undefined ? { sheet } : {}), ...(range !== undefined ? { range } : {}), cells, ok: result.ok === true };
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CopilotAborted());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CopilotAborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Settles like `p`, or rejects with CopilotAborted once `signal` aborts; `late` then gets p's value, if any. */
function raced<T>(p: Promise<T>, signal: AbortSignal, late?: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.then((v) => late?.(v), noop);
      reject(new CopilotAborted());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

function asCopilotError(e: unknown): CopilotError {
  if (e instanceof CopilotError) return e;
  const requestId = e instanceof ApiError ? e.requestId : undefined;
  const kind = copilotErrorKind(e);
  return kind === "disabled" ? new CopilotDisabled(requestId) : new CopilotError(kind, requestId);
}

/** Retry-After clamped to 1..60 s, or null when there is none: a 503 without it (a proxy's) is not the copilot's. */
const busyWaitMs = (e: unknown): number | null =>
  e instanceof ApiError && e.retryAfterSeconds !== undefined ? Math.min(MAX_BUSY_WAIT_S, Math.max(1, e.retryAfterSeconds)) * 1000 : null;

/** Length of Python's json.dumps(node) with its defaults (ensure_ascii, ", " and ": " separators). */
export function pyJsonLength(node: unknown): number {
  if (node === null || node === undefined) return 4;
  if (typeof node === "boolean") return node ? 4 : 5;
  if (typeof node === "number") return Number.isFinite(node) ? String(node).length + 2 : 4; // + repr differences (1.0, 1e-07)
  if (typeof node === "string") {
    let n = 2;
    for (let i = 0; i < node.length; i++) {
      const u = node.charCodeAt(i);
      if (u === 0x22 || u === 0x5c || u === 0x08 || u === 0x0c || u === 0x0a || u === 0x0d || u === 0x09) n += 2;
      else if (u < 0x20 || u >= 0x7f) n += 6; // DEL and non-ASCII; a non-BMP character is two escaped UTF-16 units, as in Python
      else n += 1;
    }
    return n;
  }
  if (Array.isArray(node)) return 2 + node.reduce((n: number, v, i) => n + pyJsonLength(v) + (i ? 2 : 0), 0);
  if (typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return 2 + entries.reduce((n, [k, v], i) => n + pyJsonLength(k) + 2 + pyJsonLength(v) + (i ? 2 : 0), 0);
  }
  return 4;
}

const tooLarge = (callId: string): ToolResult => ({ call_id: callId, ok: false, content: { message: RESULT_TOO_LARGE } });

/**
 * Results in call order, in posts of at most `maxBytes` (UTF-8) and MAX_RESULTS_PER_POST each. A result over the
 * server's per-result cap, or alone over `maxBytes`, is replaced by a fixed failure.
 */
export function splitResults(results: ToolResult[], maxBytes: number): ToolResult[][] {
  const chunks: ToolResult[][] = [];
  let chunk: ToolResult[] = [];
  for (const raw of results) {
    const oversize = pyJsonLength(raw.content) > MAX_RESULT_CONTENT_BYTES || bytesOf({ tool_results: [raw] }) > maxBytes;
    const r = oversize ? tooLarge(raw.call_id) : raw;
    if (chunk.length && (chunk.length >= MAX_RESULTS_PER_POST || bytesOf({ tool_results: [...chunk, r] }) > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(r);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function createCopilotSession(deps: CopilotSessionDeps): CopilotSession {
  const { client } = deps;
  const runTool = deps.runTool ?? runClientTool;
  const maxSteps = deps.maxClientSteps ?? DEFAULT_MAX_CLIENT_STEPS;
  const maxBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  /** Aborted by close(): ends a start in flight. */
  const life = new AbortController();
  let live: Live | null = null;
  /** The start in flight and the run it was started for. */
  let opening: { runId: string | undefined; promise: Promise<Live> } | null = null;
  let turn: AbortController | null = null;
  /** The newest server request: the next user message and a close wait for it (the server refuses both mid-step). */
  let inflight: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const currentRunId = (): string | undefined => (typeof deps.runId === "function" ? deps.runId() : deps.runId);
  const pause = (ms: number, signal: AbortSignal) => raced(sleep(ms, signal), signal);

  /**
   * Closes a session on the server once `after` settles, retrying while its step still runs (409) on a bounded
   * backoff; a page unload ends the retries (no timer outlives the page). Best effort: the server's TTL is the backstop.
   * Limitation: pagehide also fires when the page enters the back/forward cache; the retries then end and the session
   * may stay until its TTL.
   */
  async function closeSession(id: string, after: Promise<unknown>): Promise<void> {
    await after.then(noop, noop);
    const unload = new AbortController();
    const onHide = () => unload.abort();
    globalThis.addEventListener?.("pagehide", onHide);
    try {
      for (let i = 0; ; i++) {
        try {
          await client.copilotClose(id); // a 404 (already gone) counts as closed
          return;
        } catch (e) {
          const wait = CLOSE_RETRY_WAITS_S[i];
          if (copilotErrorKind(e) !== "conflict" || wait === undefined) return;
        }
        await pause(CLOSE_RETRY_WAITS_S[i]! * 1000, unload.signal);
      }
    } catch {
      // unloaded while waiting
    } finally {
      globalThis.removeEventListener?.("pagehide", onHide);
    }
  }

  /** Forgets the current session and closes it on the server (at most once per session). */
  function retire(): Promise<void> {
    const old = live;
    live = null;
    return old ? closeSession(old.id, inflight) : Promise.resolve();
  }

  /** One request, retried after a 503 with Retry-After at most BUSY_RETRIES times; stops at once on abort. */
  async function request<T>(send: () => Promise<T>, signal: AbortSignal, late?: (v: T) => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new CopilotAborted();
      const p = send();
      inflight = p;
      try {
        return await raced(p, signal, late);
      } catch (e) {
        const wait = e instanceof CopilotError || copilotErrorKind(e) !== "busy" || attempt >= BUSY_RETRIES ? null : busyWaitMs(e);
        if (wait === null) throw e;
        await pause(wait, signal);
      }
    }
  }

  /**
   * Starts a session for `runId` on the session-lifetime signal: only close() ends it, never one caller's abort. A
   * session that arrives after close(), or for a run that is no longer current, is closed at once.
   */
  async function start(runId: string | undefined): Promise<Live> {
    let s;
    try {
      s = await request(() => client.copilotStart(runId), life.signal, (late) => void closeSession(late.session_id, Promise.resolve()));
    } catch (e) {
      if (disposed) throw new CopilotError("closed");
      if (copilotErrorKind(e) === "session_lost") throw new CopilotError("run_not_found", (e as ApiError).requestId);
      throw e;
    }
    const fresh: Live = { id: s.session_id, runId, limits: s.limits };
    if (disposed) {
      // close() landed between the response and here: nobody may use this session.
      void closeSession(fresh.id, Promise.resolve());
      throw new CopilotError("closed");
    }
    if (runId !== currentRunId()) void closeSession(fresh.id, Promise.resolve()); // its caller re-opens
    else {
      if (live && live !== fresh) void retire();
      live = fresh;
    }
    return fresh;
  }

  /** The current session, starting one if needed; each caller waits on its own signal. */
  function open(signal: AbortSignal): Promise<Live> {
    if (disposed) return Promise.reject(new CopilotError("closed"));
    if (signal.aborted) return Promise.reject(new CopilotAborted());
    if (live) return Promise.resolve(live);
    const runId = currentRunId();
    if (!opening || opening.runId !== runId) {
      // A start for another run is never joined; it closes its own session when it arrives.
      const promise: Promise<Live> = start(runId).finally(() => { if (opening?.promise === promise) opening = null; });
      opening = { runId, promise };
    }
    return raced(opening.promise, signal);
  }

  /** A session for the run that is current now; re-opens (at most MAX_REOPENS times) when the run changed meanwhile. */
  async function openCurrent(signal: AbortSignal): Promise<{ s: Live; reopened: boolean }> {
    for (let i = 0; ; i++) {
      const s = await open(signal);
      if (live === s && s.runId === currentRunId()) return { s, reopened: i > 0 };
      if (live === s) void retire(); // never run a turn on the previous run's session
      if (i >= MAX_REOPENS) throw new CopilotError("run_changed");
    }
  }

  /** Runs one tool; any throw becomes a fixed failure, and the result always answers this call's id. */
  async function runOne(call: ToolCall, limits: CopilotLimits, signal: AbortSignal): Promise<ToolResult> {
    try {
      const r = await runTool(deps.run, call, limits, signal);
      return { call_id: call.id, ok: r.ok === true, content: r.content };
    } catch {
      return { call_id: call.id, ok: false, content: { message: TOOL_FAILED } };
    }
  }

  /**
   * Posts the user's message after the previous request has settled. A 409 here means the session's previous step
   * still runs on the server (a stopped turn whose request timed out): wait and re-post, a bounded number of times.
   */
  async function postMessage(s: Live, text: string, signal: AbortSignal): Promise<StepOut> {
    await raced(inflight.then(noop, noop), signal);
    for (let i = 0; ; i++) {
      try {
        return await request(() => client.copilotStep(s.id, { user_message: text }), signal);
      } catch (e) {
        if (e instanceof CopilotError || copilotErrorKind(e) !== "conflict") throw e;
        const wait = STEP_RUNNING_WAITS_S[i];
        if (wait === undefined) throw new CopilotError("step_running", (e as ApiError).requestId);
        await pause(wait * 1000, signal);
      }
    }
  }

  /** Posts one round's results (split by size); returns the answer to the last post. */
  async function post(s: Live, results: ToolResult[], signal: AbortSignal): Promise<StepOut> {
    const chunks = splitResults(results, maxBytes);
    let out: StepOut | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const tool_results = chunks[i]!;
      out = await request(() => client.copilotStep(s.id, { tool_results }), signal);
      const rest = chunks.slice(i + 1).flat().map((r) => r.call_id);
      // A partial answer gets exactly the still-unanswered calls back; anything else means the two sides disagree.
      if (rest.length && (out.status !== "tool_calls" || !sameIds(out.tool_calls.map((c) => c.id), rest))) throw new CopilotError("conflict");
    }
    if (!out) throw new CopilotError("protocol");
    return out;
  }

  async function converse(s: Live, text: string, signal: AbortSignal): Promise<Omit<TurnResult, "restarted">> {
    const read: ReadLogEntry[] = [];
    let rounds = 0;
    let out = await postMessage(s, text, signal);
    while (out.status === "tool_calls") {
      if (rounds >= maxSteps) return { text: "", proposedChanges: [], proposedWrites: [], notes: [stepCapNote(maxSteps)], read };
      if (!out.tool_calls.length) throw new CopilotError("protocol");
      rounds += 1;
      const results: ToolResult[] = [];
      for (const call of out.tool_calls) {
        if (signal.aborted) throw new CopilotAborted();
        const r = await raced(runOne(call, s.limits, signal), signal);
        results.push(r);
        read.push(readLogEntry(call, r));
      }
      out = await post(s, results, signal);
    }
    if (out.status !== "final") throw new CopilotError("protocol");
    return { text: out.text, proposedChanges: out.proposed_changes, proposedWrites: out.proposed_writes, notes: out.notes, read };
  }

  async function runTurn(text: string, signal: AbortSignal): Promise<TurnResult> {
    let restarted = false;
    if (live && live.runId !== currentRunId()) {
      void retire(); // never reuse a session across runs
      restarted = true;
    }
    for (let lost = 0; ; lost++) {
      const { s, reopened } = await openCurrent(signal);
      if (reopened) restarted = true;
      try {
        // A restarted attempt starts its read log and round count afresh: the lost session's reads are not repeated.
        return { ...(await converse(s, text, signal)), restarted };
      } catch (e) {
        if (signal.aborted || copilotErrorKind(e) !== "session_lost") throw e;
        if (live === s) live = null; // already gone on the server: nothing to close
        if (lost >= 1) throw new CopilotError("session_lost", (e as ApiError).requestId);
        restarted = true; // the user's message goes again, to a new session
      }
    }
  }

  return {
    get sessionId() {
      return live?.id;
    },

    get limits() {
      return live?.limits;
    },

    async ensureSession(signal?: AbortSignal): Promise<string> {
      try {
        return (await openCurrent(signal ?? new AbortController().signal)).s.id;
      } catch (e) {
        throw asCopilotError(e);
      }
    },

    async send(text: string, opts: { signal?: AbortSignal } = {}): Promise<TurnResult> {
      if (disposed) throw new CopilotError("closed");
      if (turn) throw new CopilotBusy();
      const ctl = new AbortController();
      turn = ctl;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, turnTimeoutMs);
      const caller = opts.signal;
      const onCaller = () => ctl.abort();
      if (caller?.aborted) ctl.abort();
      else caller?.addEventListener("abort", onCaller, { once: true });
      try {
        return await runTurn(text, ctl.signal);
      } catch (e) {
        if (ctl.signal.aborted) throw timedOut ? new CopilotError("turn_timeout") : new CopilotAborted();
        throw asCopilotError(e);
      } finally {
        clearTimeout(timer);
        caller?.removeEventListener("abort", onCaller);
        if (turn === ctl) turn = null;
      }
    },

    stop(): void {
      turn?.abort();
      turn = null;
    },

    close(): Promise<void> {
      disposed = true;
      turn?.abort();
      turn = null;
      life.abort();
      return retire();
    },
  };
}

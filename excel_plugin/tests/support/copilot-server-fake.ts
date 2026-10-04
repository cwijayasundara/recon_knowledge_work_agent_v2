// Test-only port of the Copilot server's session and step semantics (routes.py, engine.py step/_loop/_dispatch/_final,
// schemas.py StepIn/ToolResultIn, sessions.py), in the server's order of checks:
//   403 disabled -> 413 body size -> 422 body validation -> injected failure (admission: 503 before any state change)
//   -> 404 unknown session -> 409 step already running -> engine.
// Pending calls are an insertion-ordered map; a tool_results body with an unknown or already answered id is a 409; a
// partial answer returns the still-pending calls; a user_message closes pending calls and drops the interrupted turn's
// proposals with DISCARDED_NOTE; proposals are delivered only with a final answer (the step-limit final included);
// at most 16 client calls are forwarded per model step (the rest are answered inline as errors); a turn ends after
// `maxStepsPerTurn` model steps (8 by default) with the step-limit final.
import { ApiError } from "../../src/api/client";
import { isHiddenChar } from "../../src/copilot/rules";
import type { CopilotChange, CopilotLimits, CopilotStart, StepOut, ToolCall, ToolResult, WriteProposal } from "../../src/copilot/types";

export const DISCARDED_NOTE = "Earlier proposals were discarded because the request was interrupted.";
export const STEP_LIMIT_TEXT = "I stopped at the step limit for this message.";
export const STEP_LIMIT_NOTE = "step limit reached";
export const LIMITS: CopilotLimits = { max_cells_per_call: 2000, max_cells_per_session: 20000, max_steps_per_turn: 8, max_write_cells: 2000, cell_char_limit: 500 };
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 32;
const MAX_CLIENT_CALLS_PER_STEP = 16;
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_CONTENT_DEPTH = 8;

export interface Reply {
  calls?: { name: string; args?: Record<string, unknown> }[];
  text?: string;
  notes?: string[];
  /** Proposals the model makes in this model step; held until a final answer. */
  changes?: CopilotChange[];
  writes?: WriteProposal[];
}

export interface ModelInput {
  session: string;
  /** Model steps so far in this session (0 for the first). */
  step: number;
  /** User messages in this session. */
  messages: string[];
  /** Results answered since the last model step, in the order they arrived. */
  results: ToolResult[];
}

export type Model = (input: ModelInput) => Reply;

interface Sess {
  id: string;
  runId: string | undefined;
  pending: Map<string, ToolCall>;
  messages: string[];
  answered: ToolResult[];
  /** Results the server answered inline (calls over the per-step cap). */
  inline: ToolResult[];
  steps: number;
  stepsInTurn: number;
  changes: CopilotChange[];
  writes: WriteProposal[];
  notes: string[];
  busy: boolean;
}

export interface Req {
  kind: "start" | "step" | "close";
  session?: string;
  runId?: string;
  body?: unknown;
  bytes?: number;
}

type Kind = Req["kind"];
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const err = (status: number, detail: string, retryAfter?: number) => {
  const e = new ApiError(detail, status, "req-1");
  if (retryAfter !== undefined) e.retryAfterSeconds = retryAfter;
  return e;
};
const bad = (detail: string) => err(422, detail);

/**
 * Python's len(json.dumps(v)) (ensure_ascii, ", " and ": " separators), implemented apart from the client's
 * pyJsonLength so the fake can catch a client bug: leaves via JSON.stringify (its escapes match Python's for control
 * characters, quotes, backslashes and lone surrogates), every non-ASCII or DEL UTF-16 unit then counted as \uXXXX.
 */
function pythonJsonLength(v: unknown): number {
  if (Array.isArray(v)) return 2 + v.reduce((n: number, x, i) => n + pythonJsonLength(x) + (i ? 2 : 0), 0);
  if (isRecord(v)) return 2 + Object.entries(v).reduce((n, [k, x], i) => n + pythonJsonLength(k) + 2 + pythonJsonLength(x) + (i ? 2 : 0), 0);
  const text = JSON.stringify(v) ?? "null";
  let n = 0;
  for (let i = 0; i < text.length; i++) n += text.charCodeAt(i) >= 0x7f ? 6 : 1;
  return n;
}

/** _check_content: JSON types only, nesting below MAX_CONTENT_DEPTH, json.dumps size within MAX_CONTENT_BYTES. */
function checkContent(content: unknown): void {
  const stack: [unknown, number][] = [[content, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (Array.isArray(node) || isRecord(node)) {
      if (depth >= MAX_CONTENT_DEPTH) throw bad("content is nested too deeply");
      for (const v of Array.isArray(node) ? node : Object.values(node)) stack.push([v, depth + 1]);
    } else if (typeof node === "number" && !Number.isFinite(node)) throw bad("content must not contain NaN or Infinity");
    else if (node !== null && !["string", "number", "boolean"].includes(typeof node)) throw bad("content must be JSON");
  }
  if (pythonJsonLength(content) > MAX_CONTENT_BYTES) throw bad("content is too large");
}

/** StepIn: exactly one of user_message (1-8000 chars, no hidden characters) or tool_results (1-32, unique ids). */
function validate(body: unknown): { user_message: string } | { tool_results: ToolResult[] } {
  if (!isRecord(body) || Object.keys(body).some((k) => k !== "user_message" && k !== "tool_results")) throw bad("unknown field");
  const { user_message: msg, tool_results: results } = body;
  if ((msg === undefined || msg === null) === (results === undefined || results === null)) throw bad("provide exactly one of user_message or tool_results");
  if (msg !== undefined && msg !== null) {
    if (typeof msg !== "string") throw bad("user_message must be a string");
    const v = msg.replace(/\r\n/g, "\n").trim();
    // Code points, as Python sees the string: a paired surrogate is one character, only a lone one is refused.
    const chars = [...v];
    if (chars.some((ch) => (ch.length === 1 && /[\ud800-\udfff]/.test(ch)) || (isHiddenChar(ch) && ch !== "\n" && ch !== "\t"))) throw bad("user_message has control characters");
    if (chars.length < 1 || chars.length > 8000) throw bad("user_message must be 1-8000 characters");
    return { user_message: v };
  }
  if (!Array.isArray(results) || results.length < 1 || results.length > MAX_RESULTS) throw bad("tool_results must have 1-32 items");
  for (const r of results) {
    if (!isRecord(r) || typeof r.call_id !== "string" || typeof r.ok !== "boolean") throw bad("invalid tool result");
    checkContent(r.content);
  }
  const ids = results.map((r: ToolResult) => r.call_id);
  if (new Set(ids).size !== ids.length) throw bad("duplicate call_id");
  return { tool_results: results as ToolResult[] };
}

export interface ServerOptions {
  disabled?: boolean;
  maxSessions?: number;
  /** Runs that exist; a start for any other run is a 404. Unset: every run exists. */
  runs?: string[];
  /** copilot_max_steps_per_turn (8 on the real server). */
  maxStepsPerTurn?: number;
}

export { pythonJsonLength };

export function createServerFake(model: Model, opts: ServerOptions = {}) {
  const sessions = new Map<string, Sess>();
  const requests: Req[] = [];
  const failures: Record<Kind, unknown[]> = { start: [], step: [], close: [] };
  const holds: Record<Kind, Promise<void>[]> = { start: [], step: [], close: [] };
  const maxStepsPerTurn = opts.maxStepsPerTurn ?? 8;
  let nextSession = 0;
  let nextCall = 0;

  function hold(kind: Kind): () => void {
    let release!: () => void;
    holds[kind].push(new Promise<void>((r) => { release = r; }));
    return release;
  }

  const enabled = () => { if (opts.disabled) throw err(403, "copilot is disabled"); };
  const admit = (kind: Kind) => {
    const f = failures[kind].shift();
    if (f !== undefined) throw f;
  };
  const held = async (kind: Kind) => { const h = holds[kind].shift(); if (h) await h; };

  function final(s: Sess, text: string, notes: string[]): StepOut {
    const out: StepOut = { status: "final", tool_calls: [], text, proposed_changes: s.changes, proposed_writes: s.writes, notes: [...notes, ...s.notes] };
    s.changes = [];
    s.writes = [];
    s.notes = [];
    return out;
  }

  function loop(s: Sess): StepOut {
    for (;;) {
      if (s.stepsInTurn >= maxStepsPerTurn) return final(s, STEP_LIMIT_TEXT, [STEP_LIMIT_NOTE]);
      s.stepsInTurn += 1;
      const reply = model({ session: s.id, step: s.steps, messages: [...s.messages], results: s.answered });
      s.steps += 1;
      s.answered = [];
      s.changes.push(...(reply.changes ?? []));
      s.writes.push(...(reply.writes ?? []));
      if (!reply.calls?.length) return final(s, reply.text ?? "", reply.notes ?? []);
      const client: ToolCall[] = [];
      for (const c of reply.calls) {
        const call = { id: `call_${++nextCall}`, name: c.name, args: c.args ?? {} };
        if (client.length >= MAX_CLIENT_CALLS_PER_STEP) {
          s.inline.push({ call_id: call.id, ok: false, content: { error: "too many workbook tool calls in one step; ask for fewer at a time" } });
          continue;
        }
        s.pending.set(call.id, call);
        client.push(call);
      }
      return { status: "tool_calls", tool_calls: client, text: "", proposed_changes: [], proposed_writes: [], notes: [] };
    }
  }

  function step(s: Sess, body: { user_message: string } | { tool_results: ToolResult[] }): StepOut {
    if ("tool_results" in body) {
      if (body.tool_results.some((r) => !s.pending.has(r.call_id))) throw err(409, "unknown or already answered call id");
      for (const r of body.tool_results) {
        s.pending.delete(r.call_id);
        s.answered.push(r);
      }
      if (s.pending.size) return { status: "tool_calls", tool_calls: [...s.pending.values()], text: "", proposed_changes: [], proposed_writes: [], notes: [] };
    } else {
      s.pending.clear(); // _close_pending: the unanswered calls get "no result was returned"
      const interrupted = s.changes.length > 0 || s.writes.length > 0;
      s.changes = [];
      s.writes = [];
      s.notes = interrupted ? [DISCARDED_NOTE] : [];
      s.answered = [];
      s.messages.push(body.user_message);
      s.stepsInTurn = 0;
    }
    return loop(s);
  }

  const client = {
    async copilotStart(runId?: string): Promise<CopilotStart> {
      requests.push({ kind: "start", ...(runId !== undefined ? { runId } : {}) });
      enabled();
      admit("start");
      await held("start");
      if (runId !== undefined && opts.runs && !opts.runs.includes(runId)) throw err(404, "run not found");
      if (sessions.size >= (opts.maxSessions ?? 5)) throw err(429, "too many copilot sessions");
      const id = `sess_${++nextSession}`;
      sessions.set(id, { id, runId, pending: new Map(), messages: [], answered: [], inline: [], steps: 0, stepsInTurn: 0, changes: [], writes: [], notes: [], busy: false });
      return { session_id: id, limits: LIMITS, tools: [], run_bound: runId !== undefined };
    },
    async copilotStep(sessionId: string, body: unknown): Promise<StepOut> {
      const bytes = bytesOf(body);
      requests.push({ kind: "step", session: sessionId, body: structuredClone(body), bytes });
      enabled();
      if (bytes > MAX_BODY_BYTES) throw err(413, "request too large");
      const valid = validate(body);
      admit("step");
      const s = sessions.get(sessionId);
      if (!s) throw err(404, "session not found");
      if (s.busy) throw err(409, "a step is already running for this session");
      s.busy = true;
      try {
        await held("step"); // the step runs (a model call) while held
        if (!sessions.has(sessionId)) throw err(404, "session not found");
        return step(s, valid);
      } finally {
        s.busy = false;
      }
    },
    async copilotClose(sessionId: string): Promise<void> {
      requests.push({ kind: "close", session: sessionId });
      enabled();
      admit("close");
      await held("close");
      const s = sessions.get(sessionId);
      if (s?.busy) throw err(409, "a step is running");
      sessions.delete(sessionId); // a missing session is already closed (client.copilotClose swallows the 404)
    },
  };

  return {
    client,
    requests,
    sessions,
    hold,
    /** The next request of this kind fails with `e` at admission: before any session state is read or changed. */
    fail(kind: Kind, e: unknown) { failures[kind].push(e); },
    /** The session expires (a later step on it is a 404). */
    expire(id: string) { sessions.delete(id); },
    steps: () => requests.filter((r) => r.kind === "step"),
    of: (kind: Kind) => requests.filter((r) => r.kind === kind),
    err,
  };
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, RequestTimeout } from "../../src/api/client";
import type { ExcelRun } from "../../src/office/highlight";
import {
  CopilotAborted, CopilotBusy, CopilotDisabled, CopilotError, MAX_RESULT_CONTENT_BYTES, RESULT_TOO_LARGE, pyJsonLength, TOOL_FAILED, createCopilotSession, readLogEntry, splitResults, stepCapNote,
  type CopilotSessionDeps,
} from "../../src/copilot/session";
import type { runClientTool } from "../../src/copilot/tools";
import type { CopilotChange, ToolCall, ToolResult, WriteProposal } from "../../src/copilot/types";
import { createCopilotFake } from "../support/copilot-fake";
import { DISCARDED_NOTE, LIMITS, STEP_LIMIT_NOTE, STEP_LIMIT_TEXT, createServerFake, pythonJsonLength, type Model, type Reply } from "../support/copilot-server-fake";

type RunTool = typeof runClientTool;
const SENTINEL = "SENTINEL-7f3a";
const CHANGE: CopilotChange = { kind: "exclude_row", row: 3, reason: "dup" };
const WRITE: WriteProposal = { sheet: "Copilot", range: "A1", values: [[1]], note: "n" };
const noRun = (() => Promise.reject(new Error("no Excel"))) as unknown as ExcelRun;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Replies in order (the last repeats); each model step takes the next. */
const script = (...replies: Reply[]): Model => (i) => replies[Math.min(i.step, replies.length - 1)]!;
const always = (reply: Reply): Model => () => reply;

/** A tool that answers {echo: name} at once and records what it ran. */
function echoTool() {
  const ran: ToolCall[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const tool: RunTool = async (_run, call, _limits, signal) => {
    ran.push(call);
    signals.push(signal);
    return { call_id: call.id, ok: true, content: { echo: call.name } };
  };
  return { tool, ran, signals };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(model: Model, deps: Partial<CopilotSessionDeps> = {}, opts: Parameters<typeof createServerFake>[1] = {}) {
  const server = createServerFake(model, opts);
  const echo = echoTool();
  const session = createCopilotSession({ client: server.client, run: noRun, runTool: echo.tool, ...deps });
  return { server, session, ...echo };
}

const results = (body: unknown): ToolResult[] => (body as { tool_results: ToolResult[] }).tool_results;
const has = (body: unknown, key: "tool_results" | "user_message"): boolean => typeof body === "object" && body !== null && key in body;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("loop", () => {
  test("happy loop with the real Excel tools: list_sheets, read_range, final", async () => {
    const excel = createCopilotFake({ Data: { cells: [["Name", "Code"], ["Alpha", 1]] } });
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const server = createServerFake(script(
      { calls: [{ name: "list_sheets" }] },
      { calls: [{ name: "read_range", args: { sheet: "Data", range: "A1:B2" } }] },
      { text: "Two rows.", notes: ["n1"], changes: [CHANGE], writes: [WRITE] },
    ));
    const session = createCopilotSession({ client: server.client, run: excel.run as unknown as ExcelRun });
    expect(session.sessionId).toBeUndefined();
    const out = await session.send("what is here?");
    expect(out).toEqual({
      text: "Two rows.", proposedChanges: [CHANGE], proposedWrites: [WRITE], notes: ["n1"], restarted: false,
      read: [{ tool: "list_sheets", cells: 1, ok: true }, { tool: "read_range", sheet: "Data", range: "A1:B2", cells: 4, ok: true }],
    });
    expect(server.requests.map((r) => r.kind)).toEqual(["start", "step", "step", "step"]);
    expect(server.steps()[0]!.body).toEqual({ user_message: "what is here?" });
    expect(results(server.steps()[2]!.body)[0]!.content).toMatchObject({ values: [["Name", "Code"], ["Alpha", 1]] });
    expect(session.sessionId).toBe("sess_1");
    expect(excel.writes).toEqual([]);
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  test("the session starts lazily and is reused across turns", async () => {
    const { server, session } = setup(always({ text: "ok" }));
    expect(server.requests).toEqual([]);
    await session.send("a");
    await session.send("b");
    expect(server.of("start")).toHaveLength(1);
    expect(server.steps().map((r) => r.session)).toEqual(["sess_1", "sess_1"]);
  });

  test("limits are the live session's: undefined before a start and after close", async () => {
    const { session } = setup(always({ text: "ok" }));
    expect(session.limits).toBeUndefined();
    await session.ensureSession();
    expect(session.limits).toEqual(LIMITS);
    await session.close();
    expect(session.limits).toBeUndefined();
  });

  test("ensureSession starts once for concurrent callers and returns the id", async () => {
    const { server, session } = setup(always({ text: "ok" }), { runId: "run-1" });
    expect(await Promise.all([session.ensureSession(), session.ensureSession()])).toEqual(["sess_1", "sess_1"]);
    expect(server.of("start")).toEqual([{ kind: "start", runId: "run-1" }]);
    await session.send("a");
    expect(server.of("start")).toHaveLength(1);
  });

  test("calls run sequentially and their results are posted in call order in one request", async () => {
    const order: string[] = [];
    const tool: RunTool = async (_run, call) => {
      order.push(`start ${call.id}`);
      await new Promise((r) => setTimeout(r, call.id === "call_1" ? 10 : 1));
      order.push(`end ${call.id}`);
      return { call_id: call.id, ok: true, content: { sheets: [call.id] } };
    };
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }, { name: "list_sheets" }, { name: "list_sheets" }] }, { text: "done" }), { runTool: tool });
    await session.send("go");
    expect(order).toEqual(["start call_1", "end call_1", "start call_2", "end call_2", "start call_3", "end call_3"]);
    const posts = server.steps().filter((r) => has(r.body, "tool_results"));
    expect(posts).toHaveLength(1);
    expect(results(posts[0]!.body).map((r) => r.call_id)).toEqual(["call_1", "call_2", "call_3"]);
  });

  test("the step cap stops with a note and returns what was collected", async () => {
    const { server, session, ran } = setup(always({ calls: [{ name: "list_sheets" }], changes: [CHANGE] }), { maxClientSteps: 3 });
    const out = await session.send("loop forever");
    expect(out).toEqual({ text: "", proposedChanges: [], proposedWrites: [], notes: [stepCapNote(3)], read: Array(3).fill({ tool: "list_sheets", cells: 0, ok: true }), restarted: false });
    expect(stepCapNote(3)).toBe("Stopped after 3 tool rounds.");
    expect(ran).toHaveLength(3);
    expect(server.steps()).toHaveLength(4); // the message and three rounds of results
  });

  test("the real server ends a turn after 8 model steps: its step-limit final carries the turn's proposals", async () => {
    const { ran, session } = setup(always({ calls: [{ name: "list_sheets" }], changes: [CHANGE] }));
    const out = await session.send("x");
    expect(out).toMatchObject({ text: STEP_LIMIT_TEXT, notes: [STEP_LIMIT_NOTE], proposedChanges: Array(8).fill(CHANGE) });
    expect(ran).toHaveLength(8);
  });

  test("the default client cap is 12 rounds (a backstop: reachable only with a server allowing more steps per turn)", async () => {
    const { ran, session } = setup(always({ calls: [{ name: "list_sheets" }] }), {}, { maxStepsPerTurn: 100 });
    expect((await session.send("x")).notes).toEqual([stepCapNote(12)]);
    expect(ran).toHaveLength(12);
  });

  test("the server forwards at most 16 client calls per step; the driver answers exactly those", async () => {
    const calls = Array.from({ length: 20 }, () => ({ name: "list_sheets" }));
    const { server, session, ran } = setup(script({ calls }, { text: "ok" }));
    expect((await session.send("x")).text).toBe("ok");
    expect(ran).toHaveLength(16);
    expect(results(server.steps()[1]!.body)).toHaveLength(16);
  });

  test("proposals arrive only with the final answer; an interrupted turn's proposals are dropped by the server", async () => {
    const model: Model = (i) => (i.messages.length === 1 ? { calls: [{ name: "list_sheets" }], changes: [CHANGE] } : { text: "second", writes: [WRITE] });
    const { session } = setup(model, { maxClientSteps: 2 });
    const capped = await session.send("first");
    expect(capped.proposedChanges).toEqual([]);
    const next = await session.send("second");
    expect(next).toMatchObject({ text: "second", proposedChanges: [], proposedWrites: [WRITE], notes: [DISCARDED_NOTE] });
  });

  test("a final answer passes text, proposals and notes through", async () => {
    const { session } = setup(script({ calls: [{ name: "find", args: { text: "x" } }], changes: [CHANGE] }, { text: "t", notes: ["a", "b"], writes: [WRITE] }));
    expect(await session.send("x")).toMatchObject({ text: "t", proposedChanges: [CHANGE], proposedWrites: [WRITE], notes: ["a", "b"] });
  });

  test("an empty tool_calls answer is a protocol error, not a stall", async () => {
    const server = createServerFake(always({ text: "x" }));
    const session = createCopilotSession({
      client: { ...server.client, copilotStep: async () => ({ status: "tool_calls", tool_calls: [], text: "", proposed_changes: [], proposed_writes: [], notes: [] }) },
      run: noRun,
    });
    await expect(session.send("x")).rejects.toMatchObject({ kind: "protocol" });
  });

  test("an unknown status is a protocol error", async () => {
    const server = createServerFake(always({ text: "x" }));
    const session = createCopilotSession({ client: { ...server.client, copilotStep: async () => ({ status: "odd" }) as never }, run: noRun });
    await expect(session.send("x")).rejects.toMatchObject({ kind: "protocol" });
  });
});

describe("tool failures never escape the loop", () => {
  test("a failed result is posted as ok:false", async () => {
    const tool: RunTool = async (_r, call) => ({ call_id: call.id, ok: false, content: { message: "sheet not found" } });
    const { server, session } = setup(script({ calls: [{ name: "describe_sheet", args: { sheet: "Nope" } }] }, { text: "sorry" }), { runTool: tool });
    const out = await session.send("x");
    expect(results(server.steps()[1]!.body)).toEqual([{ call_id: "call_1", ok: false, content: { message: "sheet not found" } }]);
    expect(out.read).toEqual([{ tool: "describe_sheet", sheet: "Nope", cells: 0, ok: false }]);
  });

  test("a throwing executor becomes ok:false 'tool failed' with no raw error text", async () => {
    const tool: RunTool = async () => { throw new Error(`boom ${SENTINEL}`); };
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }, { name: "get_selection" }] }, { text: "ok" }), { runTool: tool });
    const out = await session.send("x");
    expect(results(server.steps()[1]!.body)).toEqual([
      { call_id: "call_1", ok: false, content: { message: TOOL_FAILED } },
      { call_id: "call_2", ok: false, content: { message: TOOL_FAILED } },
    ]);
    expect(JSON.stringify(server.requests) + JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test("a result always answers its own call id", async () => {
    const tool: RunTool = async () => ({ call_id: "wrong", ok: true, content: { sheets: [] } });
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "ok" }), { runTool: tool });
    await session.send("x");
    expect(results(server.steps()[1]!.body)[0]!.call_id).toBe("call_1");
  });

  test("the abort signal is passed to every tool", async () => {
    const { session, signals } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "ok" }));
    await session.send("x");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("splitting large results", () => {
  const big = (id: string, n: number): ToolResult => ({ call_id: id, ok: true, content: { values: [["x".repeat(n)]] } });

  test("several large results go in several posts in call order, each within the byte cap", async () => {
    const tool: RunTool = async (_r, call) => big(call.id, 700);
    const model = script({ calls: [{ name: "list_sheets" }, { name: "list_sheets" }, { name: "list_sheets" }, { name: "list_sheets" }] }, { text: "done" });
    const { server, session } = setup(model, { runTool: tool, maxBodyBytes: 1600 });
    const out = await session.send("x");
    expect(out.text).toBe("done");
    const posts = server.steps().slice(1);
    expect(posts.length).toBe(2);
    for (const p of posts) expect(p.bytes).toBeLessThanOrEqual(1600);
    expect(posts.flatMap((p) => results(p.body).map((r) => r.call_id))).toEqual(["call_1", "call_2", "call_3", "call_4"]);
    expect(posts.flatMap((p) => results(p.body).map((r) => r.ok))).toEqual([true, true, true, true]);
  });

  test("one oversize result is replaced by 'result too large'; the others are posted as they are", async () => {
    const tool: RunTool = async (_r, call) => big(call.id, call.id === "call_2" ? 5000 : 100);
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }, { name: "list_sheets" }, { name: "list_sheets" }] }, { text: "done" }), { runTool: tool, maxBodyBytes: 1000 });
    await session.send("x");
    const posted = server.steps().slice(1).flatMap((p) => results(p.body));
    expect(posted.map((r) => r.call_id)).toEqual(["call_1", "call_2", "call_3"]);
    expect(posted[1]).toEqual({ call_id: "call_2", ok: false, content: { message: RESULT_TOO_LARGE } });
    expect(posted[0]!.ok && posted[2]!.ok).toBe(true);
  });

  test("a partial post's answer that is not exactly the remaining calls is a conflict", async () => {
    const server = createServerFake(always({ text: "x" }));
    let n = 0;
    const tool: RunTool = async (_r, call) => big(call.id, 700);
    const step = vi.fn(async (_id: string, body: { tool_results?: ToolResult[] }) => {
      n += 1;
      if (n === 1) return { status: "tool_calls" as const, tool_calls: [{ id: "c1", name: "list_sheets", args: {} }, { id: "c2", name: "list_sheets", args: {} }], text: "", proposed_changes: [], proposed_writes: [], notes: [] };
      expect(body.tool_results).toBeDefined();
      return { status: "final" as const, tool_calls: [], text: "early", proposed_changes: [], proposed_writes: [], notes: [] };
    });
    const session = createCopilotSession({ client: { ...server.client, copilotStep: step as never }, run: noRun, runTool: tool, maxBodyBytes: 1000 });
    await expect(session.send("x")).rejects.toMatchObject({ kind: "conflict" });
    expect(step).toHaveBeenCalledTimes(2); // nothing more is posted
  });

  test("a result over the server's 1 MB per-result cap (ensure_ascii JSON) is replaced though its UTF-8 body fits", async () => {
    const cjk = "\u6f22".repeat(200_000); // 600 KB as UTF-8, 1.2 MB as ensure_ascii JSON
    const tool: RunTool = async (_r, call) => ({ call_id: call.id, ok: true, content: { values: [[cjk]] } });
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "done" }), { runTool: tool });
    expect((await session.send("x")).text).toBe("done");
    expect(results(server.steps()[1]!.body)).toEqual([{ call_id: "call_1", ok: false, content: { message: RESULT_TOO_LARGE } }]);
    expect(pyJsonLength({ values: [[cjk]] })).toBeGreaterThan(MAX_RESULT_CONTENT_BYTES);
    expect(new TextEncoder().encode(JSON.stringify({ values: [[cjk]] })).length).toBeLessThan(1_500_000);
  });

  // Expected lengths generated with real Python in the repo root:
  //   uv run python -c 'import json; print(len(json.dumps(v, ensure_ascii=True)))' for each value below.
  const PY_JSON_LENGTHS: [string, unknown, number][] = [
    ["DEL", "\x7f", 8],
    ["C0 controls", "\x00\x01\x1f", 20],
    ["named escapes", "\b\f\n\r\t", 12],
    ["quote and backslash", '"\\', 6],
    ["non-BMP emoji", "\u{1F600}", 14],
    ["lone high surrogate", "\ud800", 8],
    ["lone low surrogate", "\udfff", 8],
    ["BMP CJK", "\u6f22\u5b57", 14],
    ["latin-1", "\u00e9", 8],
    ["ascii with <>&", "abc <>&", 9],
    ["empty list", [], 2],
    ["empty object", {}, 2],
    ["mixed", [{ k: "\x7f\u{1F600}" }, ["x", ["y"]]], 43],
  ];
  // Numbers are over-counted by 2 each (Python's repr can be longer: 1.0, 1e-07); exact otherwise.
  const PY_JSON_WITH_NUMBERS: [string, unknown, number, number][] = [
    ["nested", { a: [1, true, null, false, "s"], b: { c: [] }, d: {} }, 59, 1],
    ["numbers", [0, -1, 12345, 1.5, -0.25], 26, 5],
  ];

  test.each(PY_JSON_LENGTHS)("pyJsonLength matches Python's json.dumps: %s", (_name, value, expected) => {
    expect(pyJsonLength(value)).toBe(expected);
  });

  test.each(PY_JSON_WITH_NUMBERS)("pyJsonLength over-counts numbers by 2 each: %s", (_name, value, python, numbers) => {
    expect(pyJsonLength(value)).toBe(python + 2 * numbers);
  });

  test.each(PY_JSON_LENGTHS)("the server fake's own size check matches Python too: %s", (_name, value, expected) => {
    expect(pythonJsonLength(value)).toBe(expected);
  });

  test.each(PY_JSON_WITH_NUMBERS)("the server fake's size check is exact for numbers: %s", (_name, value, python) => {
    expect(pythonJsonLength(value)).toBe(python);
  });

  test("pyJsonLength edge values", () => {
    expect(pyJsonLength({ u: undefined })).toBe(2);
    expect(pyJsonLength(Number.NaN)).toBe(4);
    expect(pyJsonLength(Symbol("x"))).toBe(4);
  });

  test("at most 32 results per post", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ call_id: `c${i}`, ok: true, content: null }));
    expect(splitResults(many, 1_000_000).map((c) => c.length)).toEqual([32, 8]);
    expect(splitResults([], 100)).toEqual([]);
  });
});

describe("server errors", () => {
  test("403 on start is CopilotDisabled", async () => {
    const { session } = setup(always({ text: "x" }), {}, { disabled: true });
    const e = await session.send("x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CopilotDisabled);
    expect(e).toMatchObject({ kind: "disabled" });
  });

  test("403 on a step is CopilotDisabled", async () => {
    const { server, session } = setup(always({ text: "x" }));
    server.fail("step", server.err(403, "copilot is disabled"));
    await expect(session.send("x")).rejects.toBeInstanceOf(CopilotDisabled);
  });

  test.each([
    [429, "too_many", "start"],
    [413, "too_large", "step"],
    [415, "bad_request", "step"],
    [422, "bad_request", "step"],
    [500, "other", "step"],
  ] as const)("%i is surfaced as %s without a retry", async (status, kind, where) => {
    const { server, session } = setup(always({ text: "x" }));
    server.fail(where, server.err(status, `detail ${SENTINEL}`));
    const e = (await session.send("x").catch((x: unknown) => x)) as CopilotError;
    expect(e).toBeInstanceOf(CopilotError);
    expect(e.kind).toBe(kind);
    expect(e.message).not.toContain(SENTINEL);
    expect(server.of(where)).toHaveLength(1);
  });

  test("a 409 on the user message (the previous step still runs) waits 2 s then 5 s, then surfaces step_running", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "x" }));
    for (let i = 0; i < 3; i++) server.fail("step", server.err(409, "a step is already running for this session"));
    const p = session.send("x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(server.steps()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.steps()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(server.steps()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ kind: "step_running" });
    expect(server.steps()).toHaveLength(3);
    expect(server.of("start")).toHaveLength(1);
  });

  test("a 409 on the user message is re-posted once the step has finished", async () => {
    const sleep = vi.fn(async () => undefined);
    const { server, session } = setup(always({ text: "ok" }), { sleep });
    server.fail("step", server.err(409, "a step is already running for this session"));
    expect((await session.send("x")).text).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    expect(server.steps().map((r) => r.body)).toEqual([{ user_message: "x" }, { user_message: "x" }]);
  });

  test("a message the server would refuse (over 8000 characters) is surfaced as bad_request, never retried", async () => {
    const { server, session } = setup(always({ text: "x" }));
    await expect(session.send("y".repeat(8001))).rejects.toMatchObject({ kind: "bad_request" });
    expect(server.steps()).toHaveLength(1);
  });

  test.each([
    ["an emoji", "hi \u{1F600}"],
    ["5000 emoji (10000 UTF-16 units, 5000 characters)", "\u{1F600}".repeat(5000)],
    ["8000 characters", "y".repeat(8000)],
  ])("the server accepts %s as a user message, like StepIn", async (_name, text) => {
    const { session } = setup(always({ text: "ok" }));
    expect((await session.send(text)).text).toBe("ok");
  });

  test.each([
    ["8001 characters", "y".repeat(8001)],
    ["a lone surrogate", "hi \ud800"],
    ["a control character", "hi \u0007"],
    ["only spaces", "   "],
  ])("the server refuses %s as a user message (bad_request)", async (_name, text) => {
    const { server, session } = setup(always({ text: "ok" }));
    await expect(session.send(text)).rejects.toMatchObject({ kind: "bad_request" });
    expect(server.steps()).toHaveLength(1);
  });

  test("too many sessions (a real 429 from the store)", async () => {
    const { session } = setup(always({ text: "x" }), {}, { maxSessions: 0 });
    await expect(session.send("x")).rejects.toMatchObject({ kind: "too_many" });
  });

  test("a 409 on tool_results (an id the server no longer holds) surfaces a conflict and does not loop", async () => {
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "x" }), {
      runTool: async (_r, call) => {
        server.sessions.get("sess_1")!.pending.clear(); // the server no longer has this call pending
        return { call_id: call.id, ok: true, content: { sheets: [] } };
      },
    });
    await expect(session.send("x")).rejects.toMatchObject({ kind: "conflict" });
    expect(server.steps()).toHaveLength(2);
  });

  test("a timeout is surfaced", async () => {
    const { server, session } = setup(always({ text: "x" }));
    server.fail("step", new RequestTimeout(120, "r"));
    await expect(session.send("x")).rejects.toMatchObject({ kind: "timeout" });
    expect(server.steps()).toHaveLength(1);
  });

  test("a non-API failure is 'other' with a fixed message", async () => {
    const { server, session } = setup(always({ text: "x" }));
    server.fail("step", new TypeError(`network ${SENTINEL}`));
    const e = (await session.send("x").catch((x: unknown) => x)) as CopilotError;
    expect(e.kind).toBe("other");
    expect(e.message).not.toContain(SENTINEL);
  });

  test("a 404 from start (unknown run) is not a lost session: no restart", async () => {
    const { server, session } = setup(always({ text: "x" }), { runId: "gone" }, { runs: ["run-1"] });
    await expect(session.send("x")).rejects.toMatchObject({ kind: "run_not_found" });
    await expect(session.ensureSession()).rejects.toMatchObject({ kind: "run_not_found" });
    expect(server.of("start")).toHaveLength(2);
    expect(server.steps()).toHaveLength(0);
  });

  test("an error leaves the session for the next turn", async () => {
    const { server, session } = setup(always({ text: "x" }));
    server.fail("step", server.err(500, "internal error"));
    await expect(session.send("x")).rejects.toBeInstanceOf(CopilotError);
    expect((await session.send("y")).text).toBe("x");
    expect(server.of("start")).toHaveLength(1);
  });
});

describe("503 busy backoff", () => {
  const busy = (server: ReturnType<typeof createServerFake>, retryAfter?: number) => server.fail("step", server.err(503, "copilot is busy", retryAfter));

  test("waits Retry-After (clamped to 1..60 s) and retries the same request", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "ok" }));
    busy(server, 0);
    busy(server, 600);
    const p = session.send("x");
    await vi.advanceTimersByTimeAsync(999);
    expect(server.steps()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.steps()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(server.steps()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).text).toBe("ok");
    expect(server.steps().map((r) => r.body)).toEqual(Array(3).fill({ user_message: "x" }));
  });

  test("gives up as 'busy' after two retries", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "ok" }));
    busy(server, 5);
    busy(server, 5);
    busy(server, 5);
    const p = session.send("x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(server.steps()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await p).toMatchObject({ kind: "busy" });
    expect(server.steps()).toHaveLength(3);
  });

  test("a 503 without Retry-After (not the copilot's admission) is surfaced at once: a user turn is never re-sent", async () => {
    const sleep = vi.fn(async () => undefined);
    const { server, session } = setup(always({ text: "ok" }), { sleep });
    busy(server);
    await expect(session.send("x")).rejects.toMatchObject({ kind: "busy" });
    expect(server.steps()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("tool_results are retried after a 503 too (the server refused them before reading)", async () => {
    const sleep = vi.fn(async () => undefined);
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "ok" }), { sleep });
    const first = server.client.copilotStep;
    let n = 0;
    server.client.copilotStep = async (id, body) => {
      n += 1;
      if (n === 2) throw server.err(503, "busy", 2);
      return first(id, body);
    };
    expect((await session.send("x")).text).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
  });

  test("the wait is abortable: no further request", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "ok" }));
    busy(server, 30);
    const c = new AbortController();
    const p = session.send("x", { signal: c.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    c.abort();
    expect(await p).toBeInstanceOf(CopilotAborted);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.steps()).toHaveLength(1);
  });

  test("a custom sleep that ignores the signal still stops on abort", async () => {
    const { server, session } = setup(always({ text: "ok" }), { sleep: () => new Promise(() => undefined) });
    busy(server, 1);
    const p = session.send("x").catch((e: unknown) => e);
    await tick();
    session.stop();
    expect(await p).toBeInstanceOf(CopilotAborted);
    expect(server.steps()).toHaveLength(1);
  });
});

describe("404 session lost", () => {
  test("restarts once, re-sends the user's message, and says so", async () => {
    let expired = false;
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "ok" }), {
      runTool: async (_r, call) => {
        if (!expired) { expired = true; server.expire("sess_1"); }
        return { call_id: call.id, ok: true, content: { sheets: ["A"] } };
      },
    });
    const out = await session.send("hello");
    expect(out).toMatchObject({ text: "ok", restarted: true });
    expect(out.read).toHaveLength(1); // the lost attempt's reads are not listed twice
    expect(server.of("start")).toHaveLength(2);
    expect(server.of("close")).toEqual([]); // the lost session is already gone
    expect(server.steps().filter((r) => has(r.body, "user_message")).map((r) => [r.session, r.body])).toEqual([
      ["sess_1", { user_message: "hello" }],
      ["sess_2", { user_message: "hello" }],
    ]);
    expect(session.sessionId).toBe("sess_2");
    expect((await session.send("again")).restarted).toBe(false);
  });

  test("a second 404 in the same send fails with a clear error", async () => {
    const { server, session } = setup(always({ text: "ok" }));
    server.fail("step", server.err(404, "session not found"));
    server.fail("step", server.err(404, "session not found"));
    const e = (await session.send("x").catch((x: unknown) => x)) as CopilotError;
    expect(e.kind).toBe("session_lost");
    expect(e.message).toBe("The copilot conversation was lost again. Try again.");
    expect(server.of("start")).toHaveLength(2);
    expect(server.steps()).toHaveLength(2);
  });

  test("the restart budget is per send", async () => {
    const { server, session } = setup(always({ text: "ok" }));
    server.fail("step", server.err(404, "session not found"));
    expect((await session.send("a")).restarted).toBe(true);
    server.fail("step", server.err(404, "session not found"));
    expect((await session.send("b")).restarted).toBe(true);
  });
});

describe("run binding", () => {
  test("a changed run id closes the old session and starts a new one before the turn", async () => {
    let runId: string | undefined = "run-1";
    const { server, session } = setup(always({ text: "ok" }), { runId: () => runId });
    expect((await session.send("a")).restarted).toBe(false);
    runId = "run-2";
    expect((await session.send("b")).restarted).toBe(true);
    await tick();
    expect(server.of("start").map((r) => r.runId)).toEqual(["run-1", "run-2"]);
    expect(server.of("close")).toEqual([{ kind: "close", session: "sess_1" }]);
    expect(server.steps().map((r) => r.session)).toEqual(["sess_1", "sess_2"]);
    runId = undefined;
    await session.send("c");
    expect(server.of("start")[2]).toEqual({ kind: "start" });
  });

  test("the run changes while ensureSession() starts for the old run: the turn runs on a session for the new run", async () => {
    let runId = "run-a";
    const { server, session } = setup(always({ text: "ok" }), { runId: () => runId });
    const release = server.hold("start");
    const early = session.ensureSession().catch((e: unknown) => e);
    await tick();
    runId = "run-b";
    const sent = session.send("x");
    await tick();
    release();
    const out = await sent;
    await tick();
    expect(out.text).toBe("ok");
    expect(server.of("start").map((r) => r.runId)).toEqual(["run-a", "run-b"]);
    // The run-b start was not held, so it created sess_1; the held run-a start created sess_2 afterwards.
    expect(server.steps().map((r) => r.session)).toEqual(["sess_1"]);
    expect(server.sessions.get("sess_1")!.runId).toBe("run-b");
    expect(server.of("close")).toEqual([{ kind: "close", session: "sess_2" }]); // the run-a session
    expect([...server.sessions.keys()]).toEqual(["sess_1"]);
    expect(session.sessionId).toBe("sess_1");
    expect(await early).toBe("sess_1"); // ensureSession also ends on the current run's session
  });

  test("the run changes during the turn's own start: the stale session is closed and the turn re-opens", async () => {
    let runId = "run-a";
    const { server, session } = setup(always({ text: "ok" }), { runId: () => runId });
    const release = server.hold("start");
    const sent = session.send("x");
    await tick();
    runId = "run-b";
    release();
    const out = await sent;
    await tick();
    expect(out).toMatchObject({ text: "ok", restarted: true });
    expect(server.of("start").map((r) => r.runId)).toEqual(["run-a", "run-b"]);
    expect(server.steps().map((r) => r.session)).toEqual(["sess_2"]);
    expect(server.of("close")).toEqual([{ kind: "close", session: "sess_1" }]);
  });

  test("a run that keeps changing during starts gives up after two re-opens", async () => {
    let n = 0;
    const { server, session } = setup(always({ text: "ok" }), { runId: () => `run-${n++}` });
    await expect(session.send("x")).rejects.toMatchObject({ kind: "run_changed" });
    await tick();
    expect(server.of("start")).toHaveLength(3);
    expect(server.steps()).toHaveLength(0);
    expect(server.sessions.size).toBe(0);
  });

  test("the same run id keeps the session", async () => {
    const { server, session } = setup(always({ text: "ok" }), { runId: () => "run-1" });
    await session.send("a");
    await session.send("b");
    expect(server.of("start")).toHaveLength(1);
    expect(server.of("close")).toEqual([]);
  });
});

describe("abort, stop and close", () => {
  test("stop mid-tool: the send rejects, no result is posted, no further tool runs, and the session is kept", async () => {
    const gate = deferred<void>();
    const ran: string[] = [];
    let seen: AbortSignal | undefined;
    const tool: RunTool = async (_r, call, _l, signal) => {
      ran.push(call.id);
      seen = signal;
      await gate.promise;
      return { call_id: call.id, ok: true, content: { sheets: [] } };
    };
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }, { name: "list_sheets" }] }, { text: "x" }), { runTool: tool });
    const p = session.send("x").catch((e: unknown) => e);
    await tick();
    expect(ran).toEqual(["call_1"]);
    session.stop();
    expect(await p).toBeInstanceOf(CopilotAborted);
    expect(seen?.aborted).toBe(true);
    gate.resolve();
    await tick();
    expect(ran).toEqual(["call_1"]);
    expect(server.steps()).toHaveLength(1); // late results are never posted
    expect(server.of("close")).toEqual([]);
    expect(session.sessionId).toBe("sess_1");
  });

  test("stop(); send() at once: the new turn waits for the stopped request, then reuses the session", async () => {
    const { server, session } = setup(always({ text: "ok" }));
    const release = server.hold("step");
    const first = session.send("one").catch((e: unknown) => e);
    await tick();
    session.stop();
    const second = session.send("two"); // never CopilotBusy: stop() frees the turn synchronously
    expect(await first).toBeInstanceOf(CopilotAborted);
    await tick();
    expect(server.steps()).toHaveLength(1); // nothing is posted while the stopped step still runs
    release();
    expect((await second).text).toBe("ok");
    expect(server.steps().map((r) => [r.session, r.body])).toEqual([["sess_1", { user_message: "one" }], ["sess_1", { user_message: "two" }]]);
    expect(server.of("close")).toEqual([]);
    expect(session.sessionId).toBe("sess_1");
  });

  test("five stops mid-request never use up the actor's sessions (no 429)", async () => {
    const { server, session } = setup(always({ text: "ok" }), {}, { maxSessions: 5 });
    for (let i = 0; i < 5; i++) {
      const release = server.hold("step");
      const p = session.send(`m${i}`).catch((e: unknown) => e);
      await tick();
      session.stop();
      expect(await p).toBeInstanceOf(CopilotAborted);
      release();
      await tick();
    }
    expect((await session.send("after")).text).toBe("ok");
    expect(server.of("start")).toHaveLength(1);
    expect(server.sessions.size).toBe(1);
  });

  test("a stopped request that timed out while the server step still runs: the next message waits and re-posts", async () => {
    const sleep = vi.fn(async () => undefined);
    const { server, session } = setup(always({ text: "ok" }), { sleep });
    await session.ensureSession();
    server.sessions.get("sess_1")!.busy = true; // the stopped turn's step is still running on the server
    sleep.mockImplementationOnce(async () => { server.sessions.get("sess_1")!.busy = false; });
    expect((await session.send("x")).text).toBe("ok");
    expect(server.steps()).toHaveLength(2);
    expect(server.of("start")).toHaveLength(1);
  });

  test("abort with the caller's signal mid-request rejects at once and keeps the session", async () => {
    const { server, session } = setup(always({ text: "x" }));
    const release = server.hold("step");
    const c = new AbortController();
    const p = session.send("x", { signal: c.signal }).catch((e: unknown) => e);
    await tick();
    c.abort();
    expect(await p).toBeInstanceOf(CopilotAborted);
    release();
    await tick();
    expect(server.of("close")).toEqual([]);
    expect(server.steps()).toHaveLength(1);
    await session.send("again");
    expect(server.of("start")).toHaveLength(1);
  });

  test("an already aborted signal sends nothing", async () => {
    const { server, session } = setup(always({ text: "x" }));
    const c = new AbortController();
    c.abort();
    await expect(session.send("x", { signal: c.signal })).rejects.toBeInstanceOf(CopilotAborted);
    expect(server.requests).toEqual([]);
  });

  test("stop during start: the start still completes and its session is used by the next turn", async () => {
    const { server, session } = setup(always({ text: "x" }));
    const release = server.hold("start");
    const p = session.send("x").catch((e: unknown) => e);
    await tick();
    session.stop();
    expect(await p).toBeInstanceOf(CopilotAborted);
    release();
    await tick();
    expect(session.sessionId).toBe("sess_1");
    await session.send("y");
    expect(server.of("start")).toHaveLength(1);
    expect(server.of("close")).toEqual([]);
  });

  test("abort between rounds stops before the next request", async () => {
    const c = new AbortController();
    const tool: RunTool = async (_r, call) => {
      if (call.id === "call_2") c.abort();
      return { call_id: call.id, ok: true, content: { sheets: [] } };
    };
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }, { name: "list_sheets" }, { name: "list_sheets" }] }, { text: "x" }), { runTool: tool });
    await expect(session.send("x", { signal: c.signal })).rejects.toBeInstanceOf(CopilotAborted);
    await tick();
    expect(server.steps()).toHaveLength(1);
  });

  // Later than this the post has already been sent: that is an abort mid-request (covered above).
  test.each([0, 1, 2])("an abort landing just after the last tool resolves (%i microtasks) posts nothing", async (depth) => {
    const c = new AbortController();
    const tool: RunTool = async (_r, call) => {
      let p = Promise.resolve();
      for (let i = 0; i < depth; i++) p = p.then(() => undefined);
      void p.then(() => c.abort());
      return { call_id: call.id, ok: true, content: { sheets: [] } };
    };
    const { server, session } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "x" }), { runTool: tool });
    await expect(session.send("x", { signal: c.signal })).rejects.toBeInstanceOf(CopilotAborted);
    expect(server.steps()).toHaveLength(1);
  });

  test("stop when idle does nothing", async () => {
    const { server, session } = setup(always({ text: "x" }));
    await session.send("x");
    session.stop();
    expect(server.of("close")).toEqual([]);
    expect(session.sessionId).toBe("sess_1");
  });

  test("a turn that runs past the turn deadline stops with 'turn_timeout' and keeps the session", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "x" }), { turnTimeoutMs: 1000 });
    const release = server.hold("step");
    const p = session.send("x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(await Promise.race([p, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ kind: "turn_timeout", message: "The copilot took too long on this message and was stopped." });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sessionId).toBe("sess_1");
    expect(server.of("close")).toEqual([]);
  });

  test("the default turn deadline is 5 minutes", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "x" }));
    server.hold("step");
    const p = session.send("x").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(await Promise.race([p, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ kind: "turn_timeout" });
  });
});

describe("close (unmount) and run change retire the session", () => {
  test("close() closes the server session once, clears sessionId and refuses later sends", async () => {
    const { server, session } = setup(always({ text: "x" }));
    await session.send("x");
    await Promise.all([session.close(), session.close()]);
    expect(server.of("close")).toHaveLength(1);
    expect(server.sessions.size).toBe(0);
    expect(session.sessionId).toBeUndefined();
    await expect(session.send("y")).rejects.toMatchObject({ kind: "closed" });
    await expect(session.ensureSession()).rejects.toMatchObject({ kind: "closed" });
  });

  test("close() during a request: the turn stops and the close is sent once the server step has finished", async () => {
    const { server, session } = setup(always({ text: "x" }));
    const release = server.hold("step");
    const p = session.send("x").catch((e: unknown) => e);
    await tick();
    const closed = session.close();
    expect(await p).toBeInstanceOf(CopilotAborted);
    await tick();
    expect(server.of("close")).toEqual([]);
    release();
    await closed;
    expect(server.of("close")).toHaveLength(1);
    expect(server.sessions.size).toBe(0);
  });

  test("a close refused because the step still runs (409) is retried on backoff until it succeeds", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "x" }));
    await session.send("x");
    server.sessions.get("sess_1")!.busy = true; // e.g. a request that timed out on the client
    const closed = session.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.of("close")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.of("close")).toHaveLength(2);
    server.sessions.get("sess_1")!.busy = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await closed;
    expect(server.of("close")).toHaveLength(3);
    expect(server.sessions.size).toBe(0);
  });

  test("the close retries are bounded (2/5/15/30/60 s) and then left to the server's TTL", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "x" }));
    await session.send("x");
    server.sessions.get("sess_1")!.busy = true;
    const closed = session.close();
    await vi.advanceTimersByTimeAsync(0);
    for (const [wait, n] of [[2, 2], [5, 3], [15, 4], [30, 5], [60, 6]] as const) {
      await vi.advanceTimersByTimeAsync(wait * 1000 - 1);
      expect(server.of("close")).toHaveLength(n - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.of("close")).toHaveLength(n);
    }
    await closed;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(server.of("close")).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a page unload ends the close retries; no timer is left", async () => {
    vi.useFakeTimers();
    const { server, session } = setup(always({ text: "x" }));
    await session.send("x");
    server.sessions.get("sess_1")!.busy = true;
    const closed = session.close();
    await vi.advanceTimersByTimeAsync(0);
    globalThis.dispatchEvent(new Event("pagehide"));
    await closed;
    expect(vi.getTimerCount()).toBe(0);
    expect(server.of("close")).toHaveLength(1);
  });

  test("a close that fails otherwise is best-effort (no retry)", async () => {
    const { server, session } = setup(always({ text: "x" }));
    await session.send("x");
    server.fail("close", server.err(500, "internal error"));
    await expect(session.close()).resolves.toBeUndefined();
    expect(server.of("close")).toHaveLength(1);
  });

  test("close() before any session sends nothing", async () => {
    const { server, session } = setup(always({ text: "x" }));
    await session.close();
    expect(server.requests).toEqual([]);
  });

  test("close() during ensureSession(): the start is abandoned and its late session is closed", async () => {
    const { server, session } = setup(always({ text: "x" }));
    const release = server.hold("start");
    const p = session.ensureSession().catch((e: unknown) => e);
    await tick();
    await session.close();
    expect(await p).toMatchObject({ kind: "closed" });
    release();
    await tick();
    await tick();
    expect(server.of("close")).toEqual([{ kind: "close", session: "sess_1" }]);
    expect(server.sessions.size).toBe(0);
    expect(session.sessionId).toBeUndefined();
  });

  test.each([0, 1, 2, 3, 4, 5])("close() %i microtasks after the start's answer leaves no session behind", async (depth) => {
    const { server, session } = setup(always({ text: "x" }));
    const started = deferred<void>();
    const start = server.client.copilotStart;
    server.client.copilotStart = async (runId) => {
      const out = await start(runId);
      let p = Promise.resolve();
      for (let i = 0; i < depth; i++) p = p.then(() => undefined);
      void p.then(() => started.resolve());
      return out;
    };
    const waiting = session.ensureSession().catch((e: unknown) => e);
    await started.promise;
    await session.close();
    const result = await waiting;
    for (let i = 0; i < 5; i++) await tick();
    expect(session.sessionId).toBeUndefined();
    expect(server.sessions.size).toBe(0);
    expect(server.of("close")).toEqual([{ kind: "close", session: "sess_1" }]);
    expect(result === "sess_1" || (result instanceof CopilotError && result.kind === "closed")).toBe(true);
  });

  test("aborting one caller's ensureSession() does not fail a concurrent send", async () => {
    const { server, session } = setup(always({ text: "ok" }));
    const release = server.hold("start");
    const a = new AbortController();
    const waiting = session.ensureSession(a.signal).catch((e: unknown) => e);
    const sent = session.send("x");
    await tick();
    a.abort();
    expect(await waiting).toBeInstanceOf(CopilotAborted);
    release();
    expect((await sent).text).toBe("ok");
    expect(server.of("start")).toHaveLength(1);
  });
});

describe("concurrency", () => {
  test("stop(); send(B); the stopped send settling never frees B's turn: send(C) is still CopilotBusy", async () => {
    const { server, session } = setup(always({ text: "ok" }));
    const releaseA = server.hold("step");
    const first = session.send("A").catch((e: unknown) => e);
    await tick();
    session.stop();
    const releaseB = server.hold("step");
    const second = session.send("B");
    expect(await first).toBeInstanceOf(CopilotAborted);
    await expect(session.send("C")).rejects.toBeInstanceOf(CopilotBusy);
    releaseA();
    await tick();
    releaseB();
    expect((await second).text).toBe("ok");
    expect(server.steps().map((r) => r.body)).toEqual([{ user_message: "A" }, { user_message: "B" }]);
  });

  test("a long-lived caller signal has no abort listener left after each turn", async () => {
    const { session } = setup(script({ calls: [{ name: "list_sheets" }] }, { text: "ok" }));
    const c = new AbortController();
    const live = new Set<unknown>();
    const add = c.signal.addEventListener.bind(c.signal);
    const remove = c.signal.removeEventListener.bind(c.signal);
    vi.spyOn(c.signal, "addEventListener").mockImplementation((type, fn, o) => { live.add(fn); add(type, fn, o); });
    vi.spyOn(c.signal, "removeEventListener").mockImplementation((type, fn, o) => { live.delete(fn); remove(type, fn, o); });
    for (let i = 0; i < 3; i++) {
      await session.send(`m${i}`, { signal: c.signal });
      expect(live.size).toBe(0);
    }
    expect(c.signal.addEventListener).toHaveBeenCalled();
  });

  test("a second send while one runs is rejected with CopilotBusy and sends nothing", async () => {
    const { server, session } = setup(always({ text: "x" }));
    const release = server.hold("step");
    const first = session.send("one");
    await tick();
    const e = await session.send("two").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CopilotBusy);
    expect(server.steps().map((r) => r.body)).toEqual([{ user_message: "one" }]);
    release();
    expect((await first).text).toBe("x");
    expect((await session.send("three")).text).toBe("x");
  });
});

describe("read log: addresses and counts only", () => {
  const ok = (content: unknown): ToolResult => ({ call_id: "c", ok: true, content });
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: "c", name, args });

  test("counts follow each result's shape", () => {
    expect(readLogEntry(call("list_sheets"), ok({ sheets: ["A", "B"] }))).toEqual({ tool: "list_sheets", cells: 2, ok: true });
    expect(readLogEntry(call("describe_sheet", { sheet: "S" }), ok({ used_range: "A1:C9", headers: ["a", "b", "c"], merged: [], counts: {} })))
      .toEqual({ tool: "describe_sheet", sheet: "S", range: "A1:C9", cells: 3, ok: true });
    expect(readLogEntry(call("read_range", { sheet: "S", range: "a1:z100" }), ok({ address: "A1:B3", rows: 3, cols: 2, values: [] })))
      .toEqual({ tool: "read_range", sheet: "S", range: "A1:B3", cells: 6, ok: true });
    expect(readLogEntry(call("find", { text: "x", sheet: "S" }), ok({ hits: [{}, {}] }))).toEqual({ tool: "find", sheet: "S", cells: 2, ok: true });
    expect(readLogEntry(call("get_selection"), ok({ sheet: "S", address: "B2:C3", cells: 4 }))).toEqual({ tool: "get_selection", sheet: "S", range: "B2:C3", cells: 4, ok: true });
  });

  test("failures, odd shapes and unknown tools count nothing and keep only valid addresses", () => {
    expect(readLogEntry(call("read_range", { sheet: "S", range: "A1:B2" }), { call_id: "c", ok: false, content: { message: "x" } }))
      .toEqual({ tool: "read_range", sheet: "S", range: "A1:B2", cells: 0, ok: false });
    expect(readLogEntry(call("read_range", { sheet: "bad[name", range: SENTINEL }), ok({ rows: -1, cols: 2.5 }))).toEqual({ tool: "read_range", cells: 0, ok: true });
    expect(readLogEntry(call("delete_all", { sheet: "S" }), ok({ sheets: [1] }))).toEqual({ tool: "unknown", sheet: "S", cells: 0, ok: true });
    expect(readLogEntry({ id: "c", name: "list_sheets", args: null as never }, ok("text"))).toEqual({ tool: "list_sheets", cells: 0, ok: true });
  });

  test("planted values, formulas, hit text and headers never reach the read log or an error", async () => {
    const contents: Record<string, unknown> = {
      list_sheets: { sheets: ["Data"] },
      describe_sheet: { used_range: "A1:B2", headers: [SENTINEL, `=${SENTINEL}`], merged: [], counts: { formulas: 1, constants: 1, blanks: 0 } },
      read_range: { address: "A1:B1", rows: 1, cols: 2, values: [[SENTINEL, 1]], formulas: [[`=${SENTINEL}()`, "1"]] },
      find: { hits: [{ sheet: "Data", address: "A1", text: `...${SENTINEL}...` }] },
      get_selection: { sheet: "Data", address: "A1", cells: 1, values: [[SENTINEL]] },
    };
    const tool: RunTool = async (_r, c) => ({ call_id: c.id, ok: true, content: contents[c.name] });
    const calls = [
      { name: "list_sheets" }, { name: "describe_sheet", args: { sheet: "Data" } }, { name: "read_range", args: { sheet: "Data", range: "A1:B1" } },
      { name: "find", args: { text: "x" } }, { name: "get_selection" },
    ];
    const { server, session } = setup(script({ calls }, { text: "ok" }), { runTool: tool });
    const out = await session.send("x");
    expect(out.read.map((r) => r.cells)).toEqual([1, 2, 2, 1, 1]);
    expect(JSON.stringify(out.read)).not.toContain(SENTINEL);
    server.fail("step", server.err(422, [{ msg: SENTINEL }] as unknown as string));
    const e = (await session.send("y").catch((x: unknown) => x)) as Error;
    expect(`${e.message} ${e.name} ${String(e)}`).not.toContain(SENTINEL);
  });
});

test("session.ts never uses console", () => {
  expect(readFileSync(path.resolve(__dirname, "../../src/copilot/session.ts"), "utf8")).not.toMatch(/console\./);
});

test("ApiError.requestId is kept on a surfaced error", async () => {
  const { server, session } = setup(always({ text: "x" }));
  server.fail("step", new ApiError("bad", 422, "req-9"));
  await expect(session.send("x")).rejects.toMatchObject({ kind: "bad_request", requestId: "req-9" });
});

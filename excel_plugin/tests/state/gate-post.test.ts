// Gate posts on the real store with a fake client: a timed-out POST is checked against the run before anything is
// re-enabled, and every accepted post keeps the cards disabled until a snapshot read after its decision and idle.
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError, AuthTimeout, RequestTimeout } from "../../src/api/client";
import type { Decision, GateBody, Snapshot } from "../../src/api/types";
import { CHECKING_NOTICE, createRunStore, GATE_SETTLE_TIMEOUT_MS, SETTLE_HARD_CAP_MS, STALE_NOTICE, WORKING_NOTICE } from "../../src/state/store";
import { decisionMatches } from "../../src/state/verdict";
import { fakeSnapshot } from "../support/fakes";

const atGate = (gate: "brief" | "findings" | "signoff", over: Partial<Snapshot> = {}): Snapshot =>
  fakeSnapshot({ pending: { gate, message: null, blocked_reasons: [], allowed_actions: ["approve", "change"] }, ...over });
const decision = (seq: number, kind: string, payload: Record<string, unknown>): Decision => ({ run_id: "r1", seq, kind, payload, actor: "analyst", at: "t" });
const approve: GateBody = { action: "approve" };
const override: GateBody = { action: "change", changes: [{ kind: "override_item_id", row: 2, value: "AFF_1" }] };
// The server records model_dump(): defaults are filled in, so the recorded change has more fields than the posted one.
const recordedOverride = (row: number, value: string) => ({ action: "change", actor: "analyst", changes: [{ kind: "override_item_id", row, value, reason: null }], question_id: null });

function setup(first: Snapshot, opts: { settleTimeoutMs?: number; settleHardCapMs?: number } = {}) {
  const client = {
    run: vi.fn<(id: string) => Promise<Snapshot>>(async () => first),
    grid: vi.fn(async () => ({ total: 0, rows: [], item_id_limit: 40 })),
    gate: vi.fn<(id: string, b: GateBody) => Promise<{ accepted: boolean }>>(async () => ({ accepted: true })),
  };
  let push: (event: string, data?: unknown) => void = () => {};
  let status: (s: "connected" | "reconnecting") => void = () => {};
  const streamer = vi.fn(async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; onStatus?: (s: "connected" | "reconnecting") => void; signal: AbortSignal }) => {
    push = (event, data = {}) => o.onMessage({ id: "1", event, data: JSON.stringify(data) });
    status = (s) => o.onStatus?.(s);
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  });
  const store = createRunStore(client as never, { debounceMs: 10, streamer: streamer as never, ...opts });
  return { client, store, push: (e: string, d?: unknown) => push(e, d), status: (s: "connected" | "reconnecting") => status(s) };
}
beforeEach(() => vi.useFakeTimers());

const timedOut = () => new RequestTimeout(30, "rid");

test("timed out but received (approve): checking notice and busy during the check, then accepted and still held", async () => {
  const { client, store, push } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  let answer: (s: Snapshot) => void = () => {};
  client.run.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
  const p = store.respond(approve);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ notice: CHECKING_NOTICE, busy: true, error: null });
  answer(atGate("brief", { decisions: [decision(1, "brief.approve", { action: "approve", actor: "analyst" })] }));
  expect(await p).toBe(true);
  expect(store.get()).toMatchObject({ notice: null, busy: true, error: null }); // held until its idle
  client.run.mockResolvedValue(atGate("findings"));
  push("decision", { entry: decision(1, "brief.approve", { action: "approve" }) });
  push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().busy).toBe(false);
  expect(store.get().snap?.pending?.gate).toBe("findings");
  expect(client.gate).toHaveBeenCalledTimes(1);
});

test("timed out and not received (approve): 'Not received — you can retry', cards re-enabled", async () => {
  const { client, store } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  expect(await store.respond(approve)).toBe(false);
  expect(store.get()).toMatchObject({ notice: null, busy: false, error: "Not received — you can retry. (Request timed out after 30 s (ref rid))" });
});

test.each([
  ["a job is running", atGate("brief", { working: true })],
  ["the gate moved on", atGate("findings")],
])("timed out, received because %s", async (_name, snap) => {
  const { client, store } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  client.run.mockResolvedValueOnce(snap);
  expect(await store.respond(approve)).toBe(true);
  expect(store.get().busy).toBe(true);
  expect(store.get().error).toBeNull();
});

test("timed out and the check fails: unknown, never 'not received'", async () => {
  const { client, store } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  client.run.mockRejectedValueOnce(new ApiError("unavailable", 503, "r2"));
  expect(await store.respond(approve)).toBe(false);
  const { error, busy, notice } = store.get();
  expect(error).toBe("Request timed out after 30 s (ref rid); the run could not be checked (unavailable (ref r2)). Refresh before you retry.");
  expect(error).not.toMatch(/Not received/);
  expect({ busy, notice }).toEqual({ busy: false, notice: null });
});

test("timed out override Apply: received when its exact override decision is recorded, not received for another row", async () => {
  const { client, store } = setup(atGate("findings"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  client.run.mockResolvedValueOnce(atGate("findings", { decisions: [decision(1, "findings.change", recordedOverride(2, "AFF_1"))] }));
  expect(await store.respond(override)).toBe(true);
  store.stop(); store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  client.run.mockResolvedValueOnce(atGate("findings", { decisions: [decision(1, "findings.change", recordedOverride(3, "AFF_1"))] }));
  expect(await store.respond(override)).toBe(false);
  expect(store.get().error).toMatch(/^Not received — you can retry/);
});

test("a sign-in timeout on a gate post sent nothing: a plain failure, the run is not checked", async () => {
  const { client, store } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.run.mockClear();
  client.gate.mockRejectedValueOnce(new AuthTimeout());
  expect(await store.respond(approve)).toBe(false);
  expect(store.get()).toMatchObject({ error: "Sign-in did not complete. Reopen the pane or retry.", busy: false, notice: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get().notice).toBeNull();
});

test("no idle after an accepted post (stream down): cards re-enable after the bound with a note; a refresh clears it", async () => {
  expect(GATE_SETTLE_TIMEOUT_MS).toBe(30_000);
  const { client, store } = setup(atGate("brief"), { settleTimeoutMs: 1000 });
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(store.get()).toMatchObject({ busy: true, notice: null });
  await vi.advanceTimersByTimeAsync(1);
  expect(store.get()).toMatchObject({ busy: false, notice: STALE_NOTICE });
  client.run.mockResolvedValueOnce(atGate("findings"));
  await store.refresh();
  expect(store.get()).toMatchObject({ busy: false, notice: null });
});

test("a stopped run's settle timer does not touch the next run", async () => {
  const { store } = setup(atGate("brief"), { settleTimeoutMs: 1000 });
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  store.start("r2"); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(store.get()).toMatchObject({ runId: "r2", notice: null, busy: false });
});

test("a job error does not settle the post by itself; the job's following idle does", async () => {
  const { client, store, push } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  client.run.mockResolvedValue(atGate("brief", { job_error: "RuntimeError: boom" }));
  push("error", { message: "RuntimeError: boom" });
  await vi.advanceTimersByTimeAsync(50); // the error's refresh: the job has not ended
  expect(store.get().busy).toBe(true);
  push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get()).toMatchObject({ busy: false, error: "RuntimeError: boom" });
});

test("the post records the idle count when it was sent", async () => {
  const { store, push } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  push("idle"); push("idle");
  await store.respond(approve);
  expect(store.get().postIdleSeq).toBe(2);
});

test("decisionMatches compares only the posted fields, by gate and action", () => {
  const d = (kind: string, payload: Record<string, unknown>) => ({ kind, payload });
  expect(decisionMatches(d("findings.change", recordedOverride(2, "AFF_1")), override, "findings")).toBe(true);
  expect(decisionMatches(d("findings.change", recordedOverride(2, "AFF_2")), override, "findings")).toBe(false);
  expect(decisionMatches(d("brief.change", recordedOverride(2, "AFF_1")), override, "findings")).toBe(false);
  expect(decisionMatches(d("brief.change", recordedOverride(2, "AFF_1")), override, null)).toBe(true);
  expect(decisionMatches(d("findings.change", { action: "change", changes: "x" }), override, "findings")).toBe(false);
  expect(decisionMatches(d("findings.change", { action: "change", changes: [null] }), override, "findings")).toBe(false);
  expect(decisionMatches(d("brief.approve", { action: "approve", actor: "a", reason: null }), approve, "brief")).toBe(true);
  expect(decisionMatches(d("brief.approve", {}), approve, "findings")).toBe(false);
  const answer: GateBody = { action: "answer", question_id: "q1", option: "Yes" };
  expect(decisionMatches(d("brief.answer", { action: "answer", question_id: "q1", option: "Yes", text: null }), answer, "brief")).toBe(true);
  expect(decisionMatches(d("brief.answer", { action: "answer", question_id: "q1", option: "No" }), answer, "brief")).toBe(false);
  const typed: GateBody = { action: "change", changes: [{ kind: "set_item_type", value: "Affiliate", rows: [2, 3] }] };
  expect(decisionMatches(d("findings.change", { action: "change", changes: [{ kind: "set_item_type", value: "Affiliate", rows: [2, 3] }] }), typed, "findings")).toBe(true);
});

test("the post settles while its POST is still waiting, then the POST times out: received, no error, no notice", async () => {
  const { client, store, push } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  let fail: (e: unknown) => void = () => {};
  client.gate.mockImplementationOnce(() => new Promise((_r, j) => { fail = j; }));
  const p = store.respond(approve);
  client.run.mockResolvedValue(atGate("findings", { decisions: [decision(1, "brief.approve", { action: "approve" })] }));
  push("decision", { entry: decision(1, "brief.approve", { action: "approve" }) });
  push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().busy).toBe(false); // settled from the stream
  const calls = client.run.mock.calls.length;
  fail(timedOut());
  expect(await p).toBe(true);
  expect(store.get()).toMatchObject({ error: null, notice: null, busy: false });
  expect(client.run.mock.calls.length).toBe(calls); // no check needed
});

test("the post settles during the check: received, the checking notice is cleared", async () => {
  const { client, store, push } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  let answer: (s: Snapshot) => void = () => {};
  client.run.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
  const p = store.respond(approve);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get().notice).toBe(CHECKING_NOTICE);
  const settledSnap = atGate("findings", { decisions: [decision(1, "brief.approve", { action: "approve" })] });
  client.run.mockResolvedValue(settledSnap);
  push("decision", { entry: decision(1, "brief.approve", { action: "approve" }) });
  push("idle");
  await vi.advanceTimersByTimeAsync(50); // the idle's refresh lands before the slow check
  answer(atGate("brief")); // the check's read predates the job
  expect(await p).toBe(true);
  expect(store.get()).toMatchObject({ error: null, notice: null, busy: false });
  expect(store.get().snap).toBe(settledSnap); // the older check read is not published over it
});

test("a check abandoned by stop reports nothing", async () => {
  const { client, store } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(timedOut());
  let answer: (s: Snapshot) => void = () => {};
  client.run.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
  const p = store.respond(approve);
  await vi.advanceTimersByTimeAsync(0);
  store.stop();
  answer(atGate("brief"));
  expect(await p).toBe(false);
  expect(store.get()).toMatchObject({ runId: null, notice: null, error: null });
});

const brief1 = decision(1, "brief.approve", { action: "approve" });

test("a 90 s job with a connected stream keeps the hold with 'Still working…', never the stale note; its idle settles it once", async () => {
  expect(SETTLE_HARD_CAP_MS).toBe(600_000);
  const { client, store, push, status } = setup(atGate("brief"));
  store.start("r1"); status("connected"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  push("decision", { entry: brief1 });
  client.run.mockResolvedValue(atGate("brief", { working: true, decisions: [brief1] }));
  await vi.advanceTimersByTimeAsync(31_000);
  expect(store.get()).toMatchObject({ busy: true, notice: WORKING_NOTICE });
  await vi.advanceTimersByTimeAsync(59_000);
  expect(store.get()).toMatchObject({ busy: true, notice: WORKING_NOTICE });
  client.run.mockClear();
  client.run.mockResolvedValue(atGate("findings", { decisions: [brief1] }));
  push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(client.run).toHaveBeenCalledTimes(1); // one post-idle refresh
  expect(store.get()).toMatchObject({ busy: false, notice: null });
  expect(store.get().snap?.pending?.gate).toBe("findings");
});

test("a chatty stream restarts the silence wait: no note at all during a long job", async () => {
  const { client, store, push, status } = setup(atGate("brief"));
  store.start("r1"); status("connected"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  client.run.mockResolvedValue(atGate("brief", { working: true }));
  for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(20_000); push("agent_message", { mode: "build" }); }
  expect(store.get()).toMatchObject({ busy: true, notice: null });
});

test("the stream drops while the job runs: after the silence wait the cards come back with the stale note", async () => {
  const { store, status } = setup(atGate("brief"));
  store.start("r1"); status("connected"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  status("reconnecting");
  await vi.advanceTimersByTimeAsync(19_999);
  expect(store.get()).toMatchObject({ busy: true, notice: null });
  await vi.advanceTimersByTimeAsync(1);
  expect(store.get()).toMatchObject({ busy: false, notice: STALE_NOTICE });
});

test("the hard cap ends the hold even with the stream connected", async () => {
  const { store, status } = setup(atGate("brief"), { settleHardCapMs: 100_000 });
  store.start("r1"); status("connected"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(store.get()).toMatchObject({ busy: true, notice: WORKING_NOTICE });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(store.get()).toMatchObject({ busy: false, notice: STALE_NOTICE });
});

test("a decision delivered late (after a silent minute) still settles the hold after its idle", async () => {
  const { client, store, push, status } = setup(atGate("brief"));
  store.start("r1"); status("connected"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(store.get()).toMatchObject({ busy: true, notice: WORKING_NOTICE });
  client.run.mockResolvedValue(atGate("brief", { decisions: [brief1] })); // inconsistent until our idle
  push("decision", { entry: brief1 });
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().busy).toBe(true);
  client.run.mockResolvedValue(atGate("findings", { decisions: [brief1] }));
  push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get()).toMatchObject({ busy: false, notice: null });
  expect(store.get().snap?.pending?.gate).toBe("findings");
});

test("a post while another is held is refused without a request and leaves the hold", async () => {
  const { client, store } = setup(atGate("brief"));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(await store.respond(approve)).toBe(true);
  expect(await store.respond({ action: "change", changes: [{ kind: "set_column_binding", field: "affiliate_id", column: "B" }] })).toBe(false);
  expect(client.gate).toHaveBeenCalledTimes(1);
  expect(store.get()).toMatchObject({ busy: true, error: null });
});

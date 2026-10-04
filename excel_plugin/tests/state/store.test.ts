import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { createRunStore } from "../../src/state/store";
import { fakeSnapshot } from "../support/fakes";

function setup(snapOver = {}) {
  const client = {
    run: vi.fn<(id: string) => Promise<ReturnType<typeof fakeSnapshot>>>(async () => fakeSnapshot(snapOver)),
    grid: vi.fn<(id: string) => Promise<{ total: number; rows: unknown[]; item_id_limit: number }>>(async () => ({ total: 0, rows: [], item_id_limit: 40 })),
    gate: vi.fn<(id: string, b: unknown) => Promise<{ accepted: boolean }>>(async () => ({ accepted: true })),
  };
  let push: (kind: string, data?: unknown, id?: string) => void = () => {};
  let status: (s: "connected" | "reconnecting") => void = () => {};
  const streamer = vi.fn(async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; onStatus?: typeof status; signal: AbortSignal }) => {
    push = (event, data = {}, id = "1") => o.onMessage({ id, event, data: JSON.stringify(data) });
    status = o.onStatus!;
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  });
  const store = createRunStore(client as never, { debounceMs: 10, streamer: streamer as never });
  return { client, store, streamer, push: (...a: Parameters<typeof push>) => push(...a), status: (s: "connected" | "reconnecting") => status(s) };
}
beforeEach(() => vi.useFakeTimers());

test("start loads the snapshot", async () => {
  const { store, client } = setup();
  store.start("r1");
  await vi.advanceTimersByTimeAsync(0);
  expect(client.run).toHaveBeenCalledWith("r1");
  expect(store.get().snap?.run_id).toBeDefined();
});

test("gate and idle events trigger one debounced refresh; others do not", async () => {
  const { store, client, push } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.run.mockClear();
  push("gate"); push("gate"); push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(client.run).toHaveBeenCalledTimes(1);
  client.run.mockClear();
  push("agent_message", { mode: "x" }); push("tool");
  await vi.advanceTimersByTimeAsync(50);
  expect(client.run).not.toHaveBeenCalled();
});

test("respond marks busy, posts the gate and refreshes; a 409 shows the server message and clears busy", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(new ApiError("the run is already working", 409, "rid"));
  expect(await store.respond({ action: "approve" })).toBe(false);
  expect(store.get().error).toBe("the run is already working (ref rid)");
  expect(store.get().busy).toBe(false);
});

test("respond posts the body, sets busy, then refreshes; busy holds until a refresh after its decision and idle", async () => {
  const { store, client, push } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.run.mockClear();
  expect(await store.respond({ action: "approve" })).toBe(true);
  expect(client.gate).toHaveBeenCalledWith("r1", { action: "approve" });
  expect(store.get().busy).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(client.run).toHaveBeenCalledTimes(1);
  expect(store.get().busy).toBe(true); // that refresh may predate the job's end
  push("decision", { entry: { seq: 1, kind: "brief.approve", payload: { action: "approve" }, actor: "a" } });
  push("idle");
  expect(store.get().busy).toBe(true); // counted, not yet fetched
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().busy).toBe(false);
  expect(store.get().notice).toBeNull();
});

test("a reconnect refreshes from the snapshot (server history may have been lost)", async () => {
  const { store, client, status } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.run.mockClear();
  status("reconnecting"); status("connected");
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().connection).toBe("connected");
  expect(client.run).toHaveBeenCalledTimes(1);
});

test("stop aborts the stream and drops further updates", async () => {
  const { store, client, push } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  store.stop(); client.run.mockClear();
  push("gate"); await vi.advanceTimersByTimeAsync(50);
  expect(client.run).not.toHaveBeenCalled();
});

test("stop resets the run state so a stopped run's cards cannot reappear", async () => {
  const { store, client, push } = setup({ result: { rows_emitted: 1, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] } });
  client.grid.mockResolvedValue({ total: 1, rows: [{ row: 2 }], item_id_limit: 40 });
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  push("decision", { entry: { kind: "approve", actor: "analyst" } });
  client.gate.mockRejectedValueOnce(new ApiError("nope", 409, "rid"));
  await store.respond({ action: "approve" });
  expect(store.get()).toMatchObject({ runId: "r1", grid: [{ row: 2 }], activity: ["analyst: approve"], error: "nope (ref rid)" });
  expect(store.get().snap).not.toBeNull();
  store.stop();
  expect(store.get()).toEqual({ runId: null, snap: null, grid: [], activity: [], error: null, busy: false, connection: "idle", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null });
});

test("a refresh response that arrives after stop does not update state", async () => {
  const { store, client } = setup();
  let release: (s: ReturnType<typeof fakeSnapshot>) => void = () => {};
  client.run.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  store.start("r1");
  store.stop();
  release(fakeSnapshot({ phase: "late" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.get().snap).toBeNull();
});

test("a later refresh wins over an earlier one that resolves late", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  let releaseOld: (s: ReturnType<typeof fakeSnapshot>) => void = () => {};
  client.run.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
  client.run.mockImplementationOnce(async () => fakeSnapshot({ phase: "new" }));
  const first = store.refresh();
  await store.refresh();
  releaseOld(fakeSnapshot({ phase: "old" }));
  await first;
  expect(store.get().snap?.phase).toBe("new");
});

test("snapshot with a result loads the grid; job_error and working map to error and busy", async () => {
  const result = { rows_emitted: 1, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
  const { store, client } = setup({ result, working: true, job_error: "boom" });
  client.grid.mockResolvedValue({ total: 1, rows: [{ row: 1 }], item_id_limit: 40 });
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(store.get().grid).toHaveLength(1);
  expect(store.get().busy).toBe(true);
  expect(store.get().error).toBe("boom");
});

test("activity lines are compact and capped at 20; bad JSON is ignored; subscribers are notified", async () => {
  const { store, push } = setup();
  const fn = vi.fn();
  store.subscribe(fn);
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 25; i++) push("agent_message", { mode: `m${i}` });
  push("decision", { actor: "analyst", kind: "approve" });
  push("error", { message: "bad" });
  expect(store.get().activity).toHaveLength(20);
  expect(store.get().activity.slice(-2)).toEqual(["analyst: approve", "Error: bad"]);
  expect(fn).toHaveBeenCalled();
});

test("a fatal stream error is surfaced unless aborted", async () => {
  const client = { run: vi.fn(async () => fakeSnapshot()), grid: vi.fn(), gate: vi.fn() };
  const streamer = vi.fn(async () => { throw new ApiError("run not found", 404, "r9"); });
  const store = createRunStore(client as never, { debounceMs: 10, streamer: streamer as never });
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(store.get().error).toBe("run not found (ref r9)");
});

test("a rejected gate message survives the follow-up refresh and later timers", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(new ApiError("the run is already working", 409, "rid"));
  await store.respond({ action: "approve" });
  client.run.mockClear();
  await vi.advanceTimersByTimeAsync(500);
  expect(client.run).toHaveBeenCalledTimes(1);
  expect(store.get().error).toBe("the run is already working (ref rid)");
  expect(store.get().busy).toBe(false);
});

test("a refresh in flight when respond runs does not clear the error or flip busy", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  let releaseOld: (s: ReturnType<typeof fakeSnapshot>) => void = () => {};
  client.run.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
  const inflight = store.refresh();
  client.gate.mockRejectedValueOnce(new ApiError("nope", 409, "rid"));
  await store.respond({ action: "approve" });
  releaseOld(fakeSnapshot({ working: true, job_error: null }));
  await inflight;
  expect(store.get().error).toBe("nope (ref rid)");
  expect(store.get().busy).toBe(false);
});

test("the error clears on the next respond call", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(new ApiError("nope", 409, "rid"));
  await store.respond({ action: "approve" });
  expect(store.get().error).not.toBeNull();
  await store.respond({ action: "approve" });
  expect(store.get().error).toBeNull();
});

test("the error clears when the pending gate changes", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(new ApiError("nope", 409, "rid"));
  await store.respond({ action: "approve" });
  client.run.mockResolvedValueOnce(fakeSnapshot({ pending: { gate: "signoff", message: null, blocked_reasons: [], allowed_actions: [] } }));
  await vi.advanceTimersByTimeAsync(500);
  expect(store.get().error).toBeNull();
});

test("a fatal stream error survives a later gate-event refresh", async () => {
  const client = { run: vi.fn(async () => fakeSnapshot()), grid: vi.fn(), gate: vi.fn() };
  const streamer = vi.fn(async () => { throw new ApiError("run not found", 404, "r9"); });
  const store = createRunStore(client as never, { debounceMs: 10, streamer: streamer as never });
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  await store.refresh();
  expect(store.get().error).toBe("run not found (ref r9)");
});

test("start works detached from the store object", async () => {
  const { store, client } = setup();
  const { start, stop } = store;
  start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(client.run).toHaveBeenCalledWith("r1");
  stop();
});

test("a decision event without actor or kind adds no activity line", async () => {
  const { store, push } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  push("decision", {});
  push("decision", { entry: { kind: "approve", actor: "analyst" } });
  expect(store.get().activity).toEqual(["analyst: approve"]);
});

test("a refresh failure shows an error and the next successful refresh clears it", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.run.mockRejectedValueOnce(new ApiError("unavailable", 503, "rq"));
  await store.refresh();
  expect(store.get().error).toBe("unavailable (ref rq)");
  await store.refresh();
  expect(store.get().error).toBeNull();
});

test("a refresh failure leaves an existing action error intact, as does a later success", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(new ApiError("nope", 409, "rid"));
  await store.respond({ action: "approve" });
  await vi.advanceTimersByTimeAsync(500);
  client.run.mockRejectedValueOnce(new ApiError("unavailable", 503, "rq"));
  await store.refresh();
  expect(store.get().error).toBe("nope (ref rid)");
  await store.refresh();
  expect(store.get().error).toBe("nope (ref rid)");
});

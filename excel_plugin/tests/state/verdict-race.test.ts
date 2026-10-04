// GET /runs/{id} reads the graph checkpoint (gate, message, overrides) before the busy flag and the decisions, so a
// snapshot fetched while the job ends can pair the old gate with working:false and the new decision. These tests drive
// the real store with a fake client returning exactly that inconsistent snapshot, then a consistent one after idle.
import { beforeEach, expect, test, vi } from "vitest";
import type { Decision, Snapshot } from "../../src/api/types";
import { createRunStore } from "../../src/state/store";
import { applyVerdict, markApply, verdictFrom } from "../../src/state/verdict";
import { fakeSnapshot } from "../support/fakes";

const edit = { row: 2, value: "AFF_1" };
const ours: Decision = { run_id: "r1", seq: 1, kind: "findings.change", payload: { action: "change", changes: [{ kind: "override_item_id", ...edit }] }, actor: "a", at: "t" };
const atFindings = (message: string | null, over: Partial<Snapshot> = {}): Snapshot =>
  fakeSnapshot({ pending: { gate: "findings", message, blocked_reasons: [], allowed_actions: ["approve", "change"] }, ...over });
const withOverride = { options: { ...fakeSnapshot().options, id_overrides: { "2": "AFF_1" } } };

function setup(before: Snapshot) {
  const client = {
    run: vi.fn<(id: string) => Promise<Snapshot>>(async () => before),
    grid: vi.fn(async () => ({ total: 0, rows: [], item_id_limit: 40 })),
    gate: vi.fn(async () => ({ accepted: true })),
  };
  let push: (event: string, data?: unknown) => void = () => {};
  const streamer = vi.fn(async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; signal: AbortSignal }) => {
    push = (event, data = {}) => o.onMessage({ id: "1", event, data: JSON.stringify(data) });
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  });
  const store = createRunStore(client as never, { debounceMs: 10, streamer: streamer as never });
  return { client, store, push: (e: string, data?: unknown) => push(e, data) };
}
/** The decision event the run publishes when it records `d`. */
const decisionEvent = (d: Decision) => ({ entry: d });
beforeEach(() => vi.useFakeTimers());

test("idle events are counted; a refresh records the count at its start, and stop/start resets both", async () => {
  const { store, client, push } = setup(atFindings(null));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null });
  push("idle");
  expect(store.get().idleSeq).toBe(1);
  await vi.advanceTimersByTimeAsync(50); // the idle's debounced refresh
  expect(store.get().snapIdleSeq).toBe(1);
  expect(client.run).toHaveBeenCalledTimes(2);
  store.stop();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null });
});

test("an in-flight refresh that started before the idle keeps the older snapIdleSeq", async () => {
  const { store, client, push } = setup(atFindings(null));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  let release: (s: Snapshot) => void = () => {};
  client.run.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  const inflight = store.refresh(); // starts at idleSeq 0
  push("idle"); // counted now; its debounced refresh has not run yet
  release(atFindings(null, { decisions: [ours] }));
  await inflight;
  expect(store.get()).toMatchObject({ idleSeq: 1, snapIdleSeq: 0 });
});

async function race(before: Snapshot, inconsistent: Snapshot, consistent: Snapshot) {
  const { store, client, push } = setup(before);
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  const mark = markApply(store.get());
  client.run.mockResolvedValueOnce(inconsistent);
  expect(await store.respond({ action: "change", changes: [{ kind: "override_item_id", ...edit }] })).toBe(true);
  push("decision", decisionEvent(ours));
  await vi.advanceTimersByTimeAsync(50); // the post's own refresh: the job ended while the server read the snapshot
  const mixed = store.get();
  expect(mixed.snap).toBe(inconsistent);
  expect(mixed.busy).toBe(true); // held for the post's outcome
  const naive = applyVerdict(mixed.snap, false, edit, mark.sinceSeq);
  expect(verdictFrom(mixed, edit, mark)).toEqual({ kind: "pending" });
  client.run.mockResolvedValueOnce(consistent);
  push("idle");
  expect(verdictFrom(store.get(), edit, mark)).toEqual({ kind: "pending" }); // counted, but not fetched yet
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().snap).toBe(consistent);
  expect(store.get().busy).toBe(false);
  return { naive, verdict: verdictFrom(store.get(), edit, mark) };
}

test("refused: a stale gate without a message plus the new decision is not taken as applied", async () => {
  const { naive, verdict } = await race(
    atFindings(null),
    atFindings(null, { decisions: [ours] }),
    atFindings("Changes refused: item_id.charset: bad", { decisions: [ours] }),
  );
  expect(naive).toEqual({ kind: "applied" }); // what the inconsistent snapshot alone would claim
  expect(verdict).toEqual({ kind: "refused", message: "Changes refused: item_id.charset: bad" });
});

test("applied: a stale refusal message plus the new decision is not taken as refused", async () => {
  const { naive, verdict } = await race(
    atFindings("Changes refused: earlier"),
    atFindings("Changes refused: earlier", { decisions: [ours] }),
    atFindings(null, { decisions: [ours], ...withOverride }),
  );
  expect(naive).toEqual({ kind: "refused", message: "Changes refused: earlier" });
  expect(verdict).toEqual({ kind: "applied" });
});

test("a fresh snapshot is still read only when consistent: working, or without our decision, is pending", () => {
  const mark = { sinceSeq: 0, idleSeq: 0 };
  const fresh = { busy: false, snapIdleSeq: 1, decisionLog: [{ ...ours, idleSeq: 0 }] };
  expect(verdictFrom({ ...fresh, snap: atFindings("x", { working: true, decisions: [ours] }) }, edit, mark)).toEqual({ kind: "pending" });
  expect(verdictFrom({ ...fresh, snap: atFindings("x") }, edit, mark)).toEqual({ kind: "pending" });
  expect(verdictFrom({ ...fresh, snap: atFindings("x", { decisions: [ours] }) }, edit, mark)).toEqual({ kind: "refused", message: "x" });
  expect(verdictFrom({ ...fresh, snapIdleSeq: 0, snap: atFindings("x", { decisions: [ours] }) }, edit, mark)).toEqual({ kind: "pending" });
  expect(markApply({ snap: atFindings(null, { decisions: [ours] }), idleSeq: 4 })).toEqual({ sinceSeq: 1, idleSeq: 4 });
});

test("an idle that arrives after the post but before this Apply's decision (the previous job's) does not count", async () => {
  const { store, client, push } = setup(atFindings(null));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  const mark = markApply(store.get());
  expect(await store.respond({ action: "change", changes: [{ kind: "override_item_id", ...edit }] })).toBe(true);
  // The previous job dropped its busy flag before publishing idle; our POST got in between.
  client.run.mockResolvedValueOnce(atFindings(null, { decisions: [ours] })); // inconsistent: our job ending mid-read
  push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().snapIdleSeq).toBeGreaterThan(mark.idleSeq); // the old rule would read this snapshot
  expect(verdictFrom(store.get(), edit, mark)).toEqual({ kind: "pending" });
  expect(store.get().busy).toBe(true);
  push("decision", decisionEvent(ours));
  client.run.mockResolvedValueOnce(atFindings("Changes refused: item_id.charset: bad", { decisions: [ours] }));
  await vi.advanceTimersByTimeAsync(50); // the decision's own refresh started before our idle: still pending
  expect(verdictFrom(store.get(), edit, mark)).toEqual({ kind: "pending" });
  push("idle");
  client.run.mockResolvedValueOnce(atFindings("Changes refused: item_id.charset: bad", { decisions: [ours] }));
  await vi.advanceTimersByTimeAsync(50);
  expect(verdictFrom(store.get(), edit, mark)).toEqual({ kind: "refused", message: "Changes refused: item_id.charset: bad" });
  expect(store.get().busy).toBe(false);
});

test("a replayed decision already seen keeps its first arrival; an old decision (seq at or before the mark) never counts", async () => {
  const older: Decision = { ...ours, seq: 1 };
  const { store, client, push } = setup(atFindings(null, { decisions: [older] }));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  push("decision", decisionEvent(older)); // the first connection replays the history
  push("idle"); // and the old job's idle
  await vi.advanceTimersByTimeAsync(50);
  const mark = markApply(store.get());
  expect(mark.sinceSeq).toBe(1);
  expect(await store.respond({ action: "change", changes: [{ kind: "override_item_id", ...edit }] })).toBe(true);
  push("decision", decisionEvent(older)); // replayed again after a reconnect
  push("idle"); // replayed too
  client.run.mockResolvedValue(atFindings(null, { decisions: [older] }));
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().decisionLog.filter((d) => d.seq === 1)).toHaveLength(1);
  expect(verdictFrom(store.get(), edit, mark)).toEqual({ kind: "pending" });
  expect(store.get().busy).toBe(true);
  const mine: Decision = { ...ours, seq: 2 };
  push("decision", decisionEvent(mine));
  push("idle");
  client.run.mockResolvedValue(atFindings(null, { decisions: [older, mine], ...withOverride }));
  await vi.advanceTimersByTimeAsync(50);
  expect(verdictFrom(store.get(), edit, mark)).toEqual({ kind: "applied" });
});

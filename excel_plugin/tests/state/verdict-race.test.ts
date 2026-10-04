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
  let push: (event: string) => void = () => {};
  const streamer = vi.fn(async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; signal: AbortSignal }) => {
    push = (event) => o.onMessage({ id: "1", event, data: "{}" });
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  });
  const store = createRunStore(client as never, { debounceMs: 10, streamer: streamer as never });
  return { client, store, push: (e: string) => push(e) };
}
beforeEach(() => vi.useFakeTimers());

test("idle events are counted; a refresh records the count at its start, and stop/start resets both", async () => {
  const { store, client, push } = setup(atFindings(null));
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ idleSeq: 0, snapIdleSeq: 0 });
  push("idle");
  expect(store.get().idleSeq).toBe(1);
  await vi.advanceTimersByTimeAsync(50); // the idle's debounced refresh
  expect(store.get().snapIdleSeq).toBe(1);
  expect(client.run).toHaveBeenCalledTimes(2);
  store.stop();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  expect(store.get()).toMatchObject({ idleSeq: 0, snapIdleSeq: 0 });
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
  await vi.advanceTimersByTimeAsync(50); // the post's own refresh: the job ended while the server read the snapshot
  const mixed = store.get();
  expect(mixed.snap).toBe(inconsistent);
  expect(mixed.busy).toBe(false);
  const naive = applyVerdict(mixed.snap, mixed.busy, edit, mark.sinceSeq);
  expect(verdictFrom(mixed, edit, mark)).toEqual({ kind: "pending" });
  client.run.mockResolvedValueOnce(consistent);
  push("idle");
  expect(verdictFrom(store.get(), edit, mark)).toEqual({ kind: "pending" }); // counted, but not fetched yet
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().snap).toBe(consistent);
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
  const fresh = { busy: false, snapIdleSeq: 1 };
  expect(verdictFrom({ ...fresh, snap: atFindings("x", { working: true, decisions: [ours] }) }, edit, mark)).toEqual({ kind: "pending" });
  expect(verdictFrom({ ...fresh, snap: atFindings("x") }, edit, mark)).toEqual({ kind: "pending" });
  expect(verdictFrom({ ...fresh, snap: atFindings("x", { decisions: [ours] }) }, edit, mark)).toEqual({ kind: "refused", message: "x" });
  expect(verdictFrom({ ...fresh, snapIdleSeq: 0, snap: atFindings("x", { decisions: [ours] }) }, edit, mark)).toEqual({ kind: "pending" });
  expect(markApply({ snap: atFindings(null, { decisions: [ours] }), idleSeq: 4 })).toEqual({ sinceSeq: 1, idleSeq: 4 });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, type Client } from "../../src/api/client";
import type { Decision, GridRow, Impact, Pending, Snapshot } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import { REVIEW_SHEET, removeReviewSheet } from "../../src/office/review";
import type { RunState, RunStore } from "../../src/state/store";
import { APPLY_HOLD_MAX_MS } from "../../src/state/verdict";
import { useStore } from "../../src/ui/useStore";
import { Pane } from "../../src/ui/Pane";
import { ReviewPanel } from "../../src/ui/ReviewPanel";
import { createFakeReview } from "../support/review-fake";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const gridRow = (row: number, ITEM_ID = `ID${row}`): GridRow => ({
  row, ITEM_ID, NAME: `N${row}`, ITEM_TYPE: "Affiliate", DESCRIPTION: "", DONOTIMPORT: "", id_method: "direct",
  source_sheet: "S", source_row: row, source_id: null, source_name: null, flags: [], derivation: null, lineage: {},
});
const impact = (over: Partial<Impact> = {}): Impact => ({
  violations: [], requires_rebuild: false, rows_changed: [2], findings_added: [], findings_removed: [], preview: [],
  publishable_before: false, publishable_after: true, ...over,
});
const findings: Pending = { gate: "findings", message: null, blocked_reasons: [], allowed_actions: ["approve", "change"] };
const rows = [gridRow(2), gridRow(3)];

function setup(opts: { pending?: Pending | null; dryRun?: Client["dryRun"]; total?: number; respond?: RunStore["respond"]; refreshSnap?: (s: Snapshot) => Snapshot; userSheet?: boolean; verdictTimeoutMs?: number; applyHoldMaxMs?: number; onApplyingChange?: (on: boolean) => void } = {}) {
  const fake = createFakeReview();
  if (opts.userSheet) fake.addSheet(REVIEW_SHEET).values.set("1,1", "mine");
  let state: RunState = {
    runId: "r1", snap: fakeSnapshot({ pending: opts.pending === undefined ? findings : opts.pending }), grid: rows,
    activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0,
  };
  const listeners = new Set<() => void>();
  const store: RunStore = {
    get: () => state, subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start: vi.fn(), stop: vi.fn(),
    refresh: vi.fn(async () => {
      act(() => { state = { ...state, grid: [gridRow(2, "NEW"), gridRow(3)], snap: opts.refreshSnap && state.snap ? opts.refreshSnap(state.snap) : state.snap }; listeners.forEach((l) => l()); });
    }),
    respond: vi.fn(opts.respond ?? (async () => true)),
  };
  const dryRun = vi.fn(opts.dryRun ?? (async () => impact()));
  const client = { dryRun } as unknown as Client;
  // Mounted only while the run is active, like the Pane: stopping the store unmounts the panel (after a render).
  const Harness = () => {
    const s = useStore(store);
    return s.runId ? <ReviewPanel client={client} runId="r1" store={store} rows={s.grid} total={opts.total} run={fake.run as ExcelRun} verdictTimeoutMs={opts.verdictTimeoutMs} applyHoldMaxMs={opts.applyHoldMaxMs} onApplyingChange={opts.onApplyingChange} /> : null;
  };
  render(<Harness />);
  const edit = async (addr: string, v: string) => { await act(async () => { await fake.userEdit(REVIEW_SHEET, addr, [[v]]); }); };
  const setError = (error: string | null) => { state = { ...state, error }; };
  /**
   * A snapshot as the store would hold it. `afterIdle` (default): fetched by a refresh that started after a new idle
   * event; false: fetched by a refresh that started before it (the server may have mixed pre- and post-job state).
   */
  const setSnap = (snap: Snapshot, busy = false, afterIdle = true) => {
    act(() => {
      const idleSeq = afterIdle ? state.idleSeq + 1 : state.idleSeq;
      state = { ...state, snap, busy, idleSeq, snapIdleSeq: afterIdle ? idleSeq : state.snapIdleSeq };
      listeners.forEach((l) => l());
    });
  };
  /** An idle event alone (the store refreshes after it; that refresh is a later setSnap). */
  const idle = () => { act(() => { state = { ...state, idleSeq: state.idleSeq + 1 }; listeners.forEach((l) => l()); }); };
  /** What "Onboard again" does first: the store forgets the run and tells its listeners (the re-render is deferred). */
  const stopRun = () => { state = { runId: null, snap: null, grid: [], activity: [], error: null, busy: false, connection: "idle", idleSeq: 0, snapIdleSeq: 0 }; listeners.forEach((l) => l()); };
  return { fake, store, dryRun, edit, setError, setSnap, idle, stopRun, get: () => state };
}

const ready = async (fake: ReturnType<typeof createFakeReview>) => {
  await waitFor(() => expect(fake.handlerCount()).toBe(1));
  await waitFor(() => expect(fake.sheet(REVIEW_SHEET)?.protected).toBe(true));
};

test("an edit triggers a dry run and shows rows changed and violations verbatim", async () => {
  const { fake, dryRun, edit } = setup({ dryRun: async () => impact({ rows_changed: [2, 3], violations: [{ rule: "unique", message: "ITEM_ID 'X' duplicates row 3" }] }) });
  await ready(fake);
  await edit("B2:B2", "X");
  expect(dryRun).toHaveBeenCalledWith("r1", [{ kind: "override_item_id", row: 2, value: "X" }]);
  expect(await screen.findByText("ITEM_ID 'X' duplicates row 3")).toBeTruthy();
  expect(screen.getByTestId("review-rows-changed").textContent).toContain("2, 3");
  expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(true);
});

test("Apply posts exactly one change gate, refreshes and clears; the sheet shows the server grid", async () => {
  const { fake, store, edit } = setup();
  await ready(fake);
  await edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
  expect(store.respond).toHaveBeenCalledTimes(1);
  expect(store.respond).toHaveBeenCalledWith({ action: "change", changes: [{ kind: "override_item_id", row: 2, value: "NEW" }] });
  expect(store.refresh).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(fake.read(REVIEW_SHEET, "B2:B2")).toEqual([["NEW"]]));
});

test("an edit alone never posts a gate; Discard posts nothing", async () => {
  const { fake, store, edit } = setup();
  await ready(fake);
  await edit("B3:B3", "Q");
  await screen.findByTestId("review-rows-changed");
  expect(store.respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("review-discard"));
  expect(screen.queryByTestId("review-pending")).toBeNull();
  expect(store.respond).not.toHaveBeenCalled();
});

test("Apply is disabled when the gate does not allow change", async () => {
  const { fake, edit } = setup({ pending: { ...findings, allowed_actions: ["approve"] } });
  await ready(fake);
  await edit("B2:B2", "X");
  await screen.findByTestId("review-rows-changed");
  expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(true);
});

test("a dry-run ApiError is shown verbatim and the sheet stays unchanged", async () => {
  const { fake, edit } = setup({ dryRun: async () => { throw new ApiError("Run is busy", 409, "req-1"); } });
  await ready(fake);
  await edit("B2:B2", "X");
  expect(await screen.findByText("Run is busy")).toBeTruthy();
  expect(fake.read(REVIEW_SHEET, "B2:B2")).toEqual([["ID2"]]);
  expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(true);
});

test("the later dry run wins when an earlier response arrives late", async () => {
  const resolvers: ((i: Impact) => void)[] = [];
  const { fake, edit } = setup({ dryRun: () => new Promise<Impact>((r) => { resolvers.push(r); }) });
  await ready(fake);
  await edit("B2:B2", "A");
  await edit("B3:B3", "B");
  await waitFor(() => expect(resolvers).toHaveLength(2));
  await act(async () => { resolvers[1]!(impact({ rows_changed: [3] })); });
  await act(async () => { resolvers[0]!(impact({ rows_changed: [2], violations: [{ rule: "r", message: "stale" }] })); });
  expect(screen.getByTestId("review-rows-changed").textContent).toContain("3");
  expect(screen.queryByText("stale")).toBeNull();
});

test("a paged grid says how many rows are shown", async () => {
  const { fake } = setup({ total: 900 });
  await ready(fake);
  expect(screen.getByTestId("review-paged").textContent).toBe("Showing first 2 of 900 rows");
});

test("a deleted Review sheet is recreated when the grid changes", async () => {
  const { fake, store } = setup();
  await ready(fake);
  fake.deleteSheet(REVIEW_SHEET);
  await act(async () => { await store.refresh(); });
  await waitFor(() => expect(fake.sheet(REVIEW_SHEET)).toBeTruthy());
});

test("a failed Apply keeps the pending edit and its impact and leaves the error banner to the Pane", async () => {
  let outcome = false;
  const ctl: { setError: (e: string | null) => void } = { setError: () => {} };
  const { fake, store, edit, setError } = setup({
    respond: async () => { if (!outcome) ctl.setError("gate rejected"); return outcome; },
  });
  ctl.setError = setError;
  await ready(fake);
  await edit("B2:B2", "NEW");
  const apply = () => screen.getByTestId("review-apply") as HTMLButtonElement;
  await waitFor(() => expect(apply().disabled).toBe(false));
  fireEvent.click(apply());
  await waitFor(() => expect(store.respond).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(apply().disabled).toBe(false));
  expect(screen.queryByTestId("error-banner")).toBeNull(); // the Pane renders store.error; no echo here
  expect(screen.getByTestId("review-rows-changed")).toBeTruthy();
  fireEvent.click(apply()); // same failure message again: still a failure
  await waitFor(() => expect(store.respond).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(apply().disabled).toBe(false));
  expect(screen.getByTestId("review-pending")).toBeTruthy();
  expect(store.refresh).not.toHaveBeenCalled();
  outcome = true;
  setError("job failed earlier"); // a masked job_error must not make a success look like a failure
  fireEvent.click(apply());
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
  expect(store.respond).toHaveBeenCalledTimes(3);
});

test("an accepted Apply clears the edit before the refresh, so a render failure cannot leave Apply enabled", async () => {
  const { fake, store, edit } = setup();
  await ready(fake);
  await edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  vi.mocked(store.refresh).mockImplementation(async () => { throw new Error("refresh failed"); });
  fireEvent.click(screen.getByTestId("review-apply"));
  expect(await screen.findByText("refresh failed")).toBeTruthy();
  expect(screen.queryByTestId("review-apply")).toBeNull();
  expect(store.respond).toHaveBeenCalledTimes(1);
});

test("an edit made while Apply is in flight survives the clear and is re-checked against the new grid", async () => {
  let release: (ok: boolean) => void = () => {};
  const dryRun = vi.fn(async (_id: string, changes: { kind: string; value?: string }[]) =>
    changes[0]!.value === "NEW" && dryRun.mock.calls.length > 2
      ? impact({ violations: [{ rule: "unique", message: "ITEM_ID NEW duplicates row 2" }] })
      : impact());
  const { fake, store, edit } = setup({ respond: () => new Promise<boolean>((r) => { release = r; }), dryRun: dryRun as unknown as Client["dryRun"] });
  await ready(fake);
  await edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(store.respond).toHaveBeenCalledTimes(1));
  await edit("B3:B3", "NEW"); // dry run #2 sees the pre-apply grid: no violation
  await waitFor(() => expect(dryRun).toHaveBeenCalledTimes(2));
  await act(async () => { release(true); });
  await waitFor(() => expect(store.refresh).toHaveBeenCalled());
  await screen.findByText("Row 3: ITEM_ID to NEW");
  expect(screen.queryByText("Row 2: ITEM_ID to NEW")).toBeNull();
  await screen.findByText("ITEM_ID NEW duplicates row 2"); // re-run after Apply
  expect(dryRun).toHaveBeenCalledTimes(3);
  expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(true);
});

test("Apply stays disabled while the post-Apply re-check is outstanding", async () => {
  let release: (ok: boolean) => void = () => {};
  const pendingChecks: ((i: Impact) => void)[] = [];
  let calls = 0;
  const dryRun = vi.fn(() => (++calls <= 2 ? Promise.resolve(impact()) : new Promise<Impact>((r) => { pendingChecks.push(r); })));
  const { fake, store, edit } = setup({ respond: () => new Promise<boolean>((r) => { release = r; }), dryRun: dryRun as unknown as Client["dryRun"] });
  await ready(fake);
  await edit("B2:B2", "A");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(store.respond).toHaveBeenCalled());
  await edit("B3:B3", "B");
  await act(async () => { release(true); });
  await waitFor(() => expect(pendingChecks).toHaveLength(1));
  expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { pendingChecks[0]!(impact()); });
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
});

test("a revert that fails is reported as a warning", async () => {
  const { fake, edit } = setup();
  await ready(fake);
  fake.failWrites(REVIEW_SHEET);
  await edit("C2:C2", "x");
  expect((await screen.findByTestId("review-warning")).textContent).toContain("Warning: Could not restore the 'Onboarding Review' sheet: write failed");
});

test("a multi-cell ITEM_ID paste previews one edit and tells the analyst the others were reverted", async () => {
  const { fake } = setup();
  await ready(fake);
  await act(async () => { await fake.userEdit(REVIEW_SHEET, "B2:B3", [["P"], ["Q"]]); });
  await screen.findByText("Row 2: ITEM_ID to P");
  expect(screen.getByTestId("review-notice").textContent).toBe("1 other ITEM_ID edit was reverted; apply one change at a time.");
  expect(fake.read(REVIEW_SHEET, "B2:B3")).toEqual([["ID2"], ["ID3"]]);
});

// POST /gate answers 202 before the run checks the change; the verdict is read from the decision the run records
// for this Apply (findings.change carrying this override) and the settled findings gate.
const override = (row = 2, value = "NEW") => ({ kind: "override_item_id", row, value });
const decision = (seq: number, kind = "findings.change", changes: unknown[] = [override()]): Decision =>
  ({ run_id: "r1", seq, kind, payload: { action: kind.split(".")[1], actor: "analyst", changes }, actor: "analyst", at: "t" });
const settled = (message: string | null, decisions = [decision(1)], idOverrides: Record<string, string> = {}): Snapshot =>
  fakeSnapshot({ pending: { ...findings, message }, decisions, options: { ...fakeSnapshot().options, id_overrides: idOverrides } });
const applyNew = async (s: ReturnType<typeof setup>) => {
  await ready(s.fake);
  await s.edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
};

test("a change the server refuses after the 202 comes back as a pending edit with the server's message", async () => {
  const { fake, edit, setSnap, dryRun } = setup();
  await ready(fake);
  await edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
  // Still working (and no new decision yet): no verdict.
  setSnap(fakeSnapshot({ pending: { ...findings, message: "old note" }, working: true }), true);
  expect(screen.queryByTestId("review-refused")).toBeNull();
  setSnap(settled("Changes refused: unique: ITEM_ID 'NEW' duplicates row 3"));
  const refused = await screen.findByTestId("review-refused");
  expect(refused.getAttribute("role")).toBe("status");
  expect(refused.textContent).toBe("Row 2: ITEM_ID to NEW was not applied. Changes refused: unique: ITEM_ID 'NEW' duplicates row 3");
  await screen.findByText("Row 2: ITEM_ID to NEW");
  await waitFor(() => expect(dryRun).toHaveBeenCalledTimes(2)); // re-checked before it can be applied again
});

test("a change the server applied clears for good: a settled gate without a message is success", async () => {
  const { fake, edit, setSnap } = setup();
  await ready(fake);
  await edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
  setSnap(settled(null));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  expect(screen.queryByTestId("review-pending")).toBeNull();
  // A later, unrelated gate message does not resurrect the applied edit.
  setSnap(settled("Sign-off accepts approve or reject.", [decision(1), decision(2)]));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
});

test("a message already on the gate before Apply is not mistaken for the verdict", async () => {
  const { fake, edit, setSnap } = setup({ pending: { ...findings, message: "Changes refused: earlier" } });
  await ready(fake);
  await edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
  setSnap(fakeSnapshot({ pending: { ...findings, message: "Changes refused: earlier" } })); // no new decision: the run has not answered
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
});

test("a failed Apply inside the Pane shows exactly one error banner and keeps the edit", async () => {
  const fake = createFakeReview();
  const result = { rows_emitted: 2, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
  let state: RunState = { runId: "r1", snap: fakeSnapshot({ result, pending: findings }), grid: rows, activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0 };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const store: RunStore = {
    get: () => state, subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start: vi.fn(), stop: vi.fn(), refresh: vi.fn(),
    respond: vi.fn(async () => { state = { ...state, error: "the run is already working (ref q1)" }; notify(); return false; }),
  };
  const client = { sponsors: vi.fn(async () => []), dryRun: vi.fn(async () => impact()) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} run={fake.run as ExcelRun} />);
  await ready(fake);
  await act(async () => { await fake.userEdit(REVIEW_SHEET, "B2:B2", [["NEW"]]); });
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(store.respond).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getAllByTestId("error-banner")).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.getAllByTestId("error-banner")).toHaveLength(1);
  expect(screen.getByTestId("error-banner").textContent).toContain("the run is already working");
  expect(screen.getByTestId("review-pending")).toBeTruthy();
});

test("a user's sheet with the Review sheet's name is left alone and the pane says why", async () => {
  const { fake } = setup({ userSheet: true });
  expect((await screen.findByTestId("error-banner")).textContent).toBe(
    "Error: A sheet named 'Onboarding Review' already exists and wasn't created by this add-in; rename it.",
  );
  expect(fake.read(REVIEW_SHEET, "A1:B1")).toEqual([["mine", ""]]);
});

test("an unrelated decision (an Acknowledge, a blocked Approve) is not taken as the Apply's verdict", async () => {
  const s = setup();
  await applyNew(s);
  const ack = decision(1, "findings.change", [{ kind: "acknowledge_finding", code: "W1", row: 2 }]);
  const blocked = decision(2, "findings.approve", []);
  s.setSnap(settled("Cannot pass the gate: 1 error", [ack, blocked]));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  // Another override (other row or value) is not ours either.
  s.setSnap(settled("Changes refused: item_id.charset: ITEM_ID may contain only A-Z, 0-9 and _", [ack, blocked, decision(3, "findings.change", [override(3, "NEW"), override(2, "OTHER")])]));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  s.setSnap(settled("Changes refused: item_id.unique: ITEM_ID NEW is already used by row 3", [ack, blocked, decision(4)]));
  expect((await screen.findByTestId("review-refused")).textContent).toBe("Row 2: ITEM_ID to NEW was not applied. Changes refused: item_id.unique: ITEM_ID NEW is already used by row 3");
});

test("a decision recorded before the Apply is not its verdict, even with the same override", async () => {
  const s = setup();
  s.setSnap(settled("Changes refused: earlier", [decision(5)]));
  await applyNew(s);
  s.setSnap(settled("Changes refused: earlier", [decision(5)]));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  s.setSnap(settled(null, [decision(5), decision(6)]));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  expect(screen.queryByTestId("review-unknown")).toBeNull();
});

test("the override in effect is success even when another decision followed and left a message", async () => {
  const s = setup();
  await applyNew(s);
  s.setSnap(settled("Cannot pass the gate: 1 error", [decision(1), decision(2, "findings.approve", [])], { "2": "NEW" }));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  expect(screen.queryByTestId("review-unknown")).toBeNull();
});

test("a later decision without the override in effect makes the verdict unknown, shown with the server grid", async () => {
  const s = setup();
  await applyNew(s);
  s.fake.deleteSheet(REVIEW_SHEET);
  s.setSnap(settled("Cannot pass the gate: 1 error", [decision(1), decision(2, "findings.approve", [])]));
  expect((await screen.findByTestId("review-unknown")).textContent).toBe("Verdict unknown — check the findings gate. Row 2: ITEM_ID to NEW may not have been applied.");
  expect(screen.queryByTestId("review-refused")).toBeNull();
  await waitFor(() => expect(s.store.refresh).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(s.fake.read(REVIEW_SHEET, "B2:B3")).toEqual([["NEW"], ["ID3"]]));
});

test("no verdict within the timeout: a visible unknown note, the server grid re-rendered, and no verdict afterwards", async () => {
  const s = setup({ verdictTimeoutMs: 40 });
  await applyNew(s);
  s.setSnap(fakeSnapshot({ pending: findings, working: true }), true); // the run never settles with our decision
  expect(await screen.findByTestId("review-unknown")).toBeTruthy();
  await waitFor(() => expect(s.store.refresh).toHaveBeenCalledTimes(2));
  // The sheet shows the server grid, not the analyst's typed value.
  await waitFor(() => expect(s.fake.read(REVIEW_SHEET, "B2:B2")).toEqual([["NEW"]]));
  // A late decision no longer counts: the Apply was given up on.
  s.setSnap(settled("Changes refused: late", [decision(1)]));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  // A new edit clears the note.
  await s.edit("B3:B3", "Q");
  await waitFor(() => expect(screen.queryByTestId("review-unknown")).toBeNull());
});

test("a verdict in time cancels the timeout", async () => {
  const s = setup({ verdictTimeoutMs: 60 });
  await applyNew(s);
  s.setSnap(settled(null, [decision(1)], { "2": "NEW" }));
  await new Promise((r) => setTimeout(r, 120));
  expect(screen.queryByTestId("review-unknown")).toBeNull();
  expect(s.store.refresh).toHaveBeenCalledTimes(1);
});

test("an Apply whose refresh lands after Onboard again stopped the run never recreates the deleted Review sheet", async () => {
  const s = setup();
  await ready(s.fake);
  await s.edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  vi.mocked(s.store.refresh).mockImplementation(async () => {
    // "Onboard again" while the refresh is in flight: the store stops, then the owned sheet is deleted before the read.
    s.stopRun();
    await removeReviewSheet(s.fake.run as ExcelRun);
  });
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(s.store.refresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByTestId("review-panel")).toBeNull());
  await s.fake.flush();
  const deleted = s.fake.log.lastIndexOf(`delete ${REVIEW_SHEET}`);
  expect(deleted).toBeGreaterThan(-1);
  expect(s.fake.log.slice(deleted)).not.toContain(`add ${REVIEW_SHEET}`);
  expect(s.fake.sheet(REVIEW_SHEET)).toBeUndefined();
});

test("Apply is unavailable at a re-entered brief gate with a stale result, and says so", async () => {
  const s = setup({ pending: { gate: "brief", message: null, blocked_reasons: [], allowed_actions: ["approve", "answer", "change", "instruct", "reject"] } });
  await ready(s.fake);
  await s.edit("B2:B2", "X");
  await screen.findByTestId("review-rows-changed");
  expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("review-change-hint").textContent).toBe("Apply is available at the findings gate.");
  fireEvent.click(screen.getByTestId("review-apply"));
  expect(s.store.respond).not.toHaveBeenCalled();
});

test("Onboard is disabled while an Apply is in flight, and enabled again when it ends", async () => {
  const fake = createFakeReview();
  const result = { rows_emitted: 2, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
  const state: RunState = { runId: "r1", snap: fakeSnapshot({ result, pending: findings }), grid: rows, activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0 };
  let release: (ok: boolean) => void = () => {};
  const store: RunStore = {
    get: () => state, subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(async () => {}),
    respond: vi.fn(() => new Promise<boolean>((r) => { release = r; })),
  };
  const readFile = vi.fn();
  const client = { sponsors: vi.fn(async () => [{ id: "sponsor-a", name: "Sponsor A" }]), dryRun: vi.fn(async () => impact()) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={readFile} run={fake.run as ExcelRun} />);
  await screen.findByRole("option", { name: "Sponsor A" });
  fireEvent.change(screen.getByTestId("sponsor-select"), { target: { value: "sponsor-a" } });
  await ready(fake);
  await act(async () => { await fake.userEdit(REVIEW_SHEET, "B2:B2", [["NEW"]]); });
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  const onboard = () => screen.getByTestId("onboard-button") as HTMLButtonElement;
  expect(onboard().disabled).toBe(false);
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(onboard().disabled).toBe(true));
  fireEvent.click(onboard());
  expect(store.stop).not.toHaveBeenCalled();
  await act(async () => { release(true); });
  await waitFor(() => expect(onboard().disabled).toBe(false));
  expect(readFile).not.toHaveBeenCalled();
});

// A hung request or Excel call must not hold "Onboard again" until the pane is reloaded.
const SLOW = "Apply is taking long; you can start a new upload.";
const clickApply = async (s: ReturnType<typeof setup>) => {
  await ready(s.fake);
  await s.edit("B2:B2", "NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("review-apply"));
};

test("a hung gate post releases the upload hold after the bound, says so, and the late end does not release again", async () => {
  let release: (ok: boolean) => void = () => {};
  const hold = vi.fn();
  const s = setup({ respond: () => new Promise<boolean>((r) => { release = r; }), applyHoldMaxMs: 40, onApplyingChange: hold });
  await clickApply(s);
  expect(hold.mock.calls).toEqual([[true]]);
  expect((await screen.findByTestId("review-slow")).textContent).toBe(SLOW);
  expect(hold.mock.calls).toEqual([[true], [false]]);
  expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(true); // this Apply is still running
  await act(async () => { release(false); });
  await waitFor(() => expect(screen.queryByTestId("review-slow")).toBeNull());
  expect(hold.mock.calls).toEqual([[true], [false]]); // a newer Apply's hold (e.g. after Onboard again) stays intact
});

test("a hung refresh after an accepted post releases the upload hold after the bound", async () => {
  const hold = vi.fn();
  const s = setup({ applyHoldMaxMs: 40, onApplyingChange: hold });
  vi.mocked(s.store.refresh).mockImplementation(() => new Promise<void>(() => {}));
  await clickApply(s);
  expect((await screen.findByTestId("review-slow")).textContent).toBe(SLOW);
  expect(hold.mock.calls).toEqual([[true], [false]]);
  cleanup(); // unmounting with the hold already released does not release again
  expect(hold.mock.calls).toEqual([[true], [false]]);
});

test("an Apply that ends in time clears its hold timer, releases the hold once and never shows the slow note", async () => {
  const hold = vi.fn();
  const s = setup({ applyHoldMaxMs: 4321, onApplyingChange: hold });
  const set = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    await clickApply(s);
    await waitFor(() => expect(hold.mock.calls).toEqual([[true], [false]]));
    const holdTimers = set.mock.calls.flatMap((call, i) => (call[1] === 4321 ? [set.mock.results[i]!.value as unknown] : []));
    expect(holdTimers).toHaveLength(1);
    expect(clear.mock.calls.map((c) => c[0] as unknown)).toContain(holdTimers[0]);
  } finally {
    set.mockRestore();
    clear.mockRestore();
  }
  expect(screen.queryByTestId("review-slow")).toBeNull();
});

test("unmounting during a hung Apply releases the hold at once", async () => {
  const hold = vi.fn();
  const s = setup({ respond: () => new Promise<boolean>(() => {}), applyHoldMaxMs: 60_000, onApplyingChange: hold });
  await clickApply(s);
  expect(hold.mock.calls).toEqual([[true]]);
  act(() => { s.stopRun(); });
  await waitFor(() => expect(screen.queryByTestId("review-panel")).toBeNull());
  expect(hold.mock.calls).toEqual([[true], [false]]);
});

test("Onboard, held by a hung Apply, is enabled again after APPLY_HOLD_MAX_MS (fake timers)", async () => {
  const fake = createFakeReview();
  const result = { rows_emitted: 2, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
  const state: RunState = { runId: "r1", snap: fakeSnapshot({ result, pending: findings }), grid: rows, activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0 };
  const store: RunStore = {
    get: () => state, subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(async () => {}),
    respond: vi.fn(() => new Promise<boolean>(() => {})), // the gate POST never answers
  };
  const client = { sponsors: vi.fn(async () => [{ id: "sponsor-a", name: "Sponsor A" }]), dryRun: vi.fn(async () => impact()) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} run={fake.run as ExcelRun} />);
  await screen.findByRole("option", { name: "Sponsor A" });
  fireEvent.change(screen.getByTestId("sponsor-select"), { target: { value: "sponsor-a" } });
  await ready(fake);
  await act(async () => { await fake.userEdit(REVIEW_SHEET, "B2:B2", [["NEW"]]); });
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  const onboard = () => screen.getByTestId("onboard-button") as HTMLButtonElement;
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByTestId("review-apply"));
    await act(async () => { await vi.advanceTimersByTimeAsync(APPLY_HOLD_MAX_MS - 1); });
    expect(onboard().disabled).toBe(true);
    expect(screen.queryByTestId("review-slow")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(onboard().disabled).toBe(false);
    expect(screen.getByTestId("review-slow").textContent).toBe(SLOW);
  } finally {
    vi.useRealTimers();
  }
});

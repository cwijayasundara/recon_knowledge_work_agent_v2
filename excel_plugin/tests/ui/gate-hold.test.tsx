// The Pane on the real store. After an accepted approve the server's snapshot can still show the old gate with
// working:false (GET /runs reads the checkpoint before the busy flag): that stale card must not be clickable, or a
// second click would approve the NEXT gate. Cards come back only from a snapshot read after the post's decision + idle.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { RequestTimeout, type Client } from "../../src/api/client";
import type { Brief, Decision, GateBody, GridRow, Pending, Snapshot } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import { REVIEW_SHEET } from "../../src/office/review";
import { createRunStore, type RunStore } from "../../src/state/store";
import { Pane } from "../../src/ui/Pane";
import { ReviewPanel } from "../../src/ui/ReviewPanel";
import { useStore } from "../../src/ui/useStore";
import { fakeSnapshot } from "../support/fakes";
import { createFakeReview } from "../support/review-fake";

const stores: RunStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach((s) => s.stop()); });

const brief: Brief = {
  source: { file: "a.xlsx", sheet: "S1", header_row: 1, rows_read: 1, rows_emitted: 1, rows_dropped: 0, drop_reasons: [] },
  bindings: [{ field: "affiliate_id", column: "ID", route: "exact", confidence: 1, evidence: "" }],
  id_strategy: "source_id", item_type: "Affiliate", recipe: { kind: "builtin", id: null }, expected_findings: [], questions: [], confidence: 1, summary: "One affiliate.",
};
const gridRow = (row: number, ITEM_ID = `ID${row}`): GridRow => ({
  row, ITEM_ID, NAME: `N${row}`, ITEM_TYPE: "Affiliate", DESCRIPTION: "", DONOTIMPORT: "", id_method: "direct",
  source_sheet: "S1", source_row: row, source_id: null, source_name: null, flags: [], derivation: null, lineage: {},
});
const result = { rows_emitted: 2, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
const pending = (gate: Pending["gate"]): Pending => ({ gate, message: null, blocked_reasons: [], allowed_actions: gate === "signoff" ? ["approve", "reject"] : ["approve", "change"] });
const at = (gate: Pending["gate"], over: Partial<Snapshot> = {}): Snapshot =>
  fakeSnapshot({ brief, ...(gate === "brief" ? {} : { result }), pending: pending(gate), ...over });
const decision = (seq: number, kind: string, payload: Record<string, unknown>): Decision => ({ run_id: "r1", seq, kind, payload, actor: "analyst", at: "t" });

function harness(first: Snapshot, opts: { settleTimeoutMs?: number } = {}) {
  const run = vi.fn<(id: string) => Promise<Snapshot>>(async () => first);
  const client = {
    sponsors: vi.fn(async () => [{ id: "sponsor-a", name: "Sponsor A" }]),
    run,
    grid: vi.fn(async () => ({ total: 2, rows: [gridRow(2), gridRow(3)], item_id_limit: 40 })),
    gate: vi.fn<(id: string, b: GateBody) => Promise<{ accepted: boolean }>>(async () => ({ accepted: true })),
    dryRun: vi.fn(async () => ({ violations: [], requires_rebuild: false, rows_changed: [2], findings_added: [], findings_removed: [], preview: [], publishable_before: false, publishable_after: true })),
  };
  let push: (event: string, data?: unknown) => void = () => {};
  const streamer = async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; signal: AbortSignal }) => {
    push = (event, data = {}) => o.onMessage({ id: "1", event, data: JSON.stringify(data) });
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  };
  const store = createRunStore(client as unknown as Client, { debounceMs: 5, streamer: streamer as never, ...opts });
  stores.push(store);
  const excel = createFakeReview();
  return { client, run, store, excel, push: (e: string, d?: unknown) => act(() => { push(e, d); }) };
}

const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const settle = () => new Promise((r) => setTimeout(r, 40)); // several debounced refreshes

test.each([
  ["brief -> findings", "brief", "approve-brief", "findings", "findings-approve"],
  ["findings -> signoff", "findings", "findings-approve", "signoff", "signoff-approve"],
] as const)("%s: the stale card stays disabled after an accepted approve, so a second click cannot approve the next gate", async (_name, from, fromButton, to, toButton) => {
  const { client, run, store, excel, push } = harness(at(from));
  render(<Pane client={client as unknown as Client} store={store} readFile={vi.fn()} run={excel.run as ExcelRun} apiBase="https://api.example.test" />);
  act(() => { store.start("r1"); });
  await waitFor(() => expect(button(fromButton).disabled).toBe(false));

  // Every refresh until the idle: the old gate, working:false, and the new decision (the job ended mid-read).
  const ours = decision(1, `${from}.approve`, { action: "approve", actor: "analyst" });
  run.mockResolvedValue(at(from, { decisions: [ours] }));
  fireEvent.click(button(fromButton));
  await waitFor(() => expect(client.gate).toHaveBeenCalledTimes(1));
  push("decision", { entry: ours });
  push("gate"); // more refreshes, all inconsistent
  await settle();
  expect(store.get().snap?.pending?.gate).toBe(from);
  expect(store.get().snap?.working).toBe(false);
  expect(button(fromButton).disabled).toBe(true);
  fireEvent.click(button(fromButton));
  expect(client.gate).toHaveBeenCalledTimes(1);

  run.mockResolvedValue(at(to, { decisions: [ours] }));
  push("idle");
  await waitFor(() => expect(button(toButton).disabled).toBe(false));
  expect(client.gate).toHaveBeenCalledTimes(1);
  expect(client.gate).toHaveBeenCalledWith("r1", { action: "approve" });
});

test("stream down: the card re-enables after the settle bound with 'Status may be out of date — refresh' and a Refresh button", async () => {
  const { client, run, store, excel } = harness(at("brief"), { settleTimeoutMs: 80 });
  render(<Pane client={client as unknown as Client} store={store} readFile={vi.fn()} run={excel.run as ExcelRun} apiBase="https://api.example.test" />);
  act(() => { store.start("r1"); });
  await waitFor(() => expect(button("approve-brief").disabled).toBe(false));
  fireEvent.click(button("approve-brief"));
  await waitFor(() => expect(client.gate).toHaveBeenCalledTimes(1));
  expect(button("approve-brief").disabled).toBe(true);
  expect(screen.queryByTestId("store-notice")).toBeNull();
  const notice = await screen.findByTestId("store-notice");
  expect(notice.textContent).toBe("Status may be out of date — refresh.Refresh");
  run.mockResolvedValue(at("findings"));
  const calls = run.mock.calls.length;
  fireEvent.click(screen.getByTestId("store-refresh"));
  await waitFor(() => expect(screen.queryByTestId("store-notice")).toBeNull());
  expect(run.mock.calls.length).toBe(calls + 1);
  await waitFor(() => expect(button("findings-approve").disabled).toBe(false));
});

test("a timed-out approve shows the checking note, then 'Not received' and the card again", async () => {
  const { client, run, store, excel } = harness(at("brief"));
  render(<Pane client={client as unknown as Client} store={store} readFile={vi.fn()} run={excel.run as ExcelRun} apiBase="https://api.example.test" />);
  act(() => { store.start("r1"); });
  await waitFor(() => expect(button("approve-brief").disabled).toBe(false));
  client.gate.mockRejectedValueOnce(new RequestTimeout(30, "rid"));
  let answer: (s: Snapshot) => void = () => {};
  run.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
  fireEvent.click(button("approve-brief"));
  expect((await screen.findByTestId("store-notice")).textContent).toBe("The request timed out and may have been received. Checking the run…");
  expect(button("approve-brief").disabled).toBe(true);
  await act(async () => { answer(at("brief")); });
  await waitFor(() => expect(screen.queryByTestId("store-notice")).toBeNull());
  expect(screen.getByTestId("error-banner").textContent).toBe("Error: Not received — you can retry. (Request timed out after 30 s (ref rid))");
  expect(button("approve-brief").disabled).toBe(false);
});

/** ReviewPanel alone on the real store, at the findings gate, with an ITEM_ID edit ready to Apply. */
async function applyReady(opts: { hang?: () => boolean; excelOpTimeoutMs?: number; onApplyingChange?: (on: boolean) => void } = {}) {
  const h = harness(at("findings"));
  // Excel.run deferred while `hang()` (the user is editing a cell) until `resume()`. The Excel queue is module-wide, so
  // a test that defers must resume before it ends, or later tests queue behind the deferred batch.
  let resume: () => void = () => {};
  const resumed = new Promise<void>((r) => { resume = r; });
  const run: ExcelRun = async (cb) => {
    if (opts.hang?.()) await resumed;
    return (h.excel.run as ExcelRun)(cb);
  };
  const Harness = () => {
    const s = useStore(h.store);
    return s.runId ? <ReviewPanel client={h.client as unknown as Client} runId="r1" store={h.store} rows={s.grid} run={run} excelOpTimeoutMs={opts.excelOpTimeoutMs} onApplyingChange={opts.onApplyingChange} /> : null;
  };
  render(<Harness />);
  act(() => { h.store.start("r1"); });
  await waitFor(() => expect(h.excel.handlerCount()).toBe(1));
  await waitFor(() => expect(h.excel.sheet(REVIEW_SHEET)?.protected).toBe(true));
  await act(async () => { await h.excel.userEdit(REVIEW_SHEET, "B2:B2", [["NEW"]]); });
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
  return { ...h, resume: () => resume() };
}
const overrideRecorded = (row: number) => decision(1, "findings.change", { action: "change", actor: "analyst", changes: [{ kind: "override_item_id", row, value: "NEW" }] });

test("override Apply timed out but received: the edit clears and the verdict comes from the run as usual", async () => {
  const { client, run, store, push } = await applyReady();
  client.gate.mockRejectedValueOnce(new RequestTimeout(30, "rid"));
  run.mockResolvedValue(at("findings", { decisions: [overrideRecorded(2)] })); // the check: our override is recorded
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
  expect(store.get().error).toBeNull();
  run.mockResolvedValue(at("findings", { decisions: [overrideRecorded(2)], options: { ...fakeSnapshot().options, id_overrides: { "2": "NEW" } } }));
  push("decision", { entry: overrideRecorded(2) });
  push("idle");
  await waitFor(() => expect(store.get().busy).toBe(false));
  await settle();
  expect(screen.queryByTestId("review-refused")).toBeNull();
  expect(screen.queryByTestId("review-unknown")).toBeNull();
  expect(client.gate).toHaveBeenCalledTimes(1);
});

test("override Apply timed out and not received: the edit stays for a retry and Apply is enabled again", async () => {
  const { client, run, store } = await applyReady();
  client.gate.mockRejectedValueOnce(new RequestTimeout(30, "rid"));
  run.mockResolvedValue(at("findings", { decisions: [overrideRecorded(3)] })); // another row's override: not ours
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(store.get().error).toBe("Not received — you can retry. (Request timed out after 30 s (ref rid))"));
  expect(screen.getByTestId("review-pending").textContent).toContain("Row 2: ITEM_ID to NEW");
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));
});

test("an Apply whose Review render Excel defers past the bound says the sheet will refresh (no 'try again') and releases the upload hold", async () => {
  let hang = false;
  const applying: boolean[] = [];
  const { client, run, resume } = await applyReady({ hang: () => hang, excelOpTimeoutMs: 40, onApplyingChange: (on) => applying.push(on) });
  run.mockResolvedValue(at("findings", { decisions: [overrideRecorded(2)] }));
  hang = true;
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(client.gate).toHaveBeenCalledTimes(1));
  expect((await screen.findByTestId("review-render-note")).textContent).toBe("The change was sent; the Review sheet will refresh when Excel is free.");
  expect(screen.queryByTestId("error-banner")).toBeNull(); // nothing to try again
  await waitFor(() => expect(applying).toEqual([true, false]));
  hang = false;
  resume(); // Excel is free again: the queued batches run (the Apply's own render is skipped, its caller gave up)
  await waitFor(() => expect(screen.queryByTestId("review-render-note")).toBeNull());
});

test("override Apply whose 202 is lost after the run already settled it: no retry is offered, no second post", async () => {
  const { client, run, store, push } = await applyReady();
  let fail: (e: unknown) => void = () => {};
  client.gate.mockImplementationOnce(() => new Promise((_r, j) => { fail = j; }));
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(client.gate).toHaveBeenCalledTimes(1));
  run.mockResolvedValue(at("findings", { decisions: [overrideRecorded(2)], options: { ...fakeSnapshot().options, id_overrides: { "2": "NEW" } } }));
  push("decision", { entry: overrideRecorded(2) });
  push("idle");
  await waitFor(() => expect(store.get().busy).toBe(false));
  await act(async () => { fail(new RequestTimeout(30, "rid")); });
  await waitFor(() => expect(screen.queryByTestId("review-pending")).toBeNull());
  await settle();
  expect(store.get().error).toBeNull();
  expect(screen.queryByTestId("review-refused")).toBeNull();
  expect(client.gate).toHaveBeenCalledTimes(1);
});

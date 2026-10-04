// The Review panel on the real store: the first refreshes after the 202 return the server's inconsistent snapshot
// (stale gate + working:false + the new decision); the verdict must come from the refresh after the idle event.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "../../src/api/client";
import type { Decision, GridRow, Snapshot } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import { REVIEW_SHEET } from "../../src/office/review";
import { createRunStore } from "../../src/state/store";
import { ReviewPanel } from "../../src/ui/ReviewPanel";
import { useStore } from "../../src/ui/useStore";
import { fakeSnapshot } from "../support/fakes";
import { createFakeReview } from "../support/review-fake";

const stores: { stop: () => void }[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach((s) => s.stop()); });

const gridRow = (row: number, ITEM_ID = `ID${row}`): GridRow => ({
  row, ITEM_ID, NAME: `N${row}`, ITEM_TYPE: "Affiliate", DESCRIPTION: "", DONOTIMPORT: "", id_method: "direct",
  source_sheet: "S", source_row: row, source_id: null, source_name: null, flags: [], derivation: null, lineage: {},
});
const result = { rows_emitted: 2, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
const ours: Decision = { run_id: "r1", seq: 1, kind: "findings.change", payload: { action: "change", changes: [{ kind: "override_item_id", row: 2, value: "NEW" }] }, actor: "analyst", at: "t" };
const atFindings = (message: string | null, over: Partial<Snapshot> = {}): Snapshot =>
  fakeSnapshot({ result, pending: { gate: "findings", message, blocked_reasons: [], allowed_actions: ["approve", "change"] }, ...over });
const withOverride = { options: { ...fakeSnapshot().options, id_overrides: { "2": "NEW" } } };

async function race(before: Snapshot, inconsistent: Snapshot, consistent: Snapshot) {
  const fake = createFakeReview();
  const run = vi.fn<(id: string) => Promise<Snapshot>>(async () => before);
  const client = {
    run,
    grid: vi.fn(async () => ({ total: 2, rows: [gridRow(2), gridRow(3)], item_id_limit: 40 })),
    gate: vi.fn(async () => ({ accepted: true })),
    dryRun: vi.fn(async () => ({ violations: [], requires_rebuild: false, rows_changed: [2], findings_added: [], findings_removed: [], preview: [], publishable_before: false, publishable_after: true })),
  };
  let push: (event: string) => void = () => {};
  const streamer = async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; signal: AbortSignal }) => {
    push = (event) => o.onMessage({ id: "1", event, data: "{}" });
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  };
  const store = createRunStore(client as unknown as Client, { debounceMs: 5, streamer: streamer as never });
  stores.push(store);
  const Harness = () => {
    const s = useStore(store);
    return s.runId ? <ReviewPanel client={client as unknown as Client} runId="r1" store={store} rows={s.grid} run={fake.run as ExcelRun} /> : null;
  };
  render(<Harness />);
  act(() => { store.start("r1"); });
  await waitFor(() => expect(store.get().snap).toBe(before));
  await waitFor(() => expect(fake.handlerCount()).toBe(1));
  await waitFor(() => expect(fake.sheet(REVIEW_SHEET)?.protected).toBe(true));
  await act(async () => { await fake.userEdit(REVIEW_SHEET, "B2:B2", [["NEW"]]); });
  await waitFor(() => expect((screen.getByTestId("review-apply") as HTMLButtonElement).disabled).toBe(false));

  run.mockResolvedValue(inconsistent); // every refresh until the idle: the job ended while the server read
  fireEvent.click(screen.getByTestId("review-apply"));
  await waitFor(() => expect(client.gate).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(run.mock.calls.length).toBeGreaterThanOrEqual(3)); // apply's refresh and the post's
  await waitFor(() => expect(store.get().snap).toBe(inconsistent));
  await new Promise((r) => setTimeout(r, 30));
  expect(store.get().busy).toBe(false);
  expect(screen.queryByTestId("review-refused")).toBeNull();
  expect(screen.queryByTestId("review-unknown")).toBeNull();

  run.mockResolvedValue(consistent);
  act(() => { push("idle"); });
  await waitFor(() => expect(store.get().snap).toBe(consistent));
  return { client, dryRun: client.dryRun };
}

test("refused: the stale gate's missing message is not success; the refusal after idle is shown", async () => {
  const refusal = "Changes refused: item_id.unique: ITEM_ID NEW is already used by row 3";
  const { dryRun } = await race(atFindings(null), atFindings(null, { decisions: [ours] }), atFindings(refusal, { decisions: [ours] }));
  expect((await screen.findByTestId("review-refused")).textContent).toBe(`Row 2: ITEM_ID to NEW was not applied. ${refusal}`);
  await screen.findByText("Row 2: ITEM_ID to NEW"); // restored for another try
  await waitFor(() => expect(dryRun).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId("review-unknown")).toBeNull();
});

test("applied: the stale gate's old refusal is not this Apply's verdict; the settled run after idle is success", async () => {
  await race(
    atFindings("Changes refused: earlier"),
    atFindings("Changes refused: earlier", { decisions: [ours] }),
    atFindings(null, { decisions: [ours], ...withOverride }),
  );
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByTestId("review-refused")).toBeNull();
  expect(screen.queryByTestId("review-unknown")).toBeNull();
  expect(screen.queryByTestId("review-pending")).toBeNull();
});

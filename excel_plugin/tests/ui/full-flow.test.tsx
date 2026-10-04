import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "../../src/api/client";
import type { Artifact, Brief, GateBody, GridRow, Pending, Snapshot } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import type { WorkbookFile } from "../../src/office/workbook";
import { createRunStore } from "../../src/state/store";
import { Pane } from "../../src/ui/Pane";
import { createFakeReview } from "../support/review-fake";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const brief: Brief = {
  source: { file: "a.xlsx", sheet: "S1", header_row: 1, rows_read: 1, rows_emitted: 1, rows_dropped: 0, drop_reasons: [] },
  bindings: [{ field: "affiliate_id", column: "ID", route: "exact", confidence: 1, evidence: "" }],
  id_strategy: "source_id", item_type: "Affiliate", recipe: { kind: "builtin", id: null }, expected_findings: [], questions: [], confidence: 1, summary: "One affiliate.",
};
const row: GridRow = {
  row: 2, ITEM_ID: "AFF_1", NAME: "N", ITEM_TYPE: "Affiliate", DESCRIPTION: "", DONOTIMPORT: "", id_method: "direct",
  source_sheet: "S1", source_row: 2, source_id: "AFF_1", source_name: "N", flags: [], derivation: null, lineage: {},
};
const art = (name: string): Artifact => ({ name, key: `k/${name}`, sha256: "0123456789abcdef", kind: "csv", bytes: 64 });
const result = { rows_emitted: 1, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
const file: WorkbookFile = { blob: new Blob(["x"]), name: "a.xlsx", sha256: "abc", bytes: 1 };

// The server's gate sequence for a clean run with zero findings: the findings gate is still a stop.
const pending = (gate: Pending["gate"], extra: Partial<Pending> = {}): Pending => ({ gate, message: null, blocked_reasons: [], allowed_actions: ["approve", "change", "instruct", "reject"], ...extra });
const STEPS: Partial<Snapshot>[] = [
  { phase: "p2", status: "awaiting_brief", brief, pending: pending("brief") },
  { phase: "p3", status: "awaiting_findings", brief, result, pending: pending("findings") },
  { phase: "p4", status: "awaiting_signoff", brief, result, pending: pending("signoff", { allowed_actions: ["approve", "reject"], artifacts: [art("Affiliates.csv"), art("review.xlsx")] }) },
  { phase: "done", status: "locked", brief, result, pending: null, artifacts: [art("Affiliates.csv"), art("review.xlsx"), art("manifest.json")] },
];

test("a clean run goes brief -> findings (zero findings) -> signoff -> locked using only clicks", async () => {
  let step = 0;
  const posted: GateBody[] = [];
  const snap = () => fakeSnapshot({ ...STEPS[step], upload: { key: "k", name: "a.xlsx", sha256: "abc" } });
  const client = {
    sponsors: vi.fn(async () => [{ id: "sponsor-a", name: "Sponsor A" }]),
    startRun: vi.fn(async () => ({ run_id: "r1" })),
    run: vi.fn(async () => snap()),
    grid: vi.fn(async () => ({ total: 1, rows: [row], item_id_limit: 40 })),
    gate: vi.fn(async (_id: string, body: GateBody) => {
      posted.push(body);
      const gate = STEPS[step]?.pending?.gate;
      if (body.action === "approve" && step < STEPS.length - 1) step++;
      // The job records the decision, then ends with idle (after the 202, as the server's worker thread does).
      setTimeout(() => {
        emit("decision", { entry: { seq: posted.length, kind: `${gate}.${body.action}`, payload: body, actor: "analyst" } });
        emit("idle", {});
      }, 0);
      return { accepted: true };
    }),
  } as unknown as Client;
  let emit: (event: string, data: unknown) => void = () => {};
  const streamer = async (o: { signal: AbortSignal; onMessage: (m: { id: string | null; event: string; data: string }) => void }) => {
    emit = (event, data) => o.onMessage({ id: null, event, data: JSON.stringify(data) });
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  };
  const store = createRunStore(client, { debounceMs: 5, streamer: streamer as never });
  const review = createFakeReview();
  render(<Pane client={client} store={store} readFile={async () => file} run={review.run as ExcelRun} apiBase="https://api.example.test" />);

  await screen.findByRole("option", { name: "Sponsor A" });
  fireEvent.change(screen.getByTestId("sponsor-select"), { target: { value: "sponsor-a" } });
  fireEvent.click(screen.getByTestId("onboard-button"));

  const approveBrief = await screen.findByTestId("approve-brief");
  await waitFor(() => expect((approveBrief as HTMLButtonElement).disabled).toBe(false));
  expect(posted).toEqual([]);
  fireEvent.click(approveBrief);

  const approveFindings = await screen.findByTestId("findings-approve");
  expect(screen.getByTestId("findings-summary").textContent).toBe("0 errors, 0 warnings, 0 acknowledgements required");
  expect(screen.queryByTestId("findings-list")).toBeNull();
  expect(screen.queryByTestId("brief-card")).toBeNull();
  await waitFor(() => expect((screen.getByTestId("findings-approve") as HTMLButtonElement).disabled).toBe(false));
  expect(posted).toEqual([{ action: "approve" }]);
  fireEvent.click(approveFindings);

  const approveSignoff = await screen.findByTestId("signoff-approve");
  expect(screen.queryByTestId("findings-gate")).toBeNull();
  await waitFor(() => expect((screen.getByTestId("signoff-approve") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(approveSignoff);

  await waitFor(() => expect(screen.getByTestId("progress").textContent).toContain("Status: locked"));
  expect(screen.queryByTestId("signoff-approve")).toBeNull();
  expect(screen.getByTestId("download-manifest.json")).toBeTruthy();
  expect(posted).toEqual([{ action: "approve" }, { action: "approve" }, { action: "approve" }]);
  store.stop();
});

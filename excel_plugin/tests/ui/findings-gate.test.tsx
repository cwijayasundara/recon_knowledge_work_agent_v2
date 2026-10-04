import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "../../src/api/client";
import type { Brief, Finding, Pending, Snapshot } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import type { RunState, RunStore } from "../../src/state/store";
import { FindingsGate } from "../../src/ui/FindingsGate";
import { Pane } from "../../src/ui/Pane";
import { createFakeReview } from "../support/review-fake";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const finding = (over: Partial<Finding>): Finding => ({
  code: "W1", severity: "warning", scope: "row", row: 2, source_row: 5, message: "msg", requires_ack: true, acknowledged: false, ...over,
});
const result = (findings: Finding[] = [], over: Partial<NonNullable<Snapshot["result"]>> = {}): NonNullable<Snapshot["result"]> => ({
  rows_emitted: 3, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings, ...over,
});
const findingsGate = (over: Partial<Pending> = {}): Pending => ({
  gate: "findings", message: null, blocked_reasons: [], allowed_actions: ["approve", "change", "instruct", "reject"], ...over,
});
const brief: Brief = {
  source: { file: "f.xlsx", sheet: "S1", header_row: 1, rows_read: 3, rows_emitted: 3, rows_dropped: 0, drop_reasons: [] },
  bindings: [{ field: "affiliate_id", column: "ID", route: "exact", confidence: 1, evidence: "" }],
  id_strategy: "source_id", item_type: "Affiliate", recipe: { kind: "builtin", id: null }, expected_findings: [], questions: [], confidence: 1, summary: "s",
};

function paneWith(snap: Snapshot, opts: { busy?: boolean; respond?: RunStore["respond"] } = {}) {
  const state: RunState = { runId: "r1", snap, grid: [], activity: [], error: null, busy: opts.busy ?? false, connection: "connected", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null };
  const respond = vi.fn(opts.respond ?? (async () => true));
  const store: RunStore = { get: () => state, subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), respond };
  const client = { sponsors: vi.fn(async () => []) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} run={createFakeReview().run as ExcelRun} />);
  return { respond };
}

test("the findings gate card shows with zero findings and Approve posts exactly one approve, only on click", () => {
  const { respond } = paneWith(fakeSnapshot({ result: result(), pending: findingsGate() }));
  expect(screen.queryByTestId("findings-list")).toBeNull();
  const card = screen.getByTestId("findings-gate");
  expect(card.textContent).toContain("0 errors, 0 warnings, 0 acknowledgements required");
  const approve = screen.getByTestId("findings-approve") as HTMLButtonElement;
  expect(approve.textContent).toBe("Approve findings");
  expect(approve.disabled).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  fireEvent.click(approve);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond).toHaveBeenCalledWith({ action: "approve" });
});

test("Approve findings is disabled when blocked, and the reasons are shown verbatim", () => {
  const { respond } = paneWith(fakeSnapshot({
    result: result([finding({ severity: "error", code: "E1" }), finding({}), finding({ code: "W2" })], { errors: 1, ack_required: 2 }),
    pending: findingsGate({ blocked_reasons: ["1 open error", "2 warnings need acknowledgement"] }),
  }));
  const approve = screen.getByTestId("findings-approve") as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  expect(screen.getByTestId("findings-gate").textContent).toContain("1 error, 2 warnings, 2 acknowledgements required");
  expect([...screen.getByTestId("findings-blocked-reasons").querySelectorAll("li")].map((li) => li.textContent)).toEqual(["1 open error", "2 warnings need acknowledgement"]);
  fireEvent.click(approve);
  expect(respond).not.toHaveBeenCalled();
});

test("Approve findings is disabled while busy or when approve is not offered", () => {
  const { rerender } = render(<FindingsGate snap={fakeSnapshot({ result: result(), pending: findingsGate() })} busy onApprove={() => {}} />);
  expect((screen.getByTestId("findings-approve") as HTMLButtonElement).disabled).toBe(true);
  rerender(<FindingsGate snap={fakeSnapshot({ result: result(), pending: findingsGate({ allowed_actions: ["reject"] }) })} busy={false} onApprove={() => {}} />);
  expect((screen.getByTestId("findings-approve") as HTMLButtonElement).disabled).toBe(true);
});

test("no findings gate card away from the findings gate", () => {
  paneWith(fakeSnapshot({ result: result(), pending: { gate: "signoff", message: null, blocked_reasons: [], allowed_actions: ["approve", "reject"] } }));
  expect(screen.queryByTestId("findings-gate")).toBeNull();
});

test.each([
  ["brief", { brief, pending: { gate: "brief", message: "Cannot approve the brief: no ID column", blocked_reasons: [], allowed_actions: ["approve", "change"] } as Pending }, "brief-card"],
  ["findings", { result: result(), pending: findingsGate({ message: "Changes refused: unique: ITEM_ID 'X' duplicates row 3" }) }, "findings-gate"],
  ["signoff", { result: result(), pending: { gate: "signoff", message: "Sign-off accepts approve or reject.", blocked_reasons: [], allowed_actions: ["approve", "reject"] } as Pending }, "signoff-card"],
] as const)("the %s gate's message is shown verbatim in a status banner under its card", (_gate, over, cardId) => {
  paneWith(fakeSnapshot(over));
  const banner = screen.getByTestId("gate-message");
  expect(banner.getAttribute("role")).toBe("status");
  expect(banner.textContent).toBe(over.pending.message);
  const card = screen.getByTestId(cardId);
  expect(card.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("the top-level gate_message is the fallback when the pending payload carries none", () => {
  paneWith(fakeSnapshot({ result: result(), pending: findingsGate(), gate_message: "There is no result to change yet." }));
  expect(screen.getByTestId("gate-message").textContent).toBe("There is no result to change yet.");
});

test("no gate message banner when the gate carries no message", () => {
  paneWith(fakeSnapshot({ result: result(), pending: findingsGate() }));
  expect(screen.queryByTestId("gate-message")).toBeNull();
});

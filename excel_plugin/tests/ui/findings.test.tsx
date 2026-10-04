import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "../../src/api/client";
import type { Finding, GridRow, Pending } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import type { RunState, RunStore } from "../../src/state/store";
import { FindingsList } from "../../src/ui/FindingsList";
import { Pane } from "../../src/ui/Pane";
import { REVIEW_SHEET, renderReview } from "../../src/office/review";
import { createFakeExcel } from "../support/excel-fake";
import { createFakeReview } from "../support/review-fake";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const f = (over: Partial<Finding>): Finding => ({
  code: "W1", severity: "warning", scope: "row", row: 2, source_row: 5, message: "msg", requires_ack: true, acknowledged: false, ...over,
});
const gridRow = (row: number): GridRow => ({
  row, ITEM_ID: `ID${row}`, NAME: "n", ITEM_TYPE: "Affiliate", DESCRIPTION: "", DONOTIMPORT: "", id_method: "direct",
  source_sheet: "S1", source_row: row + 3, source_id: null, source_name: null, flags: [], derivation: null, lineage: {},
});
const gate: Pending = { gate: "findings", message: null, blocked_reasons: [], allowed_actions: ["approve", "change"] };

function setup(findings: Finding[], opts: { busy?: boolean; respond?: RunStore["respond"]; pending?: Pending | null; run?: ExcelRun } = {}) {
  const fake = createFakeExcel({ S1: { grid: [[], [], [], [], [], ["x"]] } });
  const run = opts.run ?? (fake.run as ExcelRun);
  const result = { rows_emitted: 0, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: false, findings };
  const state: RunState = {
    runId: "r1", snap: fakeSnapshot({ layout: { sheet: "S1", header_row: 3 }, result, pending: opts.pending === undefined ? gate : opts.pending }),
    grid: [], activity: [], error: null, busy: opts.busy ?? false, connection: "connected", idleSeq: 0, snapIdleSeq: 0,
  };
  const respond = vi.fn(opts.respond ?? (async () => true));
  const store: RunStore = { get: () => state, subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), respond };
  const client = { sponsors: vi.fn(async () => []) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} run={run} />);
  return { fake, respond };
}

test("errors are listed before warnings and show message, row and source row", () => {
  setup([f({ code: "W1", message: "warn msg" }), f({ code: "E1", severity: "error", message: "err msg", row: 3, source_row: 6 })]);
  const items = screen.getAllByRole("listitem");
  expect(items[0]!.textContent).toContain("err msg");
  expect(items[0]!.textContent).toContain("Row 3");
  expect(items[0]!.textContent).toContain("Source row 6");
  expect(items[1]!.textContent).toContain("warn msg");
});

test("not mounted without findings", () => {
  setup([]);
  expect(screen.queryByTestId("findings-list")).toBeNull();
});

test("Acknowledge only when requires_ack and not acknowledged; posts the change", () => {
  const { respond } = setup([f({}), f({ code: "W2", acknowledged: true }), f({ code: "I1", severity: "info", requires_ack: false })]);
  expect(screen.queryByTestId("ack-W2-2")).toBeNull();
  expect(screen.queryByTestId("ack-I1-2")).toBeNull();
  expect(screen.getByText("Acknowledged")).toBeTruthy();
  fireEvent.click(screen.getByTestId("ack-W1-2"));
  expect(respond).toHaveBeenCalledWith({ action: "change", changes: [{ kind: "acknowledge_finding", code: "W1", row: 2 }] });
});

test("Exclude row requires a trimmed reason and posts exclude_row", async () => {
  const { respond } = setup([f({})]);
  fireEvent.click(screen.getByTestId("exclude-2"));
  const confirm = screen.getByTestId("exclude-confirm-2") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.input(screen.getByTestId("exclude-reason-2"), { target: { value: "   " } });
  expect(confirm.disabled).toBe(true);
  fireEvent.input(screen.getByTestId("exclude-reason-2"), { target: { value: "  duplicate  " } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(respond).toHaveBeenCalledWith({ action: "change", changes: [{ kind: "exclude_row", row: 2, reason: "duplicate" }] });
  await waitFor(() => expect(screen.queryByTestId("exclude-reason-2")).toBeNull());
});

test("a rejected exclusion keeps the reason for a retry", async () => {
  const { respond } = setup([f({})], { respond: async () => false });
  fireEvent.click(screen.getByTestId("exclude-2"));
  fireEvent.input(screen.getByTestId("exclude-reason-2"), { target: { value: "why" } });
  fireEvent.click(screen.getByTestId("exclude-confirm-2"));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((screen.getByTestId("exclude-confirm-2") as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByTestId("exclude-reason-2") as HTMLInputElement).value).toBe("why");
});

test("buttons are disabled while busy", () => {
  setup([f({})], { busy: true });
  expect((screen.getByTestId("ack-W1-2") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("exclude-2") as HTMLButtonElement).disabled).toBe(true);
});

// Records selections by sheet; `missing` sheets raise ItemNotFound like Excel.
function selectRecorder(missing: string[] = []) {
  const picked: string[] = [];
  const run: ExcelRun = async (cb) => {
    const ctx = {
      workbook: {
        worksheets: {
          getItem: (name: string) => {
            if (missing.includes(name)) throw Object.assign(new Error("nf"), { code: "ItemNotFound" });
            return { activate: () => {}, getRange: (addr: string) => ({ select: () => { picked.push(`${name}!${addr}`); } }) };
          },
        },
      },
      sync: async () => {},
    };
    return cb(ctx as never);
  };
  return { run, picked };
}

test("clicking the source row selects the Review row and the source cell", async () => {
  const review = createFakeReview();
  await renderReview(review.run as ExcelRun, [gridRow(2), gridRow(3)]);
  const rec = selectRecorder();
  setup([f({ row: 3, source_row: 5 })], { run: rec.run });
  fireEvent.click(screen.getByTestId("jump-W1-3-0"));
  // The Review row is selected by the owned sheet's id, never by a name a user sheet could share.
  await waitFor(() => expect(rec.picked).toEqual([`${review.sheet(REVIEW_SHEET)!.id}!A3`, "S1!A5"]));
});

test("a missing Review sheet still jumps to the source and says so", async () => {
  const review = createFakeReview();
  await renderReview(review.run as ExcelRun, [gridRow(2)]);
  const rec = selectRecorder([review.sheet(REVIEW_SHEET)!.id]);
  setup([f({})], { run: rec.run });
  fireEvent.click(screen.getByTestId("jump-W1-2-0"));
  expect((await screen.findByTestId("jump-note-W1-2-0")).textContent).toContain("Review");
  expect(rec.picked).toEqual(["S1!A5"]);
});

test("a missing sheet or Excel failure shows a message and never throws", async () => {
  const fake = createFakeExcel({});
  setup([f({})], { run: fake.run as ExcelRun });
  await act(async () => { fireEvent.click(screen.getByTestId("jump-W1-2-0")); });
  expect((await screen.findByTestId("jump-note-W1-2-0")).textContent).toContain("S1");

  cleanup();
  const boom: ExcelRun = () => Promise.reject(Object.assign(new Error("boom"), { code: "GeneralException" }));
  setup([f({})], { run: boom });
  fireEvent.click(screen.getByTestId("jump-W1-2-0"));
  expect((await screen.findByTestId("jump-note-W1-2-0")).textContent).toContain("boom");
});

test("Acknowledge and Exclude need the findings gate offering change, and say why when unavailable", () => {
  setup([f({})], { pending: { gate: "signoff", message: null, blocked_reasons: [], allowed_actions: ["approve", "reject"] } });
  expect((screen.getByTestId("ack-W1-2") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("exclude-2") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("findings-change-hint").textContent).toBe("Acknowledge and Exclude row are available at the findings gate.");
  cleanup();
  setup([f({})], { pending: { ...gate, gate: "findings", allowed_actions: ["approve", "reject"] } });
  expect((screen.getByTestId("ack-W1-2") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("findings-change-hint")).toBeTruthy();
  cleanup();
  // A re-entered brief gate lists "change" and the snapshot may still hold the last result: the brief would route
  // these to scoping and drop them, so they stay unavailable.
  const { respond } = setup([f({})], { pending: { gate: "brief", message: null, blocked_reasons: [], allowed_actions: ["approve", "answer", "change", "instruct", "reject"] } });
  expect((screen.getByTestId("ack-W1-2") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("exclude-2") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("findings-change-hint")).toBeTruthy();
  fireEvent.click(screen.getByTestId("ack-W1-2"));
  expect(respond).not.toHaveBeenCalled();
  cleanup();
  setup([f({})]);
  expect((screen.getByTestId("ack-W1-2") as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByTestId("findings-change-hint")).toBeNull();
});

test("two findings with the same code and row keep separate jump notes", async () => {
  const fake = createFakeExcel({});
  setup([f({ message: "first" }), f({ message: "second" })], { run: fake.run as ExcelRun });
  fireEvent.click(screen.getByTestId("jump-W1-2-1"));
  await screen.findByTestId("jump-note-W1-2-1");
  expect(screen.queryByTestId("jump-note-W1-2-0")).toBeNull();
});

function list(findings: Finding[], onExclude = vi.fn(async () => true)) {
  const props = { busy: false, canChange: true, onAck: vi.fn(), onExclude, onJump: vi.fn(async () => null) };
  const view = render(<FindingsList findings={findings} {...props} />);
  return { onExclude, rerender: (next: Finding[]) => view.rerender(<FindingsList findings={next} {...props} />) };
}

test("an open Exclude box stays with its finding when an earlier same-code finding disappears", async () => {
  const two = f({ row: 2 }), three = f({ row: 3 }), four = f({ row: 4 });
  const { onExclude, rerender } = list([two, three, four]);
  fireEvent.click(screen.getByTestId("exclude-3"));
  fireEvent.input(screen.getByTestId("exclude-reason-3"), { target: { value: "dup of 4" } });
  rerender([three, four]); // row 2's finding went away (a rebuild, another client)
  expect((screen.getByTestId("exclude-reason-3") as HTMLInputElement).value).toBe("dup of 4");
  expect(screen.queryByTestId("exclude-reason-4")).toBeNull();
  fireEvent.click(screen.getByTestId("exclude-confirm-3"));
  await waitFor(() => expect(onExclude).toHaveBeenCalledTimes(1));
  expect(onExclude).toHaveBeenCalledWith(three, "dup of 4");
});

test("two findings with the same code and row keep separate Exclude boxes and notes after a rebuild", async () => {
  const other = f({ code: "W0", row: 7 });
  const first = f({ message: "first" }), second = f({ message: "second" });
  const onJump = vi.fn(async (x: Finding) => (x.message === "second" ? "second failed" : null));
  const props = { busy: false, canChange: true, onAck: vi.fn(), onExclude: vi.fn(async () => true), onJump };
  const view = render(<FindingsList findings={[other, first, second]} {...props} />);
  fireEvent.click(screen.getByTestId("jump-W1-2-1"));
  expect((await screen.findByTestId("jump-note-W1-2-1")).textContent).toBe("second failed");
  view.rerender(<FindingsList findings={[first, second]} {...props} />);
  expect(screen.getByTestId("jump-note-W1-2-1").textContent).toBe("second failed");
  expect(screen.queryByTestId("jump-note-W1-2-0")).toBeNull();
  const excludes = screen.getAllByTestId("exclude-2");
  fireEvent.click(excludes[1]!);
  expect(screen.getAllByTestId("exclude-reason-2")).toHaveLength(1);
  expect(screen.getByTestId("exclude-reason-2").closest("li")!.textContent).toContain("second");
  expect(screen.getAllByTestId("exclude-2")).toHaveLength(1); // the first one is still a plain button
});

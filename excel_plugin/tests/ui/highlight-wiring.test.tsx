import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Brief, Pending } from "../../src/api/types";
import type { Client } from "../../src/api/client";
import type { ExcelRun } from "../../src/office/highlight";
import type { RunState, RunStore } from "../../src/state/store";
import { Pane } from "../../src/ui/Pane";
import { createFakeExcel, type FakeSelection } from "../support/excel-fake";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const brief: Brief = {
  source: { file: "f.xlsx", sheet: "S1", header_row: 3, rows_read: 2, rows_emitted: 2, rows_dropped: 0, drop_reasons: [] },
  bindings: [{ field: "affiliate_id", column: "Affiliate ID", route: "exact", confidence: 0.9, evidence: "e" }],
  id_strategy: "source_id", item_type: "Affiliate", recipe: { kind: "builtin", id: null },
  expected_findings: [], questions: [], confidence: 0.9, summary: "s",
};
const brief4: Pending = { gate: "brief", message: null, blocked_reasons: [], allowed_actions: ["approve"] };
const grid = [["Title"], [], ["Affiliate ID", "Affiliate Name", "Fund Complex"], ["a", "b", "c"], ["d", "e", "f"]];

function setup(selection: FakeSelection, sheetGrid: string[][] = grid) {
  const fake = createFakeExcel({ S1: { grid: sheetGrid } }, selection);
  const mk = (header_row: number, pending: Pending | null) =>
    fakeSnapshot({ brief, layout: { sheet: "S1", header_row }, pending });
  let state: RunState = { runId: "r1", snap: mk(3, brief4), grid: [], activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0 };
  const listeners = new Set<() => void>();
  const store: RunStore = {
    get: () => state, subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), respond: vi.fn(async () => true),
  };
  const update = (headerRow: number, pending: Pending | null) =>
    act(() => { state = { ...state, snap: mk(headerRow, pending) }; listeners.forEach((l) => l()); });
  const client = { sponsors: vi.fn(async () => []) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} run={fake.run as ExcelRun} />);
  return { fake, log: fake.log, store, update, selects: () => fake.log.filter((l) => l.startsWith("select")) };
}

test("the brief gate activates the sheet and selects the header row once", async () => {
  const { log, store } = setup({ sheet: "S1", columnIndex: 0, columnCount: 1 });
  await waitFor(() => expect(log).toContain("select S1!A3:C3"));
  expect(log).toContain("activate S1");
  expect(store.respond).not.toHaveBeenCalled();
});

test("a gate bounce does not re-select; a changed header_row does", async () => {
  const { log, update } = setup({ sheet: "S1", columnIndex: 0, columnCount: 1 });
  await waitFor(() => expect(log).toContain("select S1!A3:C3"));
  update(3, null);
  update(3, brief4);
  await new Promise((r) => setTimeout(r, 20));
  expect(log.filter((l) => l === "select S1!A3:C3")).toHaveLength(1);
  update(4, brief4);
  await waitFor(() => expect(log).toContain("select S1!A4:C4"));
});

test("hover, focus and Use selected column never select a column; Show in sheet does", async () => {
  const { log, selects } = setup({ sheet: "S1", columnIndex: 0, columnCount: 1 });
  await waitFor(() => expect(log).toContain("select S1!A3:C3"));
  const before = selects().length;
  const li = screen.getByText("affiliate_id").closest("li")!;
  fireEvent.mouseEnter(li);
  fireEvent.focusIn(li);
  fireEvent.mouseOver(screen.getByRole("button", { name: "Use selected column" }));
  await new Promise((r) => setTimeout(r, 20));
  expect(selects()).toHaveLength(before);
  fireEvent.click(screen.getByRole("button", { name: "Show in sheet" }));
  await waitFor(() => expect(log).toContain("select S1!A1:A5"));
});

test("Use selected column reads the user's selection at click time and posts only then", async () => {
  const { fake, store, selects, log } = setup({ sheet: "S1", columnIndex: 0, columnCount: 1 });
  await waitFor(() => expect(log).toContain("select S1!A3:C3"));
  fake.userSelect({ sheet: "S1", columnIndex: 2, columnCount: 1 }); // the user picks column C
  expect(store.respond).not.toHaveBeenCalled();
  const before = selects().length;
  fireEvent.click(screen.getByRole("button", { name: "Use selected column" }));
  await waitFor(() =>
    expect(store.respond).toHaveBeenCalledWith({ action: "change", changes: [{ kind: "set_column_binding", field: "affiliate_id", column: "Fund Complex" }] }),
  );
  expect(selects()).toHaveLength(before);
});

test("a multi-column selection shows a message and posts nothing", async () => {
  const { fake, store, log } = setup({ sheet: "S1", columnIndex: 0, columnCount: 1 });
  await waitFor(() => expect(log).toContain("select S1!A3:C3"));
  fake.userSelect({ sheet: "S1", columnIndex: 0, columnCount: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Use selected column" }));
  await screen.findByTestId("selection-note");
  expect(store.respond).not.toHaveBeenCalled();
});

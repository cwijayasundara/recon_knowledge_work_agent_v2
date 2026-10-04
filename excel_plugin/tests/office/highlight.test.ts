import { expect, test } from "vitest";
import {
  columnLetter,
  readSelectedColumn,
  selectColumn,
  selectHeaderRow,
  selectSheet,
  selectSourceCell,
  sourceRowOffset,
  type ExcelRun,
} from "../../src/office/highlight";
import { createFakeExcel, type FakeSelection, type FakeSheetSpec } from "../support/excel-fake";

function setup(sheets: Record<string, FakeSheetSpec>, selection?: FakeSelection) {
  const f = createFakeExcel(sheets, selection);
  return { run: f.run as ExcelRun, log: f.log };
}

const grid = [["Title"], [], ["Affiliate ID", "Affiliate Name", " Fund Complex "], ["a", "b", "c"], ["d", "e", "f"]];

test("columnLetter", () => {
  expect(columnLetter(1)).toBe("A");
  expect(columnLetter(26)).toBe("Z");
  expect(columnLetter(27)).toBe("AA");
  expect(columnLetter(52)).toBe("AZ");
  expect(columnLetter(703)).toBe("AAA");
});

test("selectSheet activates the named sheet; missing returns false without throwing", async () => {
  const { run, log } = setup({ S: { grid } });
  expect(await selectSheet(run, "S")).toBe(true);
  expect(log).toEqual(["activate S"]);
  expect(await selectSheet(run, "Nope")).toBe(false);
});

test("selectHeaderRow selects A<row>:<lastCol><row> across the used width", async () => {
  const { run, log } = setup({ S: { grid } });
  expect(await selectHeaderRow(run, "S", 3)).toBe(true);
  expect(log).toContain("activate S");
  expect(log).toContain("select S!A3:C3");
  expect(await selectHeaderRow(run, "Nope", 3)).toBe(false);
});

test("selectColumn finds the trimmed header and selects the full used column", async () => {
  const { run, log } = setup({ S: { grid } });
  expect(await selectColumn(run, "S", 3, "Fund Complex")).toBe(true);
  expect(log).toContain("select S!C1:C5");
  expect(await selectColumn(run, "S", 3, "Affiliate Name")).toBe(true);
  expect(log).toContain("select S!B1:B5");
});

test("selectColumn with a missing header selects nothing and returns false", async () => {
  const { run, log } = setup({ S: { grid } });
  expect(await selectColumn(run, "S", 3, "Nope")).toBe(false);
  expect(log.filter((l) => l.startsWith("select"))).toEqual([]);
  expect(await selectColumn(run, "Nope", 3, "Affiliate ID")).toBe(false);
});

test("selectSourceCell: server grid row N is Excel row N (offset 0)", async () => {
  expect(sourceRowOffset()).toBe(0);
  const { run, log } = setup({ S: { grid } });
  expect(await selectSourceCell(run, "S", 4)).toBe(true);
  expect(log).toContain("select S!A4");
  expect(await selectSourceCell(run, "S", 4, "B")).toBe(true);
  expect(log).toContain("select S!B4");
  expect(await selectSourceCell(run, "Nope", 4)).toBe(false);
});

// Rule found against the SDK reader (skip_empty_area=False): the grid is anchored at A1, so a
// used range that starts at C3 does not shift row or column numbers.
test("offset rule: a used range starting at C3 does not shift rows or columns", async () => {
  const shifted = [[], [], ["", "", "Affiliate ID", "Name"], ["", "", "x", "y"]];
  const { run, log } = setup({ S: { grid: shifted, origin: { row: 2, col: 2 } } });
  expect(await selectHeaderRow(run, "S", 3)).toBe(true);
  expect(log).toContain("select S!A3:D3");
  expect(await selectColumn(run, "S", 3, "Affiliate ID")).toBe(true);
  expect(log).toContain("select S!C1:C4");
  expect(await selectSourceCell(run, "S", 4)).toBe(true);
  expect(log).toContain("select S!A4");
});

test("readSelectedColumn resolves the header text of a single selected column", async () => {
  const { run } = setup({ S: { grid } }, { sheet: "S", rowIndex: 3, columnIndex: 2, rowCount: 2, columnCount: 1 });
  expect(await readSelectedColumn(run, "S", 3)).toEqual({ ok: true, header: "Fund Complex" });
});

test("readSelectedColumn rejects multi-column, other-sheet and out-of-table selections", async () => {
  const multi = setup({ S: { grid } }, { sheet: "S", rowIndex: 3, columnIndex: 0, rowCount: 1, columnCount: 2 });
  expect(await readSelectedColumn(multi.run, "S", 3)).toMatchObject({ ok: false, message: expect.stringMatching(/one column/i) as string });
  const other = setup({ S: { grid } }, { sheet: "T", rowIndex: 3, columnIndex: 0, rowCount: 1, columnCount: 1 });
  expect(await readSelectedColumn(other.run, "S", 3)).toMatchObject({ ok: false });
  const outside = setup({ S: { grid } }, { sheet: "S", rowIndex: 3, columnIndex: 7, rowCount: 1, columnCount: 1 });
  expect(await readSelectedColumn(outside.run, "S", 3)).toMatchObject({ ok: false, message: expect.stringMatching(/header/i) as string });
});

test("readSelectedColumn rejects duplicate and blank headers; selectColumn refuses duplicates", async () => {
  const dup = [["Name", "Name", ""]];
  const second = setup({ S: { grid: dup } }, { sheet: "S", columnIndex: 1, columnCount: 1 });
  expect(await readSelectedColumn(second.run, "S", 1)).toEqual({ ok: false, message: 'Header "Name" appears more than once; rename one' });
  expect(await selectColumn(second.run, "S", 1, "Name")).toBe(false);
  expect(second.log.filter((l) => l.startsWith("select"))).toEqual([]);
  const blank = setup({ S: { grid: [["Name", "Name", "", "X"]] } }, { sheet: "S", columnIndex: 2, columnCount: 1 });
  expect(await readSelectedColumn(blank.run, "S", 1)).toMatchObject({ ok: false, message: expect.stringMatching(/no header/i) as string });
});

test("non-ItemNotFound errors are not swallowed", async () => {
  const run: ExcelRun = () => Promise.reject(new Error("boom"));
  await expect(selectSheet(run, "S")).rejects.toThrow("boom");
  expect(await readSelectedColumn(run, "S", 1)).toEqual({ ok: false, message: expect.stringContaining("boom") as string });
});

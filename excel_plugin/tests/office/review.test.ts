import { expect, test, vi } from "vitest";
import type { GridRow } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import { CONFLICT_MESSAGE, OWNER_MARK, REVIEW_COLUMNS, REVIEW_SHEET, ReviewSheetConflict, removeReviewSheet, renderReview, selectReviewRow, watchReview } from "../../src/office/review";
import { createFakeReview } from "../support/review-fake";

function gridRow(row: number, over: Partial<GridRow> = {}): GridRow {
  return {
    row, ITEM_ID: `ID${row}`, NAME: `Name ${row}`, ITEM_TYPE: "Affiliate", DESCRIPTION: "d", DONOTIMPORT: "",
    id_method: "direct", source_sheet: "S1", source_row: row + 3, source_id: null, source_name: null,
    flags: [], derivation: null, lineage: {}, ...over,
  };
}
const rows = [gridRow(2, { flags: ["DUP", "LONG"] }), gridRow(3, { NAME: "=SUM(A1)" }), gridRow(4)];

async function setup(opts: { emitOnWrite?: boolean } = {}) {
  const fake = createFakeReview(opts);
  const run = fake.run as ExcelRun;
  await renderReview(run, rows);
  return { fake, run };
}

test("constants", () => {
  expect(REVIEW_SHEET).toBe("Onboarding Review");
  expect(REVIEW_COLUMNS).toHaveLength(10);
});

test("values are text: the format call precedes the values call and a formula-like value stays literal", async () => {
  const { fake } = await setup();
  const firstFormat = fake.log.findIndex((l) => l.startsWith("format"));
  const firstValues = fake.log.findIndex((l) => l.startsWith("values"));
  expect(firstFormat).toBeGreaterThanOrEqual(0);
  expect(firstFormat).toBeLessThan(firstValues);
  expect(fake.sheet(REVIEW_SHEET)!.formats.get("3,3")).toBe("@");
  expect(fake.read(REVIEW_SHEET, "C3:C3")).toEqual([["=SUM(A1)"]]);
});

test("rows are written in column order with flags joined; header is frozen; sheet protected", async () => {
  const { fake } = await setup();
  expect(fake.read(REVIEW_SHEET, "A1:J1")).toEqual([[...REVIEW_COLUMNS]]);
  expect(fake.read(REVIEW_SHEET, "A2:J2")).toEqual([["2", "ID2", "Name 2", "Affiliate", "d", "", "direct", "DUP, LONG", "S1", "5"]]);
  expect(fake.sheet(REVIEW_SHEET)).toMatchObject({ protected: true, frozen: 1 });
  expect(fake.log).toContain('protect {"allowFormatColumns":true,"allowSort":false}');
});

test("only the ITEM_ID column is unlocked", async () => {
  const { fake } = await setup();
  for (let r = 2; r <= 4; r++) {
    expect(fake.isLocked(REVIEW_SHEET, r, 2)).toBe(false);
    for (const c of [1, 3, 4, 10]) expect(fake.isLocked(REVIEW_SHEET, r, c)).toBe(true);
  }
  expect(fake.isLocked(REVIEW_SHEET, 1, 2)).toBe(true);
});

test("re-render unprotects, replaces content and re-protects", async () => {
  const { fake, run } = await setup();
  await renderReview(run, [gridRow(9)]);
  expect(fake.log).toContain("unprotect");
  expect(fake.read(REVIEW_SHEET, "A2:B3")).toEqual([["9", "ID9"], ["", ""]]);
  expect(fake.sheet(REVIEW_SHEET)!.protected).toBe(true);
});

test("more than 500 rows are written in chunks", async () => {
  const fake = createFakeReview();
  const many = Array.from({ length: 1200 }, (_, i) => gridRow(i + 2));
  await renderReview(fake.run as ExcelRun, many);
  expect(fake.log.filter((l) => l.startsWith("values"))).toHaveLength(4); // header + 3 chunks
  expect(fake.read(REVIEW_SHEET, "B1201:B1201")).toEqual([["ID1201"]]);
});

test("an ITEM_ID edit calls onEdit once with the grid row and reverts the cell", async () => {
  const { fake, run } = await setup();
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "B3:B3", [["NEW"]]);
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenCalledWith({ row: 3, value: "NEW" }, { index: 0, count: 1 });
  expect(fake.read(REVIEW_SHEET, "B3:B3")).toEqual([["ID3"]]);
  expect(fake.sheet(REVIEW_SHEET)!.protected).toBe(true);
});

test("the revert does not loop: its own change event reports nothing", async () => {
  const { fake, run } = await setup({ emitOnWrite: true });
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "B2:B2", [["X"]]);
  await fake.flush();
  await fake.flush();
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(fake.log.filter((l) => l === "values B2:B2")).toHaveLength(1);
  expect(fake.read(REVIEW_SHEET, "B2:B2")).toEqual([["ID2"]]);
});

test("the row maps through the Row cell, not the position", async () => {
  const fake = createFakeReview();
  const run = fake.run as ExcelRun;
  await renderReview(run, [gridRow(40), gridRow(7)]);
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "B3:B3", [["Z"]]);
  expect(onEdit).toHaveBeenCalledWith({ row: 7, value: "Z" }, { index: 0, count: 1 });
});

test("an edit to another column reverts with no onEdit", async () => {
  const { fake, run } = await setup();
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "C2:C2", [["hacked"]]);
  expect(onEdit).not.toHaveBeenCalled();
  expect(fake.read(REVIEW_SHEET, "C2:C2")).toEqual([["Name 2"]]);
  expect(fake.sheet(REVIEW_SHEET)!.protected).toBe(true);
});

test("a paste over several cells reverts each and reports ITEM_ID cells only", async () => {
  const { fake, run } = await setup();
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "B2:C4", [["a", "b"], ["c", "d"], ["e", "f"]]);
  expect(onEdit.mock.calls.map((c) => c[0])).toEqual([{ row: 2, value: "a" }, { row: 3, value: "c" }, { row: 4, value: "e" }]);
  expect(fake.read(REVIEW_SHEET, "B2:C4")).toEqual([["ID2", "Name 2"], ["ID3", "=SUM(A1)"], ["ID4", "Name 4"]]);
});

test("a header edit is reverted without onEdit; out-of-range edits are ignored", async () => {
  const { fake, run } = await setup();
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "B1:B1", [["x"]]);
  expect(fake.read(REVIEW_SHEET, "B1:B1")).toEqual([["ITEM_ID"]]);
  await fake.userEdit(REVIEW_SHEET, "B50:B50", [["x"]]);
  await fake.userEdit(REVIEW_SHEET, "L2:L2", [["x"]]);
  expect(onEdit).not.toHaveBeenCalled();
});

test("an edit that keeps the rendered value does nothing", async () => {
  const { fake, run } = await setup();
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "B2:B2", [["ID2"]]);
  expect(onEdit).not.toHaveBeenCalled();
  expect(fake.log.filter((l) => l.startsWith("values")).length).toBe(1 + 1); // render only (header + one chunk)
});

test("a change event after the sheet was deleted does not throw; unregister works", async () => {
  const { fake, run } = await setup();
  const onEdit = vi.fn();
  const unregister = await watchReview(run, onEdit);
  fake.deleteSheet(REVIEW_SHEET);
  await expect(fake.fire(REVIEW_SHEET, "B2:B2")).resolves.toBeUndefined();
  await expect(unregister()).resolves.toBeUndefined();
  expect(fake.handlerCount()).toBe(0);
  expect(onEdit).not.toHaveBeenCalled();
});

test("a recreated sheet is watched without re-registering", async () => {
  const { fake, run } = await setup();
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  fake.deleteSheet(REVIEW_SHEET);
  await renderReview(run, rows);
  await fake.userEdit(REVIEW_SHEET, "B2:B2", [["N"]]);
  expect(onEdit).toHaveBeenCalledWith({ row: 2, value: "N" }, { index: 0, count: 1 });
});

test("a user edit that lands mid-render is reverted and reported, not dropped", async () => {
  const fake = createFakeReview();
  const run = fake.run as ExcelRun;
  await renderReview(run, rows);
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  const many = Array.from({ length: 1200 }, (_, i) => gridRow(i + 2));
  let fired = false;
  let edit: Promise<void> = Promise.resolve();
  fake.hooks.afterSync = () => {
    // Fires once the values are written, before the render's final sync.
    if (!fired && fake.sheet(REVIEW_SHEET) && fake.read(REVIEW_SHEET, "B1201:B1201")[0]![0] === "ID1201") {
      fired = true;
      edit = fake.userEdit(REVIEW_SHEET, "B5:B5", [["MID"]]);
    }
  };
  await renderReview(run, many);
  await edit;
  await fake.flush();
  expect(fired).toBe(true);
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit.mock.calls[0]![0]).toEqual({ row: 5, value: "MID" });
  expect(fake.read(REVIEW_SHEET, "B5:B5")).toEqual([["ID5"]]);
});

test("a paste that changes the number format is reverted to exact text, stays text-formatted and does not loop", async () => {
  const fake = createFakeReview();
  const run = fake.run as ExcelRun;
  await renderReview(run, [gridRow(2, { ITEM_ID: "00123" }), gridRow(3, { NAME: "=SUM(A1)" })]);
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  await fake.userEdit(REVIEW_SHEET, "B2:B2", [["999"]], "General");
  await fake.flush();
  await fake.flush();
  expect(fake.read(REVIEW_SHEET, "B2:B2")).toEqual([["00123"]]);
  expect(fake.format(REVIEW_SHEET, 2, 2)).toBe("@");
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(fake.log.filter((l) => l === "values B2:B2")).toHaveLength(1);
  // A pasted General cell over a text cell must not turn a rendered "=..." into a formula.
  await fake.userEdit(REVIEW_SHEET, "C3:C3", [["x"]], "General");
  await fake.flush();
  expect(fake.read(REVIEW_SHEET, "C3:C3")).toEqual([["=SUM(A1)"]]);
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(fake.sheet(REVIEW_SHEET)!.protected).toBe(true);
});

test("a change on another worksheet costs no Excel run", async () => {
  const { fake, run } = await setup();
  await watchReview(run, vi.fn());
  fake.addSheet("Other");
  const before = fake.runs();
  await fake.fire("Other", "B2:B2");
  expect(fake.runs()).toBe(before);
});

test("a revert whose write throws still re-protects the sheet and reports the error", async () => {
  const { fake, run } = await setup();
  const onError = vi.fn();
  await watchReview(run, vi.fn(), onError);
  fake.failWrites(REVIEW_SHEET);
  await expect(fake.userEdit(REVIEW_SHEET, "C2:C2", [["x"]])).resolves.toBeUndefined();
  expect(fake.sheet(REVIEW_SHEET)!.protected).toBe(true);
  expect(onError).toHaveBeenCalledWith("Could not restore the 'Onboarding Review' sheet: write failed");
});

test("the add-in marks the sheet it creates as its own", async () => {
  const { fake } = await setup();
  expect(fake.sheet(REVIEW_SHEET)!.names.has(OWNER_MARK)).toBe(true);
  expect(fake.log).toContain(`name ${OWNER_MARK}`);
  expect(fake.log).toContain(`name ${OWNER_MARK} visible=false`);
});

test("a user's sheet named like the Review sheet is never cleared or written: the render is refused with a clear message", async () => {
  const fake = createFakeReview();
  const run = fake.run as ExcelRun;
  const mine = fake.addSheet(REVIEW_SHEET);
  mine.values.set("1,1", "my data");
  const failure = renderReview(run, rows);
  await expect(failure).rejects.toBeInstanceOf(ReviewSheetConflict);
  await expect(failure).rejects.toThrow(CONFLICT_MESSAGE);
  expect(CONFLICT_MESSAGE).toBe("A sheet named 'Onboarding Review' already exists and wasn't created by this add-in; rename it.");
  expect(fake.read(REVIEW_SHEET, "A1:A1")).toEqual([["my data"]]);
  expect(fake.log.some((l) => l === "clear" || l.startsWith("values") || l.startsWith("format") || l === "unprotect")).toBe(false);
});

test("edits on a user's same-named sheet are never reverted, even after an earlier owned render", async () => {
  const fake = createFakeReview();
  const run = fake.run as ExcelRun;
  await renderReview(run, rows);
  const onEdit = vi.fn();
  await watchReview(run, onEdit);
  fake.deleteSheet(REVIEW_SHEET);
  fake.addSheet(REVIEW_SHEET);
  await expect(renderReview(run, rows)).rejects.toBeInstanceOf(ReviewSheetConflict);
  await fake.userEdit(REVIEW_SHEET, "B2:B2", [["mine"]]);
  expect(fake.read(REVIEW_SHEET, "B2:B2")).toEqual([["mine"]]);
  expect(onEdit).not.toHaveBeenCalled();
  expect(await selectReviewRow(run, 2)).toBe(false);
});

test("ownership survives a reload: a marked sheet from an earlier session is reused", async () => {
  const fake = createFakeReview();
  const run = fake.run as ExcelRun;
  fake.addSheet(REVIEW_SHEET, [OWNER_MARK]).values.set("2,2", "stale");
  await renderReview(run, rows);
  expect(fake.read(REVIEW_SHEET, "B2:B2")).toEqual([["ID2"]]);
  expect(fake.sheetNames().filter((n) => n === REVIEW_SHEET)).toHaveLength(1);
});

test("removeReviewSheet deletes only the add-in's own sheet", async () => {
  const { fake, run } = await setup();
  fake.addSheet("Review"); // a user sheet with the old name is someone else's data
  expect(await removeReviewSheet(run)).toBe(true);
  expect(fake.sheet(REVIEW_SHEET)).toBeUndefined();
  expect(fake.sheet("Review")).toBeTruthy();
  expect(await selectReviewRow(run, 2)).toBe(false);
  expect(await removeReviewSheet(run)).toBe(false); // nothing left to remove

  const other = createFakeReview();
  other.addSheet(REVIEW_SHEET);
  expect(await removeReviewSheet(other.run as ExcelRun)).toBe(false);
  expect(other.sheet(REVIEW_SHEET)).toBeTruthy();
});

test("a failed removal rejects so the caller can block the upload", async () => {
  const { fake, run } = await setup();
  fake.failDeletes(true);
  await expect(removeReviewSheet(run)).rejects.toThrow("delete failed");
  expect(fake.sheet(REVIEW_SHEET)).toBeTruthy();
});

test("a render or removal whose caller already gave up (aborted signal) does nothing when it starts", async () => {
  const { fake, run } = await setup();
  const gaveUp = new AbortController();
  gaveUp.abort();
  expect(await removeReviewSheet(run, gaveUp.signal)).toBe(false);
  expect(fake.sheetNames()).toContain(REVIEW_SHEET);
  const empty = createFakeReview();
  await renderReview(empty.run as ExcelRun, rows, gaveUp.signal);
  expect(empty.sheetNames()).not.toContain(REVIEW_SHEET);
  expect(await removeReviewSheet(run, new AbortController().signal)).toBe(true);
});

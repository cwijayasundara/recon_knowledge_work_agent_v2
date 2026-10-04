import type { GridRow } from "../api/types";
import { columnLetter, enqueue, guarded, type ExcelRun } from "./highlight";

export const REVIEW_SHEET = "Onboarding Review";
/**
 * Ownership marker: a worksheet-scoped name (ExcelApi 1.4) on the sheet the add-in created. It is saved with the
 * workbook, so ownership survives a pane reload or reopening the file, and it disappears with the sheet.
 */
export const OWNER_MARK = "OnboardingReviewOwner";
export const CONFLICT_MESSAGE = `A sheet named '${REVIEW_SHEET}' already exists and wasn't created by this add-in; rename it.`;

/** A same-named sheet the add-in did not create: it is the user's, so it is never cleared, written or deleted. */
export class ReviewSheetConflict extends Error {
  constructor() {
    super(CONFLICT_MESSAGE);
    this.name = "ReviewSheetConflict";
  }
}
export const REVIEW_COLUMNS = ["Row", "ITEM_ID", "NAME", "ITEM_TYPE", "DESCRIPTION", "DONOTIMPORT", "ID method", "Flags", "Source sheet", "Source row"] as const;

const WIDTH = REVIEW_COLUMNS.length;
const CHUNK = 500;
const ITEM_ID_COL = 2;
const PROTECTION: Excel.WorksheetProtectionOptions = { allowFormatColumns: true, allowSort: false };

const NOTHING_RENDERED = () => ({ header: [...REVIEW_COLUMNS], rows: [] as string[][], byRow: new Map<number, string[]>() });
/** What the add-in last wrote: the Review sheet is a view, so edits are reverted to these values. */
let rendered: { header: string[]; rows: string[][]; byRow: Map<number, string[]> } = NOTHING_RENDERED();
/** Id of the add-in-owned Review sheet as last rendered; null when there is none. Events for any other sheet are ignored. */
let reviewSheetId: string | null = null;

function toCells(r: GridRow): string[] {
  return [String(r.row), r.ITEM_ID, r.NAME, r.ITEM_TYPE, r.DESCRIPTION, r.DONOTIMPORT, r.id_method, r.flags.join(", "), r.source_sheet, String(r.source_row)];
}

function* chunks<T>(items: T[]): Generator<{ start: number; items: T[] }> {
  for (let i = 0; i < items.length; i += CHUNK) yield { start: i, items: items.slice(i, i + CHUNK) };
}

async function isProtected(ctx: Excel.RequestContext, ws: Excel.Worksheet): Promise<boolean> {
  ws.protection.load("protected");
  await ctx.sync();
  return ws.protection.protected;
}

function forget(): void {
  reviewSheetId = null;
  rendered = NOTHING_RENDERED();
}

/** The sheet named REVIEW_SHEET and whether the add-in created it; null when there is no such sheet. */
async function findReviewSheet(ctx: Excel.RequestContext): Promise<{ ws: Excel.Worksheet; owned: boolean } | null> {
  const found = ctx.workbook.worksheets.getItemOrNullObject(REVIEW_SHEET);
  found.load("isNullObject,id");
  await ctx.sync();
  if (found.isNullObject) return null;
  const mark = found.names.getItemOrNullObject(OWNER_MARK);
  mark.load("isNullObject");
  await ctx.sync();
  return { ws: found, owned: !mark.isNullObject };
}

/**
 * Renders the grid into the add-in's own Review sheet; rejects with ReviewSheetConflict when the name is taken by a user
 * sheet. Skipped when `signal` has aborted before the render starts (a caller stopped waiting for it).
 */
export function renderReview(run: ExcelRun, rows: GridRow[], signal?: AbortSignal): Promise<void> {
  return enqueue(() =>
      run(async (ctx) => {
        if (signal?.aborted) return;
        const existing = await findReviewSheet(ctx);
        let ws: Excel.Worksheet;
        if (existing === null) {
          ws = ctx.workbook.worksheets.add(REVIEW_SHEET);
          const mark = ws.names.add(OWNER_MARK, ws.getRange("A1"), "Created by the onboarding add-in; the sheet is replaced on every render.");
          mark.visible = false; // hidden from Name Manager (ExcelApi 1.1), so it is not tidied away by accident
          ws.load("id");
          await ctx.sync();
        } else if (!existing.owned) {
          forget();
          throw new ReviewSheetConflict();
        } else {
          ws = existing.ws;
          if (await isProtected(ctx, ws)) ws.protection.unprotect();
          ws.getRange().clear();
        }
        reviewSheetId = ws.id;
        const table = rows.map(toCells);
        rendered = { header: [...REVIEW_COLUMNS], rows: table, byRow: new Map(rows.map((r, i) => [r.row, table[i]!])) };
        const last = table.length + 1;
        const lastCol = columnLetter(WIDTH);
        // Text format first, so a source value such as =SUM(A1) is stored as literal text.
        for (const c of chunks([[...REVIEW_COLUMNS] as string[], ...table])) {
          const first = c.start + 1;
          ws.getRange(`A${first}:${lastCol}${first + c.items.length - 1}`).numberFormat = c.items.map((r) => r.map(() => "@"));
        }
        await ctx.sync();
        ws.getRange(`A1:${lastCol}1`).values = [[...REVIEW_COLUMNS]];
        for (const c of chunks(table)) {
          const first = c.start + 2;
          ws.getRange(`A${first}:${lastCol}${first + c.items.length - 1}`).values = c.items;
        }
        await ctx.sync();
        if (last >= 2) ws.getRange(`B2:B${last}`).format.protection.locked = false;
        ws.getRange(`A1:${lastCol}1`).format.font.bold = true;
        ws.freezePanes.freezeRows(1);
        ws.protection.protect(PROTECTION);
        await ctx.sync();
      }),
  );
}

/**
 * Deletes the add-in-owned Review sheet (a rendering, so nothing is lost) so it is not uploaded with the workbook.
 * A same-named sheet the add-in did not create is left alone. Resolves true when a sheet was deleted. Skipped when
 * `signal` has aborted before the removal starts: the caller gave up on it, and a later render must not be undone.
 */
export function removeReviewSheet(run: ExcelRun, signal?: AbortSignal): Promise<boolean> {
  return enqueue(() =>
    run(async (ctx) => {
      if (signal?.aborted) return false;
      const existing = await findReviewSheet(ctx);
      if (existing === null || !existing.owned) return false;
      existing.ws.delete();
      await ctx.sync();
      forget();
      return true;
    }),
  );
}

/** Selects the "Row" cell of grid row `row` on the Review sheet; false when the sheet or the row is absent. */
export function selectReviewRow(run: ExcelRun, row: number): Promise<boolean> {
  return guarded(() =>
    run(async (ctx) => {
      const index = rendered.rows.findIndex((r) => r[0] === String(row));
      if (index < 0 || reviewSheetId === null) return false;
      const ws = ctx.workbook.worksheets.getItem(reviewSheetId);
      ws.activate();
      ws.getRange(`${columnLetter(REVIEW_COLUMNS.indexOf("Row") + 1)}${index + 2}`).select();
      await ctx.sync();
      return true;
    }),
  );
}

const colNum = (s: string): number => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

function parseAddress(address: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(address.slice(address.lastIndexOf("!") + 1).replaceAll("$", ""));
  if (!m) return null;
  return { c1: colNum(m[1]!), r1: Number(m[2]), c2: colNum(m[3] ?? m[1]!), r2: Number(m[4] ?? m[2]) };
}

/** The rendered row for a sheet row: found by its Row cell, positionally when that cell itself was edited. */
function expectedRow(sheetRow: number, rowCell: string, rowColumnIncluded: boolean): string[] | undefined {
  if (sheetRow === 1) return rendered.header;
  const positional = rendered.rows[sheetRow - 2];
  const keyed = rendered.byRow.get(Number(rowCell));
  if (rowColumnIncluded && positional && positional[0] !== rowCell) return positional;
  return keyed ?? positional;
}

export interface ReviewEdit { row: number; value: string }
/** Position of an edit within one change event, so a multi-cell paste can be told apart from single edits. */
export interface EditBatch { index: number; count: number }

/**
 * Reverts every edit to the last rendered value and reports ITEM_ID edits. Events for the add-in's own
 * writes find nothing to revert (values already equal the rendered ones), so a revert cannot loop.
 * Listens on the worksheet collection so the registration survives the sheet being deleted and recreated.
 */
export async function watchReview(run: ExcelRun, onEdit: (e: ReviewEdit, batch: EditBatch) => void, onError: (message: string) => void = () => {}): Promise<() => Promise<void>> {
  const handler = async (args: Excel.WorksheetChangedEventArgs): Promise<void> => {
    // Only the add-in's own rendered sheet is reverted; a user's sheet (even one with the same name) is never touched.
    if (reviewSheetId === null || args.worksheetId !== reviewSheetId) return;
    const p = parseAddress(args.address);
    if (!p) return;
    let edits: ReviewEdit[];
    try {
      edits = await enqueue(() =>
      run(async (ctx): Promise<ReviewEdit[]> => {
        // Clipped here, after any render in flight has published its rows.
        const r1 = Math.max(p.r1, 1), r2 = Math.min(p.r2, rendered.rows.length + 1);
        const c1 = Math.max(p.c1, 1), c2 = Math.min(p.c2, WIDTH);
        if (r1 > r2 || c1 > c2) return [];
        const named = ctx.workbook.worksheets.getItemOrNullObject(args.worksheetId);
        named.load("isNullObject,name");
        await ctx.sync();
        if (named.isNullObject || named.name !== REVIEW_SHEET) return [];
        const ws = named;
        const changed = ws.getRange(`${columnLetter(c1)}${r1}:${columnLetter(c2)}${r2}`);
        const rowIds = ws.getRange(`A${r1}:A${r2}`);
        changed.load("values");
        rowIds.load("values");
        await ctx.sync();
        const found: ReviewEdit[] = [];
        let differs = false;
        const restored = changed.values.map((cells, i) => {
          const sheetRow = r1 + i;
          const expected = expectedRow(sheetRow, String(rowIds.values[i]?.[0] ?? ""), c1 <= 1);
          return cells.map((v, j) => {
            const col = c1 + j;
            const was = expected?.[col - 1] ?? "";
            const now = String(v ?? "");
            if (now === was) return was;
            differs = true;
            if (col === ITEM_ID_COL && sheetRow >= 2 && expected) found.push({ row: Number(expected[0]), value: now });
            return was;
          });
        });
        if (!differs) return [];
        const wasProtected = await isProtected(ctx, ws);
        if (wasProtected) {
          ws.protection.unprotect();
          await ctx.sync();
        }
        try {
          // A paste can change the destination's number format; restore text before writing values back.
          const ranges = [...chunks(restored)].map((c) => {
            const first = r1 + c.start;
            return { c, range: ws.getRange(`${columnLetter(c1)}${first}:${columnLetter(c2)}${first + c.items.length - 1}`) };
          });
          for (const { c, range } of ranges) range.numberFormat = c.items.map((r) => r.map(() => "@"));
          await ctx.sync();
          for (const { c, range } of ranges) range.values = c.items;
          await ctx.sync();
        } finally {
          if (wasProtected) {
            ws.protection.protect(PROTECTION);
            await ctx.sync();
          }
        }
        return found;
      }),
      );
    } catch (e) {
      onError(`Could not restore the '${REVIEW_SHEET}' sheet: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    edits.forEach((e, index) => onEdit(e, { index, count: edits.length }));
  };

  const registration = await enqueue(() =>
    run(async (ctx) => {
      const result = ctx.workbook.worksheets.onChanged.add((args) => handler(args));
      await ctx.sync();
      return result;
    }),
  );
  return async () => {
    try {
      await run(async () => {
        registration.remove();
        await registration.context.sync();
      });
    } catch {
      // The workbook may already be closed; there is nothing left to unregister.
    }
  };
}

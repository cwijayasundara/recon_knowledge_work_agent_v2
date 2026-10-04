// Selection only: these helpers move the user's selection and never write to the workbook.
export type ExcelRun = <T>(cb: (ctx: Excel.RequestContext) => Promise<T>) => Promise<T>;

export const excelRun: ExcelRun = (cb) => Excel.run(cb);

/**
 * Server grid row N is Excel row N and grid column i is Excel column i: the SDK reader keeps
 * leading blank rows and columns (skip_empty_area=False), so the grid is anchored at A1 and the
 * used range's origin must not be added. Hidden rows and merged cells do not shift numbering.
 */
export const sourceRowOffset = (): number => 0;

export function columnLetter(n: number): string {
  let out = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
  return out;
}

interface Used {
  lastRow: number;
  lastCol: number;
}

async function used(ctx: Excel.RequestContext, ws: Excel.Worksheet): Promise<Used> {
  const range = ws.getUsedRange();
  range.load("rowIndex,columnIndex,rowCount,columnCount");
  await ctx.sync();
  return { lastRow: range.rowIndex + range.rowCount, lastCol: range.columnIndex + range.columnCount };
}

// Excel runs are serialized so overlapping calls cannot race on the user's selection.
let tail: Promise<unknown> = Promise.resolve();
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn, fn);
  tail = result.catch(() => undefined);
  return result;
}

const isItemNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ItemNotFound";
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A missing sheet returns false; any other failure propagates for the UI to show. */
export async function guarded(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await enqueue(fn);
  } catch (e) {
    if (isItemNotFound(e)) return false;
    throw e;
  }
}

export function selectSheet(run: ExcelRun, name: string): Promise<boolean> {
  return guarded(() =>
    run(async (ctx) => {
      ctx.workbook.worksheets.getItem(name).activate();
      await ctx.sync();
      return true;
    }),
  );
}

export function selectHeaderRow(run: ExcelRun, sheet: string, headerRow: number): Promise<boolean> {
  return guarded(() =>
    run(async (ctx) => {
      const ws = ctx.workbook.worksheets.getItem(sheet);
      const { lastCol } = await used(ctx, ws);
      ws.activate();
      ws.getRange(`A${headerRow}:${columnLetter(Math.max(lastCol, 1))}${headerRow}`).select();
      await ctx.sync();
      return true;
    }),
  );
}

async function headerCells(ctx: Excel.RequestContext, ws: Excel.Worksheet, headerRow: number, lastCol: number): Promise<string[]> {
  const row = ws.getRange(`A${headerRow}:${columnLetter(Math.max(lastCol, 1))}${headerRow}`);
  row.load("values");
  await ctx.sync();
  return (row.values[0] ?? []).map((v) => String(v ?? "").trim());
}

export function selectColumn(run: ExcelRun, sheet: string, headerRow: number, headerText: string): Promise<boolean> {
  return guarded(() =>
    run(async (ctx) => {
      const ws = ctx.workbook.worksheets.getItem(sheet);
      const { lastRow, lastCol } = await used(ctx, ws);
      const wanted = headerText.trim();
      const cells = await headerCells(ctx, ws, headerRow, lastCol);
      const index = cells.indexOf(wanted);
      if (index < 0 || cells.lastIndexOf(wanted) !== index) return false; // missing or ambiguous
      const letter = columnLetter(index + 1);
      ws.activate();
      ws.getRange(`${letter}1:${letter}${Math.max(lastRow, 1)}`).select();
      await ctx.sync();
      return true;
    }),
  );
}

/** `column` is an Excel column letter; omitted, the first column. */
export function selectSourceCell(run: ExcelRun, sheet: string, sourceRow: number, column = "A"): Promise<boolean> {
  return guarded(() =>
    run(async (ctx) => {
      const ws = ctx.workbook.worksheets.getItem(sheet);
      ws.activate();
      ws.getRange(`${column}${sourceRow + sourceRowOffset()}`).select();
      await ctx.sync();
      return true;
    }),
  );
}

export type SelectedColumn = { ok: true; header: string } | { ok: false; message: string };

/** The header text above the user's current single-column selection, or why there is none. */
export async function readSelectedColumn(run: ExcelRun, sheet: string, headerRow: number): Promise<SelectedColumn> {
  try {
    return await enqueue(() => run(async (ctx): Promise<SelectedColumn> => {
      const sel = ctx.workbook.getSelectedRange();
      sel.load("columnIndex,columnCount");
      sel.worksheet.load("name");
      await ctx.sync();
      if (sel.worksheet.name !== sheet) return { ok: false, message: `Select a column on the "${sheet}" sheet.` };
      if (sel.columnCount !== 1) return { ok: false, message: "Select exactly one column." };
      const ws = ctx.workbook.worksheets.getItem(sheet);
      const { lastCol } = await used(ctx, ws);
      const cells = await headerCells(ctx, ws, headerRow, lastCol);
      const header = cells[sel.columnIndex] ?? "";
      if (header === "") return { ok: false, message: `The selected column has no header in row ${headerRow}; select a column inside the table.` };
      if (cells.filter((c) => c === header).length > 1) return { ok: false, message: `Header "${header}" appears more than once; rename one` };
      return { ok: true, header };
    }));
  } catch (e) {
    return { ok: false, message: `Could not read the current selection: ${message(e)}` };
  }
}

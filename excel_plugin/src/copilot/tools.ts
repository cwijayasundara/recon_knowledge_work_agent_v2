// The Copilot's workbook tools, run in Excel on the server's request. Read-only: nothing here writes, selects or
// activates. Results follow the fixed shapes in engine.py (_shaped, _read_payload); the server re-checks every cap.
// Cell text is data: it is returned as-is (bounded and with hidden characters stripped), never interpreted.
import { enqueue, ExcelBusy, withExcelTimeout, type ExcelRun } from "../office/highlight";
import { isHiddenChar, parseRange, rangeSpec, truncateCell, validSheetName, type CellScalar, type RangeSpec } from "./rules";
import type { CopilotLimits, ToolCall, ToolResult } from "./types";

// Server caps (engine.py); results larger than these are refused or cut there.
export const MAX_SHEETS = 200;
export const MAX_HEADERS = 50;
export const HEADER_CHARS = 120;
export const MAX_MERGED = 50;
export const MAX_SELECTION_VALUES = 25;
export const MAX_FIND_HITS = 50;
export const FIND_EXCERPT_CHARS = 120;
export const MAX_FIND_TEXT = 200;
/** find scans at most this many per-call caps across all sheets. */
export const FIND_SCAN_CALLS = 4;
export const MAX_READ_RESULT_BYTES = 256_000;
/** Room left for the fields the server adds around the grids (ok, sheet, range, rows, cols, truncated, wrapper). */
export const READ_RESULT_HEADROOM = 1024;

export const MESSAGES = {
  notFound: "sheet not found",
  busy: "Excel is busy (finish editing the cell)",
  read: "Excel could not read that range",
  unknownTool: "unknown tool",
  badArgs: "invalid arguments",
  badSheet: "invalid sheet name",
  badRange: "invalid range: use A1 or A1:B2 without a sheet name",
  badText: "text must be 1-200 characters without control characters",
  badLimits: "invalid copilot limits",
  selectionSheet: "the selected sheet's name is not supported",
  hidden: "sheet is hidden; unhide it first",
  aborted: "cancelled",
} as const;

/** A failure whose message is safe to send as-is (never Office's own text, never the caller's input). */
class ToolFailure extends Error {}

interface Limits {
  cap: number;
  chars: number;
  /** The caller's cancel: checked before Excel is touched and between find's sheets. */
  signal?: AbortSignal;
}

type Content = Record<string, unknown>;
type Op = (ctx: Excel.RequestContext) => Promise<Content>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isItemNotFound = (e: unknown): boolean => isRecord(e) && e.code === "ItemNotFound";
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

function sheetArg(v: unknown): string {
  try {
    return validSheetName(v as string);
  } catch {
    throw new ToolFailure(MESSAGES.badSheet);
  }
}

function rangeArg(v: unknown): RangeSpec {
  try {
    return parseRange(v as string);
  } catch {
    throw new ToolFailure(MESSAGES.badRange);
  }
}

function textArg(v: unknown): string {
  if (typeof v !== "string") throw new ToolFailure(MESSAGES.badText);
  const text = v.trim();
  const n = [...text].length;
  if (n < 1 || n > MAX_FIND_TEXT || [...text].some((ch) => isHiddenChar(ch))) throw new ToolFailure(MESSAGES.badText);
  return text;
}

const isValidName = (name: unknown): name is string => {
  try {
    validSheetName(name as string);
    return true;
  } catch {
    return false;
  }
};

/** An Excel cell value as a bounded scalar; dates stay serial numbers, error cells stay their "#N/A" text. */
function cell(v: unknown, chars: number): CellScalar {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return truncateCell(v, chars);
  return null;
}

/**
 * Cell text with hidden characters stripped, for matching and headers; "" for an empty cell. Numbers and dates are
 * their stored value (45567, 0.5), not the displayed text; booleans read as Excel shows them.
 */
function cellText(v: unknown): string {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? String(truncateCell(v, Number.MAX_SAFE_INTEGER)) : "";
}

/**
 * Range.formulas holds the value for a non-formula cell, so text such as "=1+1" (a text-formatted cell) appears in both
 * grids; a formula is a "=" entry that differs from the cell's value. Blind spot: a formula whose computed result is
 * exactly its own text reads as a constant.
 */
const isFormula = (f: unknown, value: unknown): boolean => typeof f === "string" && f.startsWith("=") && f !== value;

// Hidden and very hidden sheets are private to the workbook's author: the tools never list, describe, read or search
// them. Hidden rows and filtered-out rows on a visible sheet stay readable (the used range and A1 reads include them).
const isVisible = (visibility: unknown): boolean => visibility === "Visible";

function spanOf(r: { rowIndex: number; columnIndex: number; rowCount: number; columnCount: number }): RangeSpec {
  return rangeSpec(r.rowIndex + 1, r.columnIndex + 1, r.rowIndex + r.rowCount, r.columnIndex + r.columnCount);
}

/**
 * Whether the sheet is visible, and the cells the user has filled (formats ignored) or null for an empty sheet.
 * getUsedRangeOrNullObject, because Excel's getUsedRange returns A1 on an empty sheet.
 */
async function sheetArea(ctx: Excel.RequestContext, ws: Excel.Worksheet): Promise<{ visible: boolean; used: RangeSpec | null }> {
  ws.load("visibility");
  const used = ws.getUsedRangeOrNullObject(true);
  used.load("isNullObject,rowIndex,columnIndex,rowCount,columnCount");
  await ctx.sync();
  return { visible: isVisible(ws.visibility), used: used.isNullObject ? null : spanOf(used) };
}

/** The whole rows that hold the first `budget` cells of `span` in row-major order, and how many of them count. */
function prefixArea(span: RangeSpec, budget: number): { area: RangeSpec; cells: number } {
  const cols = Math.min(span.cols, budget);
  const rows = Math.min(span.rows, Math.ceil(budget / cols));
  return { area: rangeSpec(span.r1, span.c1, span.r1 + rows - 1, span.c1 + cols - 1), cells: Math.min(budget, rows * cols) };
}

/** Visits the first `cells` cells of a loaded grid in row-major order; the visitor returns false to stop. */
function eachCell(cells: number, cols: number, visit: (r: number, c: number) => boolean | void): void {
  for (let i = 0; i < cells; i++) if (visit(Math.floor(i / cols), i % cols) === false) return;
}

// ---- list_sheets ---------------------------------------------------------------

const listSheets = (): Op => async (ctx) => {
  const sheets = ctx.workbook.worksheets;
  sheets.load("items/name,items/visibility");
  await ctx.sync();
  // Names the server would refuse are dropped: one bad name fails the whole result there.
  const names = sheets.items.filter((ws) => isVisible(ws.visibility)).map((ws) => ws.name);
  return { sheets: names.filter(isValidName).slice(0, MAX_SHEETS) };
};

// ---- describe_sheet ------------------------------------------------------------

/** Range.getMergedAreasOrNullObject needs ExcelApi 1.13 (the manifest asks for 1.9). */
export function mergedApiSupported(): boolean {
  try {
    return typeof Office !== "undefined" && Office.context.requirements.isSetSupported("ExcelApi", "1.13");
  } catch {
    return false;
  }
}

/**
 * Up to MAX_MERGED merged areas. getMergedAreasOrNullObject needs ExcelApi 1.13 (the manifest asks for 1.9): without it
 * there are no merged areas. Excel also refuses it when the range holds more than 512 merged areas; that error is
 * caught here, so such a sheet reports none.
 */
async function mergedAreas(ctx: Excel.RequestContext, range: Excel.Range): Promise<string[]> {
  if (!mergedApiSupported() || typeof range.getMergedAreasOrNullObject !== "function") return [];
  try {
    const merged = range.getMergedAreasOrNullObject();
    merged.load("isNullObject,areaCount");
    await ctx.sync();
    if (merged.isNullObject) return [];
    const items: Excel.Range[] = [];
    for (let i = 0; i < Math.min(merged.areaCount, MAX_MERGED); i++) {
      const area = merged.areas.getItemAt(i);
      area.load("rowIndex,columnIndex,rowCount,columnCount");
      items.push(area);
    }
    await ctx.sync();
    return items.map((a) => spanOf(a).a1());
  } catch {
    return []; // merged areas are a hint; their failure must not lose the rest of the description
  }
}

const describeSheet = (sheet: string, lim: Limits): Op => async (ctx) => {
  const ws = ctx.workbook.worksheets.getItem(sheet);
  const { visible, used } = await sheetArea(ctx, ws);
  if (!visible) throw new ToolFailure(MESSAGES.hidden);
  if (!used) return { used_range: null, headers: [], merged: [], counts: { formulas: 0, constants: 0, blanks: 0 } };
  // Counts cover the first max_cells_per_call cells; values are loaded only for that area and never returned.
  const { area, cells } = prefixArea(used, lim.cap);
  const range = ws.getRange(area.a1());
  range.load("values,formulas,valueTypes");
  await ctx.sync();
  const counts = { formulas: 0, constants: 0, blanks: 0 };
  let headerRow = -1;
  eachCell(cells, area.cols, (r, c) => {
    const type = range.valueTypes[r]?.[c];
    if (isFormula(range.formulas[r]?.[c], range.values[r]?.[c])) counts.formulas += 1;
    else if (type === "Empty" || type === undefined) counts.blanks += 1;
    else counts.constants += 1;
    if (headerRow < 0 && type !== "Empty" && type !== undefined) headerRow = r;
  });
  const headers = headerRow < 0 ? [] : (range.values[headerRow] ?? []).slice(0, MAX_HEADERS).map((v) => String(truncateCell(cellText(v), HEADER_CHARS)));
  const merged = await mergedAreas(ctx, ws.getRange(used.a1()));
  return { used_range: used.a1(), headers, merged, counts };
};

// ---- get_selection -------------------------------------------------------------

const getSelection = (lim: Limits): Op => async (ctx) => {
  const sel = ctx.workbook.getSelectedRange();
  sel.load("rowIndex,columnIndex,rowCount,columnCount");
  sel.worksheet.load("name,visibility");
  await ctx.sync();
  if (!isVisible(sel.worksheet.visibility)) throw new ToolFailure(MESSAGES.hidden);
  const sheet = sel.worksheet.name;
  if (!isValidName(sheet)) throw new ToolFailure(MESSAGES.selectionSheet);
  const span = spanOf(sel);
  const out: Content = { sheet, address: span.a1(), cells: span.cells };
  // Values only for small selections, loaded only after the size is known: a select-all is 17 billion cells.
  if (span.cells <= MAX_SELECTION_VALUES) {
    sel.load("values");
    await ctx.sync();
    out.values = sel.values.map((row) => row.map((v: unknown) => cell(v, lim.chars)));
  }
  return out;
};

// ---- read_range ----------------------------------------------------------------

/** Length of Python's json.dumps(ensure_ascii=True) for the node, with < > & escaped as engine.wrap does. */
export function wrappedLength(node: unknown): number {
  if (node === null || node === undefined) return 4;
  if (typeof node === "boolean") return node ? 4 : 5;
  if (typeof node === "number") return String(node).length + 2; // + Python repr differences (1e-07, 1.0)
  if (typeof node === "string") {
    let n = 2;
    for (let i = 0; i < node.length; i++) {
      const u = node.charCodeAt(i);
      if (u === 0x22 || u === 0x5c || u === 0x08 || u === 0x0c || u === 0x0a || u === 0x0d || u === 0x09) n += 2;
      else if (u < 0x20 || u > 0x7e || u === 0x3c || u === 0x3e || u === 0x26) n += 6;
      else n += 1;
    }
    return n;
  }
  if (Array.isArray(node)) return node.reduce((n: number, v) => n + wrappedLength(v) + 1, 1);
  return 4;
}

/** Rows (and, for a single overlong row, columns) of the grids that fit the server's result-size limit. */
function fitBytes(values: CellScalar[][], formulas: string[][] | null): { rows: number; cols: number } {
  const budget = MAX_READ_RESULT_BYTES - READ_RESULT_HEADROOM;
  const cols = values[0]?.length ?? 0;
  let used = 4;
  for (let r = 0; r < values.length; r++) {
    const size = wrappedLength(values[r]) + (formulas ? wrappedLength(formulas[r]) : 0) + 2;
    if (used + size > budget) {
      if (r > 0) return { rows: r, cols };
      let c = 0;
      for (; c < cols; c++) {
        const add = wrappedLength(values[0]![c]) + (formulas ? wrappedLength(formulas[0]![c]) : 0) + 2;
        if (used + add > budget) break;
        used += add;
      }
      return { rows: 1, cols: Math.max(1, c) };
    }
    used += size;
  }
  return { rows: values.length, cols };
}

const readRange = (sheet: string, want: RangeSpec, lim: Limits): Op => async (ctx) => {
  // Whole rows within the per-call cap; a row wider than the cap is cut to cap columns.
  const cols = Math.min(want.cols, lim.cap);
  const rows = Math.min(want.rows, Math.max(1, Math.floor(lim.cap / cols)));
  let truncated = rows * cols < want.cells;
  const area = rangeSpec(want.r1, want.c1, want.r1 + rows - 1, want.c1 + cols - 1);
  const ws = ctx.workbook.worksheets.getItem(sheet);
  ws.load("visibility");
  await ctx.sync(); // before any cell is loaded: a hidden sheet's cells never reach the pane
  if (!isVisible(ws.visibility)) throw new ToolFailure(MESSAGES.hidden);
  const range = ws.getRange(area.a1());
  range.load("values,formulas");
  await ctx.sync();
  const grid = (g: unknown[][], f: (v: unknown) => CellScalar) => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => f(g[r]?.[c])));
  let values = grid(range.values, (v) => cell(v, lim.chars));
  const raw = range.formulas as unknown[][];
  const rawValues = range.values as unknown[][];
  const hasFormula = (g: unknown[][]) => g.some((row, r) => row.some((f, c) => isFormula(f, rawValues[r]?.[c])));
  const asText = (f: unknown) => truncateCell(typeof f === "string" ? f : f === null || f === undefined ? "" : String(f), lim.chars) as string;
  let formulas: string[][] | null = hasFormula(raw) ? (grid(raw, asText) as string[][]) : null;
  const fit = fitBytes(values, formulas);
  if (fit.rows < rows || fit.cols < cols) {
    truncated = true;
    values = values.slice(0, fit.rows).map((row) => row.slice(0, fit.cols));
    const kept = raw.slice(0, fit.rows).map((row) => row.slice(0, fit.cols));
    formulas = formulas && hasFormula(kept) ? formulas.slice(0, fit.rows).map((row) => row.slice(0, fit.cols)) : null;
  }
  const out: Content = {
    address: rangeSpec(want.r1, want.c1, want.r1 + fit.rows - 1, want.c1 + fit.cols - 1).a1(),
    rows: fit.rows,
    cols: fit.cols,
    values,
  };
  if (formulas) out.formulas = formulas;
  if (truncated) out.truncated = true;
  return out;
};

// ---- find ----------------------------------------------------------------------

/** At most `limit` code points of `text` around code point `at`, with ellipses where it was cut. */
export function excerpt(text: string, at: number, limit: number): string {
  const cps = [...text];
  if (cps.length <= limit) return text;
  if (limit < 3) return cps.slice(0, limit).join("");
  const start = Math.max(0, Math.min(at - 20, cps.length - (limit - 1)));
  const head = start > 0 ? "…" : "";
  const room = limit - head.length - 1;
  const tail = start + room < cps.length ? "…" : "";
  return head + cps.slice(start, start + room).join("") + tail;
}

/**
 * Case-insensitive substring search over a bounded scan of visible sheets. `truncated` means the search was not
 * complete: more hits than the cap, cells beyond the scan budget, or sheets skipped (hidden, or a name the server
 * refuses). Numbers and dates match by their stored value, not the displayed text.
 */
const find = (needle: string, only: string | null, lim: Limits): Op => async (ctx) => {
  let names: string[];
  let truncated = false;
  if (only !== null) names = [only];
  else {
    const sheets = ctx.workbook.worksheets;
    sheets.load("items/name,items/visibility");
    await ctx.sync();
    names = sheets.items.filter((ws) => isVisible(ws.visibility)).map((ws) => ws.name).filter(isValidName);
    if (names.length < sheets.items.length) truncated = true;
  }
  const wanted = needle.toLowerCase();
  const excerptChars = Math.min(FIND_EXCERPT_CHARS, lim.chars);
  const hits: { sheet: string; address: string; text: string }[] = [];
  let budget = lim.cap * FIND_SCAN_CALLS;
  let full = false;
  for (const name of names) {
    if (full) break;
    if (lim.signal?.aborted) throw new ToolFailure(MESSAGES.aborted);
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const ws = ctx.workbook.worksheets.getItem(name);
    const { visible, used } = await sheetArea(ctx, ws);
    if (!visible) {
      truncated = true;
      continue;
    }
    if (!used) continue;
    const { area, cells } = prefixArea(used, Math.min(lim.cap, budget));
    if (cells < used.cells) truncated = true;
    budget -= cells;
    const range = ws.getRange(area.a1());
    range.load("values");
    await ctx.sync();
    eachCell(cells, area.cols, (r, c) => {
      const text = cellText(range.values[r]?.[c]);
      const lower = text.toLowerCase();
      const at = lower.indexOf(wanted);
      if (text === "" || at < 0) return true;
      if (hits.length === MAX_FIND_HITS) {
        full = truncated = true; // a further hit exists beyond the cap
        return false;
      }
      // Lower-casing can change length (İ): then the excerpt starts at the beginning of the cell.
      const cp = lower.length === text.length ? [...text.slice(0, at)].length : 0;
      hits.push({ sheet: name, address: rangeSpec(area.r1 + r, area.c1 + c, area.r1 + r, area.c1 + c).a1(), text: excerpt(text, cp, excerptChars) });
      return true;
    });
  }
  const out: Content = { hits };
  if (truncated) out.truncated = true;
  return out;
};

// ---- dispatch ------------------------------------------------------------------

function prepare(name: unknown, args: Record<string, unknown>, lim: Limits): Op {
  switch (name) {
    case "list_sheets":
      return listSheets();
    case "get_selection":
      return getSelection(lim);
    case "describe_sheet":
      return describeSheet(sheetArg(args.sheet), lim);
    case "read_range": {
      const sheet = sheetArg(args.sheet);
      return readRange(sheet, rangeArg(args.range), lim);
    }
    case "find": {
      const text = textArg(args.text);
      return find(text, args.sheet === undefined || args.sheet === null ? null : sheetArg(args.sheet), lim);
    }
    default:
      throw new ToolFailure(MESSAGES.unknownTool);
  }
}

function failureMessage(e: unknown): string {
  if (e instanceof ToolFailure) return e.message;
  if (e instanceof ExcelBusy) return MESSAGES.busy;
  if (isItemNotFound(e)) return MESSAGES.notFound;
  return MESSAGES.read; // Office's own error text may quote workbook content; it never leaves the pane
}

/**
 * Runs one client tool call in Excel. Never throws and never writes: every failure becomes
 * `{ok: false, content: {message}}` with a short fixed message. Arguments are checked before Excel is touched.
 * An aborted `signal` ends the call early with MESSAGES.aborted (before Excel, while queued, or between find's sheets).
 */
export async function runClientTool(run: ExcelRun, call: ToolCall, limits: CopilotLimits, signal?: AbortSignal): Promise<ToolResult> {
  const callId = isRecord(call) && typeof call.id === "string" ? call.id : "";
  try {
    if (signal?.aborted) throw new ToolFailure(MESSAGES.aborted);
    if (!isRecord(limits) || !posInt(limits.max_cells_per_call) || !posInt(limits.cell_char_limit)) throw new ToolFailure(MESSAGES.badLimits);
    if (!isRecord(call) || !isRecord(call.args)) throw new ToolFailure(MESSAGES.badArgs);
    const op = prepare(call.name, call.args, { cap: limits.max_cells_per_call, chars: limits.cell_char_limit, ...(signal ? { signal } : {}) });
    const content = await withExcelTimeout((timedOut) =>
      enqueue(() => {
        if (signal?.aborted) return Promise.reject(new ToolFailure(MESSAGES.aborted)); // cancelled while queued
        return timedOut.aborted ? Promise.reject(new ExcelBusy()) : run(op);
      }),
    );
    return { call_id: callId, ok: true, content };
  } catch (e) {
    return { call_id: callId, ok: false, content: { message: failureMessage(e) } };
  }
}

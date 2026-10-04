// The Copilot's only Excel writer: previews a write proposal as a before/after diff and applies it, on an analyst's
// click, to the add-in-owned "Copilot Scratch" sheet or (after a second confirmation) to the proposed range. Every
// proposal is re-validated here with the server's rules (schemas.py ProposeWrite), so a forged or stale proposal is
// refused even if it bypassed the server. Office's own error text never leaves this module: failures are a fixed set
// of messages.
//
// Number formats when writing values: a string cell gets "@" (text) BEFORE its value is written, so text Excel would
// interpret ("-5", "TRUE", "1/2/2024") stays literal; a number or true/false cell keeps its existing format (a user's
// currency format survives) unless that format is "@", which becomes "General" so 12 is stored as a number; an empty
// (null) cell keeps its format and is written as "" (Office ignores null entries when setting values, which would
// leave the old content). Formulas leave user formats untouched (the preview warns about text-formatted target cells);
// on the scratch sheet, which the add-in owns, "@" cells are reset to "General" first so a formula is not stored as text.
// The preview counts every number-format change it will make (formatChanges).
import { EXCEL_BUSY_MESSAGE, EXCEL_OP_TIMEOUT_MS, ExcelBusy, enqueue, withExcelTimeout, type ExcelRun } from "../office/highlight";
import { REVIEW_SHEET, findOwnedSheet, markOwned } from "../office/review";
import { blankBrackets, checkFormula, parseRange, pyStrip, rangeSpec, truncateCell, validSheetName, type RangeSpec } from "./rules";
import { mergedApiSupported } from "./tools";
import type { CopilotLimits, WriteProposal } from "./types";

export const SCRATCH_SHEET = "Copilot Scratch";
/** Ownership marker of the scratch sheet: a hidden worksheet-scoped name, as for the Review sheet. */
export const SCRATCH_MARK = "CopilotScratchOwner";
/** Excel's limit on the text in one cell (UTF-16 code units). */
export const EXCEL_CELL_CHARS = 32_767;
/** Per-request bounds for a write: rows, and payload characters (well under Excel Online's request size limit). */
export const WRITE_CHUNK_ROWS = 500;
export const WRITE_CHUNK_CHARS = 200_000;
/** After the Excel timeout fires mid-write, how long to wait for the write in flight before reporting it uncertain. */
export const WRITE_SETTLE_MS = EXCEL_OP_TIMEOUT_MS;
/** Distinct sheets a proposal's formulas may name (each is looked up to refuse references to hidden sheets). */
export const MAX_REFERENCED_SHEETS = 100;

// Excel compares sheet names case-insensitively; the fold matches validSheetName's.
const fold = (name: string): string => name.toUpperCase().toLowerCase();
/** Sheets the add-in owns; a `target: "range"` write never goes to them. */
export const RESERVED_SHEETS: readonly string[] = [fold(REVIEW_SHEET), fold(SCRATCH_SHEET)];
export const isReservedSheet = (name: string): boolean => RESERVED_SHEETS.includes(fold(name));

export const WRITE_MESSAGES = {
  badLimits: "invalid copilot limits",
  badTarget: "invalid write target",
  badSheet: "invalid sheet name",
  badRange: "invalid range: use A1 or A1:B2 without a sheet name",
  tooMany: "the proposal has more cells than the write limit",
  oneOf: "provide exactly one of values or formulas",
  shape: "the cells do not match the range's shape",
  badCell: "cells must be text, numbers, true/false or empty",
  formulaLike: "text values must not start with = + @ - or a tab/CR unless they are plain numbers",
  tooLong: "a value is longer than Excel's cell limit",
  badFormula: "a formula is not allowed",
  hiddenRef: "formula references a hidden sheet",
  hiddenName: "formula uses a name that points at a hidden sheet",
  unchecked: "formula uses names or tables that can't be checked on this Excel version",
  reserved: "that sheet belongs to the add-in; choose another sheet",
  notFound: "sheet not found",
  hidden: "sheet is hidden; unhide it first",
  protected: "sheet is protected",
  merged: "the range contains merged cells; choose another range",
  conflict: `A sheet named '${SCRATCH_SHEET}' already exists and wasn't created by this add-in; rename it.`,
  confirm: "confirmation required",
  stale: "The range changed since the preview; preview again.",
  mismatch: "The proposal differs from the preview; preview again.",
  busy: EXCEL_BUSY_MESSAGE,
  stopped: "Stopped",
  uncertain: "The write may be partly applied; check the range.",
  readFailed: "Excel could not read that range",
  writeFailed: "Excel could not write that range",
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const WRITE_WARNINGS = {
  overwrite: (n: number) => `${plural(n, "non-empty cell", "non-empty cells")} will be overwritten`,
  scratchOverwrite: (n: number) => `${plural(n, "non-empty scratch cell", "non-empty scratch cells")} will be overwritten`,
  formatChanges: (n: number) => `${plural(n, "cell", "cells")} will get a new number format`,
  textFormatted: (n: number) => `${plural(n, "target cell is", "target cells are")} formatted as text; formulas there will show as text`,
  mergedUnknown: "merged cells can't be detected on this Excel version",
  unchecked: "Names and tables can't be checked on this Excel version; formulas that use them are refused.",
  tables: "Tables, spilled arrays and data validation may be affected; check the result.",
  undo: "Excel can't undo this change (Office.js writes clear Excel's undo history).",
  undoScratch: "Excel can't undo this write.",
  shortened: "some cells are shown shortened",
} as const;

export type WriteTarget = "scratch" | "range";

export interface WritePreview {
  target: WriteTarget;
  sheet: string;
  /** Id of the target worksheet at preview time ("" when the scratch sheet does not exist yet). */
  sheetId: string;
  /** Canonical A1 (no $, upper case). */
  range: string;
  rows: number;
  cols: number;
  cells: number;
  /** Current cell text (a formula as its formula) at preview time, shortened to cell_char_limit; [] for scratch. */
  before: string[][];
  /** Proposed text (formulas with their leading =), shortened to cell_char_limit. */
  after: string[][];
  kind: "values" | "formulas";
  warnings: string[];
  /** Cells whose number format the write changes. */
  formatChanges: number;
  /** Non-empty cells the write overwrites (on the scratch sheet: the add-in's own earlier output). */
  overwrites: number;
  /** Fingerprint of the full, typed current content; "" for scratch. Checked again before a range write. */
  stamp: string;
  /** Fingerprint of the full, typed proposal (1 and "1" differ). Checked again before a range write. */
  afterStamp: string;
}

export type PreviewResult = { ok: true; preview: WritePreview } | { ok: false; error: string };
export type ApplyResult =
  | { ok: true; sheet: string; range: string; cells: number }
  /** `written`: cells already written (a lower bound when `uncertain`). */
  | { ok: false; error: string; written: number; uncertain?: true };

export type ApplyOptions =
  | {
    target: "scratch"; limits: CopilotLimits; signal?: AbortSignal; /** Select the written range on the scratch sheet. */ select?: boolean;
    /** Required for formulas (they run in the workbook); ignored for values. */ confirmed?: boolean;
  }
  | { target: "range"; confirmed: boolean; /** The preview the analyst confirmed. */ preview: WritePreview; limits: CopilotLimits; signal?: AbortSignal };

/** A refusal whose message is one of WRITE_MESSAGES (never Office's text, never the proposal's content). */
class Refusal extends Error {}
class Stopped extends Error {}
class Uncertain extends Error {}

type Cell = string | number | boolean | null;
interface Checked {
  sheet: string;
  spec: RangeSpec;
  kind: "values" | "formulas";
  /** Values (null for an empty cell) or formula strings. */
  grid: Cell[][];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const has = (a: unknown[], i: number): boolean => Object.prototype.hasOwnProperty.call(a, i);

function checkLimits(limits: unknown): { cap: number; chars: number } {
  if (!isRecord(limits) || !posInt(limits.max_write_cells) || !posInt(limits.cell_char_limit)) throw new Refusal(WRITE_MESSAGES.badLimits);
  return { cap: limits.max_write_cells, chars: limits.cell_char_limit };
}

const NUMERIC = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
// NFKC folds fullwidth equals/plus/at/hyphen to ASCII; U+2212 (minus sign) has no NFKC fold, so it is listed explicitly.
const FORMULA_LEADS = new Set(["=", "+", "@", "-", String.fromCharCode(0x2212)]);

/**
 * schemas.py `_safe_value`: hidden characters are stripped first (so they cannot hide a leading "="), text longer than
 * Excel's cell limit (UTF-16 units) is refused, then text that could be read as a formula is refused unless it is a
 * plain number. Stricter than the server: non-finite numbers are refused, and the size pre-check counts UTF-16 units.
 */
export function safeValue(c: unknown): Cell {
  if (!(c === null || typeof c === "string" || typeof c === "boolean" || (typeof c === "number" && Number.isFinite(c)))) {
    throw new Refusal(WRITE_MESSAGES.badCell);
  }
  if (typeof c === "string" && c.length > 4 * EXCEL_CELL_CHARS) throw new Refusal(WRITE_MESSAGES.tooLong); // bounds the work below
  const out = truncateCell(c, 4 * EXCEL_CELL_CHARS) as Cell;
  if (typeof out !== "string") return out;
  if (out.length > EXCEL_CELL_CHARS) throw new Refusal(WRITE_MESSAGES.tooLong);
  const first = [...pyStrip(out, true)][0] ?? "";
  // NFKC can expand one character to several (U+2A75 -> "=="), so take the first folded character.
  const lead = [...first.normalize("NFKC")][0] ?? "";
  if (out[0] === "\t" || out[0] === "\r" || (FORMULA_LEADS.has(lead) && !NUMERIC.test(pyStrip(out)))) {
    throw new Refusal(WRITE_MESSAGES.formulaLike);
  }
  return out;
}

/** schemas.py `_v_formulas`: "=" plus at least one character, and check_formula passes (length, denylist, external refs). */
export function safeFormula(f: unknown): string {
  if (typeof f !== "string" || !f.startsWith("=") || [...f.slice(0, 2)].length < 2) throw new Refusal(WRITE_MESSAGES.badFormula);
  try {
    checkFormula(f);
  } catch {
    throw new Refusal(WRITE_MESSAGES.badFormula);
  }
  return f;
}

const STRING_G = /"(?:[^"]|"")*"/g;
const QUOTED_REF_G = /'((?:[^']|'')+)'!/g;
// An unquoted sheet name before "!", not part of a longer name, quoted name or [book] reference.
const PLAIN_REF_G = /(?:^|[^\p{L}\p{N}_.'\]])([\p{L}\p{N}_.]+(?::[\p{L}\p{N}_.]+)?)!/gu;

/**
 * Static sheet references in a formula, each as [sheet] or, for a 3-D reference, [first, last]: Sheet!A1,
 * 'My Sheet'!A1, 'It''s'!A1, Jan:Mar!A1, 'Jan 1:Mar 1'!A1. String literals are skipped.
 */
export function sheetRefs(formula: string): string[][] {
  const refs: string[][] = [];
  const add = (ref: string) => refs.push(ref.split(":").filter((n) => n !== ""));
  const code = formula.replace(STRING_G, '""').replace(QUOTED_REF_G, (_m, name: string) => {
    add(name.replace(/''/g, "'"));
    return " ";
  });
  for (const m of code.matchAll(PLAIN_REF_G)) add(m[1]!);
  return refs.filter((r) => r.length > 0);
}

/** Distinct sheet names a formula refers to statically (both ends of a 3-D reference). */
export function referencedSheets(formula: string): string[] {
  return [...new Set(sheetRefs(formula).flat())];
}

/** Every check the server makes on a proposal, in the order that keeps work bounded (size before content). */
function checkProposal(p: unknown, cap: number): Checked {
  if (!isRecord(p)) throw new Refusal(WRITE_MESSAGES.oneOf);
  let sheet: string;
  try {
    sheet = validSheetName(p.sheet as string);
  } catch {
    throw new Refusal(WRITE_MESSAGES.badSheet);
  }
  let spec: RangeSpec;
  try {
    spec = parseRange(p.range as string);
  } catch {
    throw new Refusal(WRITE_MESSAGES.badRange);
  }
  if (spec.cells > cap) throw new Refusal(WRITE_MESSAGES.tooMany);
  const hasValues = p.values !== undefined && p.values !== null;
  const hasFormulas = p.formulas !== undefined && p.formulas !== null;
  if (hasValues === hasFormulas) throw new Refusal(WRITE_MESSAGES.oneOf);
  const raw = hasValues ? p.values : p.formulas;
  if (!Array.isArray(raw) || raw.length !== spec.rows) throw new Refusal(WRITE_MESSAGES.shape);
  // Index loops: a sparse array (a hole) is a shape error, never a skipped cell.
  for (let r = 0; r < spec.rows; r++) {
    const row: unknown = has(raw, r) ? raw[r] : undefined;
    if (!Array.isArray(row) || row.length !== spec.cols) throw new Refusal(WRITE_MESSAGES.shape);
    for (let i = 0; i < spec.cols; i++) if (!has(row, i)) throw new Refusal(WRITE_MESSAGES.shape);
  }
  const check = hasValues ? safeValue : safeFormula;
  const grid: Cell[][] = [];
  for (let r = 0; r < spec.rows; r++) {
    const row = raw[r] as unknown[];
    const out: Cell[] = [];
    for (let i = 0; i < spec.cols; i++) out.push(check(row[i]));
    grid.push(out);
  }
  if (!hasValues) {
    const names = new Set(grid.flatMap((row) => row.flatMap((f) => referencedSheets(f as string).map(fold))));
    if (names.size > MAX_REFERENCED_SHEETS) throw new Refusal(WRITE_MESSAGES.badFormula);
  }
  return { sheet, spec, kind: hasValues ? "values" : "formulas", grid };
}

/** A cell as the analyst reads it: booleans as Excel shows them, numbers as stored, empty as "". */
function text(v: unknown): string {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number" || typeof v === "string") return String(v);
  return "";
}

function shorten(grid: unknown[][], chars: number): { grid: string[][]; shortened: boolean } {
  let shortened = false;
  const out = grid.map((row) => row.map((v) => {
    const t = text(v);
    const s = truncateCell(t, chars) as string;
    if (s !== t) shortened = true;
    return s;
  }));
  return { grid: out, shortened };
}

/** FNV-1a-style hash (two 32-bit lanes) of the typed JSON; it detects accidental changes, not a security boundary. */
function stamp(grid: unknown[][]): string {
  const json = JSON.stringify(grid);
  let a = 0x811c9dc5, b = 0x01000193 ^ json.length;
  for (let i = 0; i < json.length; i++) {
    const u = json.charCodeAt(i);
    a = Math.imul(a ^ u, 0x01000193) >>> 0;
    b = Math.imul(b ^ u, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16)}-${b.toString(16)}-${grid.length}`;
}

const sameGrid = (a: unknown, b: string[][]): boolean =>
  Array.isArray(a) && a.length === b.length && b.every((row, r) => {
    const other: unknown = a[r];
    return Array.isArray(other) && other.length === row.length && row.every((v, i) => other[i] === v);
  });

const isVisible = (visibility: unknown): boolean => visibility === "Visible";

/** Refuses a sheet the add-in must not write: hidden (private to the author) or protected (never unprotected here). */
async function checkWritable(ctx: Excel.RequestContext, ws: Excel.Worksheet): Promise<void> {
  ws.load("visibility");
  ws.protection.load("protected");
  await ctx.sync(); // before any cell is loaded
  if (!isVisible(ws.visibility)) throw new Refusal(WRITE_MESSAGES.hidden);
  if (ws.protection.protected) throw new Refusal(WRITE_MESSAGES.protected);
}

/** An existing, visible, unprotected user sheet; never created, never one of the add-in's own. */
async function userSheet(ctx: Excel.RequestContext, name: string): Promise<Excel.Worksheet> {
  const ws = ctx.workbook.worksheets.getItemOrNullObject(name);
  ws.load("isNullObject");
  await ctx.sync();
  if (ws.isNullObject) throw new Refusal(WRITE_MESSAGES.notFound);
  ws.load("name,id");
  await checkWritable(ctx, ws);
  if (isReservedSheet(ws.name)) throw new Refusal(WRITE_MESSAGES.reserved);
  return ws;
}

/** The add-in-owned scratch sheet or null when absent; a same-named sheet without the marker is refused. */
async function ownedScratch(ctx: Excel.RequestContext): Promise<Excel.Worksheet | null> {
  const found = await findOwnedSheet(ctx, SCRATCH_SHEET, SCRATCH_MARK);
  if (found === null) return null;
  if (!found.owned) throw new Refusal(WRITE_MESSAGES.conflict);
  await checkWritable(ctx, found.ws);
  return found.ws;
}

// ---- hidden-sheet reach ----------------------------------------------------------------------------------------
// A formula written by the Copilot must not show cells of a hidden or very hidden sheet. The server's check_formula
// cannot know which sheets are hidden, so this client check, made in Excel at preview AND again at apply, is the
// authority. It fails closed: sheet references (including every sheet between the ends of a 3-D reference), defined
// names (workbook- and sheet-scoped, followed through other names), and tables (structured references and bare table
// names) are resolved against the workbook; anything it cannot resolve is refused.

interface Book {
  /** Sheets in workbook (tab) order. */
  sheets: { name: string; visible: boolean }[];
  /** fold(sheet name) -> index in `sheets`. */
  index: Map<string, number>;
  /** fold(defined name) -> its formulas in every scope; null when names cannot be loaded on this host. */
  names: Map<string, string[]> | null;
  /** fold(table name) -> whether its sheet is visible; null when tables cannot be loaded. */
  tables: Map<string, boolean> | null;
}

type Reach = "hiddenRef" | "hiddenName" | "deniedName" | "unchecked";
const REACH_MESSAGES: Record<Reach, string> = {
  hiddenRef: WRITE_MESSAGES.hiddenRef,
  hiddenName: WRITE_MESSAGES.hiddenName,
  deniedName: WRITE_MESSAGES.badFormula,
  unchecked: WRITE_MESSAGES.unchecked,
};
/** How deep names that refer to other names are followed; deeper counts as unresolvable. */
const MAX_NAME_DEPTH = 8;

async function loadBook(ctx: Excel.RequestContext): Promise<Book> {
  const list = ctx.workbook.worksheets;
  list.load("items/name,items/visibility,items/position");
  await ctx.sync();
  const items = [...list.items].sort((a, b) => a.position - b.position);
  const sheets = items.map((ws) => ({ name: ws.name, visible: isVisible(ws.visibility) }));
  const index = new Map(sheets.map((sh, i) => [fold(sh.name), i]));
  let names: Map<string, string[]> | null = new Map();
  try {
    const scopes = [ctx.workbook.names, ...items.map((ws) => ws.names)];
    scopes.forEach((n) => n.load("items/name,items/formula"));
    await ctx.sync();
    for (const scope of scopes) {
      for (const item of scope.items) {
        const key = fold(item.name);
        names.set(key, [...(names.get(key) ?? []), String(item.formula ?? "")]);
      }
    }
  } catch {
    names = null; // NamedItem.formula needs ExcelApi 1.7
  }
  let tables: Map<string, boolean> | null = new Map();
  try {
    const t = ctx.workbook.tables;
    t.load("items/name,items/worksheet/name");
    await ctx.sync();
    for (const item of t.items) {
      const at = index.get(fold(item.worksheet.name));
      tables.set(fold(item.name), at !== undefined && sheets[at]!.visible); // a table on an unknown sheet counts as hidden
    }
  } catch {
    tables = null;
  }
  return { sheets, index, names, tables };
}

const TOKEN_G = /[\p{L}\p{N}_.\\?$]+/gu;
const CELL_TOKEN = /^\$?[A-Za-z]{1,3}\$?[0-9]+$/;
const RANGE_PART = /^\$?(?:[A-Za-z]{1,3}|[0-9]+)$/;

/** Identifiers outside strings, quoted sheet names and brackets, with the characters around each. */
function tokens(code: string): { text: string; before: string; after: string }[] {
  // Brackets are balanced here: checkFormula has passed for every formula reach() looks at (an unbalanced one throws,
  // which fails closed as a generic error).
  const blanked = blankBrackets(code.replace(QUOTED_REF_G, "!"));
  return [...blanked.matchAll(TOKEN_G)].map((m) => ({ text: m[0], before: blanked[m.index - 1] ?? "", after: blanked[m.index + m[0].length] ?? "" }));
}

/**
 * Whether `formula` can show cells of a hidden sheet. `strict` (a defined name's formula): a sheet it names that does
 * not exist, or a formula that does not parse, counts as unresolvable. `seen` stops cycles between names.
 */
function reach(formula: string, book: Book, strict: boolean, seen: Set<string>): Reach | null {
  if (strict) {
    try {
      checkFormula(formula.startsWith("=") ? formula : `=${formula}`);
    } catch {
      return "deniedName";
    }
  }
  for (const ref of sheetRefs(formula)) {
    const at = ref.map((n) => book.index.get(fold(n)));
    if (at.some((i) => i === undefined)) {
      if (strict) return "hiddenName";
      continue; // a typo or a sheet that does not exist: Excel shows #REF!
    }
    const [lo, hi] = [Math.min(...(at as number[])), Math.max(...(at as number[]))];
    for (let i = lo; i <= hi; i++) if (!book.sheets[i]!.visible) return "hiddenRef";
  }
  const code = formula.replace(STRING_G, '""');
  if (book.tables === null && code.includes("[")) return "unchecked";
  for (const t of tokens(code)) {
    const key = fold(t.text);
    if (book.tables?.get(key) === false) return "hiddenRef";
    if (book.names === null) {
      const safe = /^[0-9.]/.test(t.text) || CELL_TOKEN.test(t.text) || key === "true" || key === "false" ||
        t.after === "(" || t.after === "!" || t.after === "[" || ((t.before === ":" || t.after === ":") && RANGE_PART.test(t.text)) ||
        book.tables?.has(key) === true;
      if (!safe) return "unchecked";
      continue;
    }
    const defs = book.names.get(key);
    if (!defs) continue;
    if (seen.has(key) || seen.size >= MAX_NAME_DEPTH) return "hiddenName"; // a cycle or a chain too deep to follow
    const next = new Set(seen).add(key);
    for (const def of defs) {
      const r = reach(def, book, true, next);
      if (r === "deniedName") return r;
      if (r) return "hiddenName";
    }
  }
  return null;
}

/**
 * Refuses a formulas proposal that can reach a hidden sheet (see above). Returns whether names or tables could not be
 * loaded on this host (the preview says so).
 */
async function checkReach(ctx: Excel.RequestContext, c: Checked): Promise<{ unchecked: boolean }> {
  if (c.kind !== "formulas") return { unchecked: false };
  const book = await loadBook(ctx);
  for (const row of c.grid) {
    for (const f of row) {
      const r = reach(f as string, book, false, new Set());
      if (r) throw new Refusal(REACH_MESSAGES[r]);
    }
  }
  return { unchecked: book.names === null || book.tables === null };
}

/** Whether the target holds merged cells: "unknown" on hosts without ExcelApi 1.13; a failed check counts as merged. */
async function mergedState(ctx: Excel.RequestContext, range: Excel.Range): Promise<"none" | "present" | "unknown"> {
  if (!mergedApiSupported() || typeof range.getMergedAreasOrNullObject !== "function") return "unknown";
  try {
    const merged = range.getMergedAreasOrNullObject();
    merged.load("isNullObject");
    await ctx.sync();
    return merged.isNullObject ? "none" : "present";
  } catch {
    return "present"; // fail closed (Excel refuses the call on ranges with very many merged areas)
  }
}

interface Target {
  formulas: unknown[][];
  formats: unknown[][];
}

/** Current formulas (a constant reads as its value) and number formats of exactly the target range. */
async function readTarget(ctx: Excel.RequestContext, range: Excel.Range): Promise<Target> {
  range.load("formulas,numberFormat");
  await ctx.sync();
  return { formulas: range.formulas as unknown[][], formats: range.numberFormat as unknown[][] };
}

const EMPTY_TARGET: Target = { formulas: [], formats: [] };

/** Number formats the write sets (see the header); null when it sets none. */
function plannedFormats(c: Checked, formats: unknown[][], scratch: boolean): string[][] | null {
  const now = (r: number, i: number) => String(formats[r]?.[i] ?? "General");
  if (c.kind === "values") {
    return c.grid.map((row, r) => row.map((v, i) => {
      if (typeof v === "string") return "@";
      if (v === null) return now(r, i);
      return now(r, i) === "@" ? "General" : now(r, i);
    }));
  }
  if (!scratch) return null;
  return c.grid.map((row, r) => row.map((_v, i) => (now(r, i) === "@" ? "General" : now(r, i))));
}

function countFormatChanges(planned: string[][] | null, formats: unknown[][]): number {
  if (!planned) return 0;
  let n = 0;
  planned.forEach((row, r) => row.forEach((f, i) => { if (f !== String(formats[r]?.[i] ?? "General")) n += 1; }));
  return n;
}

const nonEmpty = (grid: unknown[][]): number => grid.flat().filter((v) => text(v) !== "").length;

/** Runs a read-only `op` through the serialized Excel queue with the Excel timeout bound. */
function excelRead<T>(run: ExcelRun, op: (ctx: Excel.RequestContext) => Promise<T>): Promise<T> {
  return withExcelTimeout((timedOut) =>
    enqueue(() => {
      if (timedOut.aborted) return Promise.reject(new ExcelBusy());
      return run((ctx) => (timedOut.aborted ? Promise.reject(new ExcelBusy()) : op(ctx)));
    }),
  );
}

/**
 * Runs a write `op` through the serialized Excel queue. Until `op` reports its first write request, the Excel timeout
 * rejects with ExcelBusy as for a read. After that the timeout no longer abandons the write: it only asks `op` to stop
 * at the next chunk boundary (via `timedOut`) and waits for it to settle, so `written` is exact; if settling takes longer
 * than WRITE_SETTLE_MS it rejects with Uncertain. Neither `op` nor a deferred Excel.run does anything once cancelled.
 */
function excelWrite<T>(run: ExcelRun, signal: AbortSignal | undefined, op: (ctx: Excel.RequestContext, timedOut: AbortSignal, writing: () => void) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  let writing = false;
  const gone = (): Error | null => (signal?.aborted ? new Stopped() : timeout.signal.aborted ? new ExcelBusy() : null);
  const work = enqueue(() => {
    const early = gone(); // cancelled or timed out while queued
    if (early) return Promise.reject(early);
    return run((ctx) => {
      const late = gone(); // Excel deferred the run (a cell was being edited) past the caller's wait or cancel
      return late ? Promise.reject(late) : op(ctx, timeout.signal, () => { writing = true; });
    });
  });
  return new Promise<T>((resolve, reject) => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const abandon = (e: Error) => {
      work.catch(() => undefined); // a late failure has nobody left to tell
      reject(e);
    };
    const timer = setTimeout(() => {
      timeout.abort();
      if (!writing) abandon(new ExcelBusy());
      else settle = setTimeout(() => abandon(new Uncertain()), WRITE_SETTLE_MS);
    }, EXCEL_OP_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(settle);
    };
    work.then(
      (v) => { done(); resolve(v); },
      (e: unknown) => { done(); reject(e); },
    );
  });
}

/** Rectangles of the grid written per request: at most WRITE_CHUNK_ROWS rows and about WRITE_CHUNK_CHARS of payload. */
interface Block { r: number; c: number; rows: number; cols: number }
function blocks(grid: Cell[][]): Block[] {
  const size = (v: Cell) => text(v).length + 4; // + quotes and separator
  const cols = grid[0]?.length ?? 0;
  const out: Block[] = [];
  let start = 0, acc = 0;
  const flush = (end: number) => {
    if (end > start) out.push({ r: start, c: 0, rows: end - start, cols });
  };
  grid.forEach((row, r) => {
    const rowSize = row.reduce((n: number, v) => n + size(v), 0);
    if (rowSize > WRITE_CHUNK_CHARS) {
      // One row over the budget: split it into column runs.
      flush(r);
      let c0 = 0, run = 0;
      row.forEach((v, i) => {
        if (run + size(v) > WRITE_CHUNK_CHARS && i > c0) {
          out.push({ r, c: c0, rows: 1, cols: i - c0 });
          c0 = i;
          run = 0;
        }
        run += size(v);
      });
      out.push({ r, c: c0, rows: 1, cols: cols - c0 });
      start = r + 1;
      acc = 0;
      return;
    }
    if (r - start >= WRITE_CHUNK_ROWS || acc + rowSize > WRITE_CHUNK_CHARS) {
      flush(r);
      start = r;
      acc = 0;
    }
    acc += rowSize;
  });
  flush(grid.length);
  return out;
}

const slice = <T,>(g: T[][], b: Block): T[][] => g.slice(b.r, b.r + b.rows).map((row) => row.slice(b.c, b.c + b.cols));

/**
 * Writes an already-checked proposal block by block. `stop` runs at each block boundary (never between a block's
 * format and its content) and throws to end the write; `writing` is called before the first write request.
 */
async function writeCells(ctx: Excel.RequestContext, ws: Excel.Worksheet, c: Checked, planned: string[][] | null, formats: unknown[][], stop: () => void, writing: () => void, progress: (n: number) => void): Promise<void> {
  for (const b of blocks(c.grid)) {
    stop();
    writing();
    const r1 = c.spec.r1 + b.r, c1 = c.spec.c1 + b.c;
    const range = ws.getRange(rangeSpec(r1, c1, r1 + b.rows - 1, c1 + b.cols - 1).a1());
    if (planned) {
      const fmts = slice(planned, b);
      const current = slice(formats, b).map((row) => row.map((f) => String(f ?? "General")));
      // Formats first and synced, so text is stored as text; skipped when nothing changes.
      if (fmts.some((row, r) => row.some((f, i) => f !== (current[r]?.[i] ?? "General")))) {
        range.numberFormat = fmts;
        await ctx.sync();
      }
    }
    const cells = slice(c.grid, b);
    if (c.kind === "values") range.values = cells.map((row) => row.map((v) => (v === null ? "" : v)));
    else range.formulas = cells as string[][];
    await ctx.sync();
    progress(b.rows * b.cols);
  }
}

function failure(e: unknown, fallback: string): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof Stopped) return WRITE_MESSAGES.stopped;
  if (e instanceof ExcelBusy) return WRITE_MESSAGES.busy;
  if (e instanceof Uncertain) return WRITE_MESSAGES.uncertain;
  if (isRecord(e) && e.code === "ItemNotFound") return WRITE_MESSAGES.notFound;
  return fallback; // Office's own text may quote workbook content; it never leaves the pane
}

/**
 * The diff for a proposal. Target "range": the current text of exactly the target range on the named sheet. Target
 * "scratch": the add-in-owned scratch sheet's current content there, if the sheet exists (`before` stays []). Formulas
 * naming a hidden sheet, and range targets with merged cells, are refused. Never throws.
 */
export async function previewWrite(run: ExcelRun, p: WriteProposal, limits: CopilotLimits, target: WriteTarget = "range"): Promise<PreviewResult> {
  try {
    const { cap, chars } = checkLimits(limits);
    if (target !== "scratch" && target !== "range") throw new Refusal(WRITE_MESSAGES.badTarget);
    const c = checkProposal(p, cap);
    const scratch = target === "scratch";
    if (!scratch && isReservedSheet(c.sheet)) throw new Refusal(WRITE_MESSAGES.reserved);
    const found = await excelRead(run, async (ctx) => {
      const { unchecked } = await checkReach(ctx, c);
      if (scratch) {
        const ws = await ownedScratch(ctx);
        if (!ws) return { id: "", current: EMPTY_TARGET, merged: "none" as const, unchecked };
        return { id: ws.id, current: await readTarget(ctx, ws.getRange(c.spec.a1())), merged: "none" as const, unchecked };
      }
      const ws = await userSheet(ctx, c.sheet);
      const range = ws.getRange(c.spec.a1());
      const merged = await mergedState(ctx, range);
      if (merged === "present") throw new Refusal(WRITE_MESSAGES.merged);
      return { id: ws.id, current: await readTarget(ctx, range), merged, unchecked };
    });
    const after = shorten(c.grid, chars);
    const { formulas, formats } = found.current;
    const formatChanges = countFormatChanges(plannedFormats(c, formats, scratch), formats);
    const filled = nonEmpty(formulas);
    const warnings: string[] = [];
    let before: string[][] = [];
    let shortened = after.shortened;
    if (found.unchecked) warnings.push(WRITE_WARNINGS.unchecked);
    if (scratch) {
      if (filled > 0) warnings.push(WRITE_WARNINGS.scratchOverwrite(filled));
    } else {
      const shown = shorten(formulas, chars);
      before = shown.grid;
      shortened ||= shown.shortened;
      if (filled > 0) warnings.push(WRITE_WARNINGS.overwrite(filled));
      if (formatChanges > 0) warnings.push(WRITE_WARNINGS.formatChanges(formatChanges));
      const asText = c.kind === "formulas" ? formats.flat().filter((f) => f === "@").length : 0;
      if (asText > 0) warnings.push(WRITE_WARNINGS.textFormatted(asText));
      if (found.merged === "unknown") warnings.push(WRITE_WARNINGS.mergedUnknown);
      warnings.push(WRITE_WARNINGS.tables);
    }
    if (shortened) warnings.push(WRITE_WARNINGS.shortened);
    warnings.push(scratch ? WRITE_WARNINGS.undoScratch : WRITE_WARNINGS.undo);
    return {
      ok: true,
      preview: {
        target, sheet: scratch ? SCRATCH_SHEET : c.sheet, sheetId: found.id, range: c.spec.a1(), rows: c.spec.rows, cols: c.spec.cols,
        cells: c.spec.cells, before, after: after.grid, kind: c.kind, warnings, formatChanges, overwrites: filled,
        stamp: scratch ? "" : stamp(formulas), afterStamp: stamp(c.grid),
      },
    };
  } catch (e) {
    return { ok: false, error: failure(e, WRITE_MESSAGES.readFailed) };
  }
}

/** True when `current` still matches what the analyst confirmed (shape, shown text and full typed content). */
function unchanged(current: unknown[][], preview: WritePreview, chars: number): boolean {
  return sameGrid(preview.before, shorten(current, chars).grid) && preview.stamp === stamp(current);
}

/**
 * Applies a proposal. Target "scratch" writes at the proposal's range on the add-in-owned scratch sheet (created when
 * absent); formulas there need `confirmed === true` too. Target "range" needs `confirmed === true` and the confirmed preview: the proposal must be the one previewed
 * and the sheet (by id) and range must be unchanged since. Never throws. Stopping (the signal) or the Excel timeout
 * takes effect between chunks; chunks already written stay written and are counted in `written`.
 */
export async function applyWrite(run: ExcelRun, p: WriteProposal, opts: ApplyOptions): Promise<ApplyResult> {
  let written = 0;
  try {
    if (!isRecord(opts)) throw new Refusal(WRITE_MESSAGES.badTarget);
    const { signal } = opts;
    if (signal?.aborted) throw new Stopped();
    const { cap, chars } = checkLimits(opts.limits);
    if (opts.target !== "scratch" && opts.target !== "range") throw new Refusal(WRITE_MESSAGES.badTarget);
    const c = checkProposal(p, cap);
    const scratch = opts.target === "scratch";
    // Formulas run in the analyst's workbook: even on the scratch sheet they need an explicit confirmation.
    if (opts.target === "scratch" && c.kind === "formulas" && opts.confirmed !== true) throw new Refusal(WRITE_MESSAGES.confirm);
    let confirmed: WritePreview | null = null;
    if (opts.target === "range") {
      if (opts.confirmed !== true) throw new Refusal(WRITE_MESSAGES.confirm);
      if (isReservedSheet(c.sheet)) throw new Refusal(WRITE_MESSAGES.reserved);
      const pv: unknown = opts.preview;
      if (!isRecord(pv) || pv.target !== "range" || pv.sheet !== c.sheet || pv.range !== c.spec.a1() || pv.kind !== c.kind) throw new Refusal(WRITE_MESSAGES.mismatch);
      // The content the analyst approved: what was shown and the full typed proposal.
      if (!sameGrid(pv.after, shorten(c.grid, chars).grid) || pv.afterStamp !== stamp(c.grid)) throw new Refusal(WRITE_MESSAGES.mismatch);
      confirmed = pv as unknown as WritePreview;
    }
    const select = opts.target === "scratch" && opts.select === true;
    return await excelWrite(run, signal, async (ctx, timedOut, writing) => {
      await checkReach(ctx, c); // re-resolved: the workbook may have changed since the preview
      let ws: Excel.Worksheet;
      let current: Target;
      if (confirmed) {
        ws = await userSheet(ctx, c.sheet);
        if (ws.id !== confirmed.sheetId) throw new Refusal(WRITE_MESSAGES.stale); // renamed or replaced since the preview
        const range = ws.getRange(c.spec.a1());
        if ((await mergedState(ctx, range)) === "present") throw new Refusal(WRITE_MESSAGES.merged);
        current = await readTarget(ctx, range);
        if (!unchanged(current.formulas, confirmed, chars)) throw new Refusal(WRITE_MESSAGES.stale);
      } else {
        const owned = await ownedScratch(ctx);
        if (owned) ws = owned;
        else {
          ws = ctx.workbook.worksheets.add(SCRATCH_SHEET);
          markOwned(ws, SCRATCH_MARK, "Created by the onboarding add-in for Copilot output.");
          await ctx.sync();
        }
        current = await readTarget(ctx, ws.getRange(c.spec.a1()));
      }
      const stop = () => {
        if (signal?.aborted) throw new Stopped();
        if (timedOut.aborted) throw new ExcelBusy();
      };
      await writeCells(ctx, ws, c, plannedFormats(c, current.formats, scratch), current.formats, stop, writing, (n) => { written += n; });
      if (select) {
        ws.activate();
        ws.getRange(c.spec.a1()).select();
        await ctx.sync();
      }
      return { ok: true as const, sheet: scratch ? SCRATCH_SHEET : c.sheet, range: c.spec.a1(), cells: c.spec.cells };
    });
  } catch (e) {
    const error = failure(e, WRITE_MESSAGES.writeFailed);
    return e instanceof Uncertain ? { ok: false, error, written, uncertain: true } : { ok: false, error, written };
  }
}

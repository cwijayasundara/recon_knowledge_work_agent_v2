// Client copy of the server rules (src/onboarding_agent/copilot/rules.py); keep the two in step.
// Mirrored exactly: the A1 grammar and bounds, MAX_FORMULA_CHARS (code points), truncate_cell (code points, hidden
// characters, nan/inf, >= 1e15 as text), is_hidden_char, the string stripping, quote balance and quoted-reference scan
// of check_formula, and valid_sheet_name except where noted. Where JavaScript cannot match Python the port is
// stricter, never looser, because the server refuses a whole result when one element fails its check:
// - valid_sheet_name: casefold() is approximated by upper-then-lower, so "hıstory" (dotless i) is also refused.
// - check_formula: the word boundary before a denied name or a [book] reference counts only ASCII letters, digits and
//   "_" as word characters, so "=éCALL(1)" is denied here but allowed by Python; İ and ı are read as i, as Python's
//   (?i) does. The trailing sheet-name class is broader than Python's \w. So a formula Python denies is always denied.
// - Unicode tables differ by version (the browser's ICU is newer than Python 3.12's Unicode 15): the hidden-character
//   category test can disagree on code points assigned since; the boundaries above do not depend on the tables.
// A denied function is refused both when called and as a bare name (Excel's eta-reduced lambdas pass a function
// without "(": =MAP(A1:A3, WEBSERVICE)). Fail closed: a LET/LAMBDA variable or any identifier spelled exactly like a
// denied function is refused too; column names inside structured-reference brackets (Table1[Image]) are ignored.
// checkFormula cannot know which sheets are hidden: write.ts checks references to hidden sheets in Excel.

export const MAX_ROW = 1_048_576;
export const MAX_COL = 16_384;
/** Excel's own formula limit; also bounds regex work. Counted in code points like Python's len(). */
export const MAX_FORMULA_CHARS = 8192;

const A1 = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?$/;
// Code points that are not Cc/Cf (variation selectors) plus the common Cf ones, as in rules.py.
const INVISIBLE = "\\x80-\\x9f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufe00-\\ufe0f\\ufeff";
const SHEET_BAD = new RegExp(`[\\[\\]:*?/\\\\\\x00-\\x1f\\x7f${INVISIBLE}]`, "u");
const CONTROL = new RegExp(`^[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f${INVISIBLE}]$`, "u");
const HIDDEN_CATEGORY = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u; // with the u flag a valid pair is one code point and does not match
// Python's str.isspace() set (used by strip() and the regex \s).
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const ALL_SPACE = new RegExp(`^[${PY_SPACE}]*$`, "u");
const LEADING_SPACE = new RegExp(`^[${PY_SPACE}]+`, "u");
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`, "u");

/** Python's str.strip() (or lstrip() with `leadingOnly`): the same whitespace set as str.isspace(). */
export function pyStrip(text: string, leadingOnly = false): string {
  const start = text.replace(LEADING_SPACE, "");
  return leadingOnly ? start : start.replace(TRAILING_SPACE, "");
}
// Word characters for the boundary before a denied name or [book]: ASCII only, so any non-ASCII neighbour counts as a
// boundary and the check is never looser than Python's \b, whatever Unicode version either side has.
const BOUNDARY_WORD = "A-Za-z0-9_";
// After [book]: wider than Python's \w (letters, numbers, marks), so the reference is caught at least as often.
const SHEET_WORD = "\\p{L}\\p{N}\\p{M}_";
const STRING_G = /"(?:[^"]|"")*"/g; // replace-only: never call test() on a g-flag regex
const DENY_FUNCS =
  "WEBSERVICE|FILTERXML|ENCODEURL|HYPERLINK|IMAGE|RTD|DDE|DDEAUTO|CALL|REGISTER(?:\\.ID)?|EXEC|EXECUTE" +
  "|SQL\\.REQUEST|FOPEN|FWRITE|FWRITELN|FREAD|FREADLN|RUN|PY|COPILOT|TRANSLATE|DETECTLANGUAGE|STOCKHISTORY" +
  // Dynamic references and workbook/environment introspection: they can reach hidden sheets or leak file paths.
  "|INDIRECT|CELL|INFO" +
  // File import (Excel's IMPORTTEXT/IMPORTCSV read local or network files).
  "|IMPORTTEXT|IMPORTCSV";
// The prefix may repeat (_xlfn._xlws.NAME). BARE starts a match only at the start of a prefix chain, so it stays linear.
const PREFIX = "(?:_xl(?:fn|ws)\\.)*";
// \b before a word character is spelled (?:^|[^\w]) so no lookbehind is needed (older Mac webviews lack it).
// _xll. (XLL add-ins) and _xludf. (VBA/custom-function UDFs) are rejected anywhere outside strings.
// No prefix group: the boundary already matches after the "." of a prefix (a repeated group would be quadratic).
const DENY = new RegExp(`(?:^|[^${BOUNDARY_WORD}])(?:${DENY_FUNCS})[${PY_SPACE}]*\\(|_xll\\.|_xludf\\.`, "iu");
// A denied name standing alone (a function passed as a value); run on code with strings and bracket contents blanked.
// ASCII-only neighbours, like DENY, so it matches whenever Python's (?<![\w.]) ... (?![\w.]) does.
const BARE = new RegExp(`(?:^|[^${BOUNDARY_WORD}.])${PREFIX}(?:${DENY_FUNCS})(?![${BOUNDARY_WORD}.])`, "iu");
// DDE pipe, path separators, URL schemes, and [book]Sheet! (quoted refs are checked by quotedRefIsExternal).
const EXTERNAL = new RegExp(`[|\\\\]|:\\/\\/|(?:^|[^${BOUNDARY_WORD}\\]])\\[[^\\[\\]@#]*\\]'?[${SHEET_WORD} .\\t\\r\\n]*'?!`, "iu");

export function isHiddenChar(ch: string, keepWs = false): boolean {
  if (keepWs && (ch === "\t" || ch === "\n" || ch === "\r")) return false;
  return HIDDEN_CATEGORY.test(ch) || CONTROL.test(ch);
}

function stripHidden(text: string): string {
  let out = "";
  for (const ch of text) if (!isHiddenChar(ch, true)) out += ch;
  return out;
}

function quotedRefIsExternal(code: string): boolean {
  const n = code.length;
  let i = 0;
  while (i < n) {
    if (code[i] !== "'") {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      if (code[j] === "'") {
        if (code[j + 1] === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j += 1;
    }
    if (j < n && code[j + 1] === "!" && /[[\]:/\\]/.test(code.slice(i + 1, j))) return true;
    i = j + 1;
  }
  return false;
}

export interface RangeSpec {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  rows: number;
  cols: number;
  cells: number;
  /** Canonical text: no `$`, upper case, a single cell without a colon. */
  a1(): string;
}

export function columnLetters(col: number): string {
  let out = "";
  for (let c = col; c > 0; c = Math.floor((c - 1) / 26)) out = String.fromCharCode(65 + ((c - 1) % 26)) + out;
  return out;
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/** A range from 1-based corners; corners are normalised so r1 <= r2 and c1 <= c2. */
export function rangeSpec(ra: number, ca: number, rb: number, cb: number): RangeSpec {
  const r1 = Math.min(ra, rb), r2 = Math.max(ra, rb), c1 = Math.min(ca, cb), c2 = Math.max(ca, cb);
  const rows = r2 - r1 + 1, cols = c2 - c1 + 1;
  return {
    r1, c1, r2, c2, rows, cols, cells: rows * cols,
    a1() {
      const first = `${columnLetters(c1)}${r1}`;
      return r1 === r2 && c1 === c2 ? first : `${first}:${columnLetters(c2)}${r2}`;
    },
  };
}

/** A1 or A1:B2 (no whitespace, sheet prefix or whole rows/columns). Callers enforce per-call caps with `cells`. */
export function parseRange(text: string): RangeSpec {
  const m = typeof text === "string" ? A1.exec(text) : null;
  if (!m) throw new Error("not a cell range");
  const c1 = columnNumber(m[1]!), r1 = Number(m[2]);
  const c2 = m[3] ? columnNumber(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1;
  for (const r of [r1, r2]) if (r < 1 || r > MAX_ROW) throw new Error("row out of bounds");
  for (const c of [c1, c2]) if (c < 1 || c > MAX_COL) throw new Error("column out of bounds");
  return rangeSpec(r1, c1, r2, c2);
}

export function validSheetName(name: string): string {
  // casefold() approximated by upper-then-lower (catches "hiſtory" and the "ﬅ" ligature); where the two differ
  // ("hıstory") this is the stricter one.
  if (
    typeof name !== "string" ||
    ALL_SPACE.test(name) ||
    name.length > 31 || // UTF-16 code units, as Excel counts them
    name.startsWith("'") ||
    name.endsWith("'") ||
    name.toUpperCase().toLowerCase() === "history" ||
    SHEET_BAD.test(name) ||
    LONE_SURROGATE.test(name) ||
    [...name].some((ch) => isHiddenChar(ch))
  ) {
    throw new Error("invalid sheet name");
  }
  return name;
}

export type CellScalar = string | number | boolean | null;

/**
 * A scalar cell value capped at `limit` code points (an ellipsis marks a cut). Hidden characters are stripped; numbers
 * with abs >= 1e15 and non-finite numbers become strings so precision is never silently lost.
 */
export function truncateCell(value: unknown, limit: number): CellScalar {
  if (!(limit >= 1)) throw new Error("limit must be >= 1");
  if (value === null || typeof value === "boolean") return value;
  let text: string;
  if (typeof value === "number") {
    if (Number.isNaN(value)) text = "nan";
    else if (!Number.isFinite(value)) text = value > 0 ? "inf" : "-inf";
    else if (Math.abs(value) < 1e15) return value;
    else text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    throw new Error("not a cell value");
  }
  const cleaned = [...stripHidden(text)];
  return cleaned.length <= limit ? cleaned.join("") : cleaned.slice(0, limit).join("") + "…";
}

function codePointLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1) n += 1;
  return n;
}

/** Spaces for everything inside [...] at any depth (structured-reference column names); one linear pass. */
export function blankBrackets(code: string): string {
  let depth = 0;
  let out = "";
  for (const ch of code) {
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      if (depth === 0) throw new Error("formula has unbalanced brackets");
      depth -= 1;
    } else if (depth > 0) {
      out += " ";
      continue;
    }
    out += ch;
  }
  if (depth !== 0) throw new Error("formula has unbalanced brackets");
  return out;
}

export function checkFormula(formula: string): void {
  if (typeof formula !== "string") throw new Error("formula must be text");
  // The cheap UTF-16 bound first: every code point is at most two units.
  if (formula.length > 2 * MAX_FORMULA_CHARS || codePointLength(formula) > MAX_FORMULA_CHARS) throw new Error("formula is too long");
  const code = formula.replace(STRING_G, '""');
  if (code.replace(STRING_G, "").includes('"')) throw new Error("formula has unbalanced quotes");
  for (const ch of code) if (isHiddenChar(ch, true)) throw new Error("formula has control or invisible characters");
  const folded = code.replace(/[\u0130\u0131]/gu, "i"); // Python's (?i) matches İ and ı to i; JS's iu flags do not
  if (DENY.test(folded) || EXTERNAL.test(folded) || quotedRefIsExternal(folded)) {
    throw new Error("formula uses a function or reference that is not allowed");
  }
  if (BARE.test(blankBrackets(folded))) throw new Error("formula uses a function or reference that is not allowed");
}

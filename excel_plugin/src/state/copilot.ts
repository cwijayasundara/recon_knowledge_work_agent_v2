// Pure helpers for the Copilot panel: message pre-validation (the server's StepIn._v_message), the fixed error lines,
// the read-log lines and the bounded display grids of write proposals. Nothing here shows server or Office text.
import { COPILOT_MESSAGES, CopilotError, type CopilotFailure, type ReadLogEntry } from "../copilot/session";
import { isHiddenChar, parseRange, pyStrip, truncateCell, validSheetName } from "../copilot/rules";
import type { WriteProposal } from "../copilot/types";
import type { ApplyResult } from "../copilot/write";

/** The server's user_message bound, in code points (Python's len()). */
export const COPILOT_MAX_CHARS = 8000;
/** Display bounds of a write card's table: the DOM stays small whatever the proposal's size. */
export const GRID_MAX_ROWS = 20;
export const GRID_MAX_COLS = 8;
/** Characters of one cell shown in a write card before the proposal is previewed. */
export const GRID_CELL_CHARS = 200;
/** Write proposals shown per answer; the rest are counted. */
export const MAX_WRITE_CARDS = 10;
/** Transcript entries kept in the DOM; older ones are counted in one line. */
export const MAX_RENDERED_ENTRIES = 50;

export const DISABLED_TEXT = "Copilot is turned off on this server.";
export const PRIVACY_NOTICE = "The copilot sends the cells it reads (up to the server's caps) to the server's AI model. The copilot's tools never read hidden sheets directly; a visible cell whose formula references a hidden sheet shows that sheet's value.";
export const NO_ANSWER = "The copilot returned no answer.";
export const RUN_CHANGED_SEPARATOR = "New conversation (active run changed)";
export const RESTARTED_SEPARATOR = "New conversation (the previous copilot session ended)";
export const STOPPED_TEXT = "Stopped.";
export const STOPPED_RUN_CHANGED = "Stopped (active run changed).";
export const FINISHING_TEXT = "Finishing the previous request…";
export const NO_RUN_TO_APPLY = "No active run to apply this to.";
export const OTHER_RUN = "This proposal was made for another run; it can't be applied to the active one.";
export const NOT_LATEST = "A newer answer replaced this proposal.";
export const STALE_ANSWER = "The run changed since this answer; ask again.";
export const FORMULAS_RUN = "Formulas run in your workbook.";
export const INVALID_PROPOSAL = "invalid proposal";
export const moreWrites = (n: number) => `${n} more write proposal${n === 1 ? "" : "s"} not shown.`;
export const hiddenEntries = (n: number) => `${n} earlier message${n === 1 ? "" : "s"} hidden.`;
export const NO_LIMITS = "The copilot's limits are unknown; send another message first.";

export const EMPTY_MESSAGE = "Enter a message.";
export const tooLongMessage = (n: number) => `Too long: at most ${COPILOT_MAX_CHARS} characters (now ${n}).`;
export const HIDDEN_MESSAGE = "Remove hidden or control characters; only line breaks and tabs are allowed.";

/** The panel's line for every failure kind: fixed strings only, never the server's or Office's text. */
export const PANEL_MESSAGES: Record<CopilotFailure, string> = {
  ...COPILOT_MESSAGES,
  disabled: DISABLED_TEXT,
  session_lost: "The session was lost again. Please try again.",
  busy: "The copilot is busy; try again shortly.",
  too_many: "Too many open copilot sessions; close the pane or wait.",
  aborted: STOPPED_TEXT,
  step_running: "The previous request is still finishing; try again.",
  turn_timeout: "This request took too long and was stopped.",
  run_not_found: "The active run could not be found.",
  run_changed: "The active run changed; please resend.",
  protocol: "The copilot returned an unexpected response.",
};

/** Failures where the message never reached the copilot: the composer keeps it and the transcript says "Not sent". */
export const NOT_SENT: ReadonlySet<CopilotFailure> = new Set<CopilotFailure>([
  "disabled", "session_lost", "too_many", "busy", "too_large", "bad_request", "in_progress", "step_running", "closed", "run_not_found", "run_changed",
]);

export interface FailureLine { kind: CopilotFailure; text: string }

/** "Error: …" text for a failed turn or check; anything that is not a CopilotError is "other". */
export function failureLine(e: unknown): FailureLine {
  const kind: CopilotFailure = e instanceof CopilotError ? e.kind : "other";
  const ref = e instanceof CopilotError && e.requestId ? ` (ref ${e.requestId})` : "";
  return { kind, text: `${PANEL_MESSAGES[kind]}${ref}` };
}

export type MessageCheck =
  | { ok: true; text: string; count: number }
  | { ok: false; reason: "empty" | "too-long" | "hidden"; count: number };

/** Mirrors StepIn._v_message: CRLF to LF, Python strip, no hidden/control characters but \n and \t, 1..8000 code points. */
export function checkMessage(raw: string): MessageCheck {
  const text = pyStrip(raw.replace(/\r\n/g, "\n"));
  const chars = [...text];
  const count = chars.length;
  if (chars.some((ch) => /^[\uD800-\uDFFF]$/.test(ch) || (isHiddenChar(ch) && ch !== "\n" && ch !== "\t"))) return { ok: false, reason: "hidden", count };
  if (count === 0) return { ok: false, reason: "empty", count };
  if (count > COPILOT_MAX_CHARS) return { ok: false, reason: "too-long", count };
  return { ok: true, text, count };
}

/** One read-log line: the tool and its address and cell count, never content. */
export function readLine(e: ReadLogEntry): string {
  const where = e.sheet && e.range ? `${e.sheet}!${e.range}` : e.sheet ?? e.range ?? "";
  return `${e.tool}${where ? ` ${where}` : ""}: ${e.cells} cell${e.cells === 1 ? "" : "s"}${e.ok ? "" : " (failed)"}`;
}

export interface DisplayGrid { rows: string[][]; moreRows: number; moreCols: number }

const cellText = (v: unknown, chars: number): string => {
  const t = truncateCell(v, chars);
  if (typeof t === "boolean") return t ? "TRUE" : "FALSE";
  return t === null ? "" : String(t);
};

/** At most GRID_MAX_ROWS x GRID_MAX_COLS cells of an untrusted grid, as shortened text; the rest is counted. */
export function displayGrid(grid: unknown, chars = GRID_CELL_CHARS): DisplayGrid {
  const rows = Array.isArray(grid) ? grid : [];
  const width = rows.reduce((w: number, r: unknown) => Math.max(w, Array.isArray(r) ? r.length : 0), 0);
  return {
    rows: rows.slice(0, GRID_MAX_ROWS).map((r: unknown) => {
      const row = Array.isArray(r) ? r : [];
      return Array.from({ length: Math.min(width, GRID_MAX_COLS) }, (_v, i) => cellText(row[i], chars));
    }),
    moreRows: Math.max(0, rows.length - GRID_MAX_ROWS),
    moreCols: Math.max(0, width - GRID_MAX_COLS),
  };
}

const cells = (n: number) => `${n} cell${n === 1 ? "" : "s"}`;

/** The status line of a write: what was written, or the fixed refusal with an honest count of cells already written. */
export function writeResultLine(r: ApplyResult): { ok: boolean; text: string } {
  if (r.ok) return { ok: true, text: `Wrote ${cells(r.cells)} to ${r.sheet}!${r.range}.` };
  if (r.uncertain) return { ok: false, text: `Warning: The write may be partly applied; check the range (≥ ${cells(r.written)} written).` };
  const partial = r.written > 0 ? ` ${cells(r.written)} were already written; check the range.` : "";
  return { ok: false, text: `Error: ${r.error}${partial}` };
}

/** A sheet name as Excel quotes it in a reference ('It''s'). */
export const quoteSheet = (name: string): string => `'${name.replace(/'/g, "''")}'`;

/** The proposal's validated sheet, canonical range and cell count, or null when either is invalid (nothing is shown raw). */
export function writeShape(p: WriteProposal): { sheet: string; range: string; where: string; cells: number } | null {
  try {
    const sheet = validSheetName(p.sheet);
    const spec = parseRange(p.range);
    return { sheet, range: spec.a1(), where: `${sheet}!${spec.a1()}`, cells: spec.cells };
  } catch {
    return null;
  }
}

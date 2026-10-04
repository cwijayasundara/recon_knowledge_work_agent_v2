// Test-only port of the server's client-result checks (engine.py: _shaped, _describe, _selection, _find,
// _read_payload, _error_detail). A result this validator refuses would be refused by the live loop.
import { parseRange, truncateCell, validSheetName } from "../../src/copilot/rules";
import type { CopilotLimits, ToolResult } from "../../src/copilot/types";

const MAX_SHEETS = 200, MAX_HEADERS = 50, MAX_MERGED = 50, MAX_SELECTION_VALUES = 25, MAX_RAW_HITS = 1000, MAX_READ_RESULT_BYTES = 256_000;
const COUNT_KEYS = new Set(["formulas", "constants", "blanks"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sheetOk = (v: unknown) => { try { return typeof v === "string" && validSheetName(v) === v; } catch { return false; } };
const a1 = (v: unknown): string | null => { try { return typeof v === "string" ? parseRange(v).a1() : null; } catch { return null; } };
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e12;
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`unexpected result shape: ${what}`);
}

function keys(c: unknown, allowed: string[], required: string[] = []): Record<string, unknown> {
  need(isRecord(c), "expected an object");
  const o = c as Record<string, unknown>;
  need(Object.keys(o).every((k) => allowed.includes(k)), `allowed keys are ${allowed.join(", ")}`);
  need(required.every((k) => k in o), `required keys are ${required.join(", ")}`);
  return o;
}

/** count_cells: a 2D list of scalars. */
function countCells(g: unknown): number {
  need(Array.isArray(g), "values must be a 2D list");
  let n = 0;
  for (const row of g as unknown[]) {
    need(Array.isArray(row) && (row as unknown[]).every(isScalar), "values must be a 2D list of scalars");
    n += (row as unknown[]).length;
  }
  return n;
}

/** Python's json.dumps(ensure_ascii) length with wrap()'s < > & escapes, for ASCII-or-not strings. */
function wrapLength(payload: unknown): number {
  const json = JSON.stringify(payload);
  let n = 0;
  for (let i = 0; i < json.length; i++) {
    const u = json.charCodeAt(i);
    n += u > 0x7e || u === 0x3c || u === 0x3e || u === 0x26 ? 6 : 1;
  }
  // JSON.stringify writes ", " nowhere and \u escapes for controls like Python; '<tool_result untrusted tool="read_range">' + '</tool_result>'
  return n + 57;
}

/** Throws like the server would; returns the number of cells the session would be charged. */
export function validateClientResult(tool: string, result: ToolResult, request: { range?: string }, limits: CopilotLimits): number {
  if (!result.ok) {
    const c = keys(result.content, ["message"], ["message"]);
    need(typeof c.message === "string" && (c.message as string).length <= 200 && (c.message as string).length > 0, "message");
    return 0;
  }
  const content = result.content;
  switch (tool) {
    case "list_sheets": {
      const c = keys(content, ["sheets"], ["sheets"]);
      need(Array.isArray(c.sheets) && (c.sheets as unknown[]).length <= MAX_SHEETS, "sheets");
      need((c.sheets as unknown[]).every(sheetOk), "sheets must be valid sheet names");
      return (c.sheets as unknown[]).length;
    }
    case "describe_sheet": {
      const c = keys(content, ["used_range", "headers", "merged", "counts"]);
      if (c.used_range !== null && c.used_range !== undefined) need(a1(c.used_range) === c.used_range, "used_range canonical A1");
      const headers = c.headers ?? [];
      need(Array.isArray(headers) && headers.length <= MAX_HEADERS && headers.every((h) => typeof h === "string"), "headers");
      need((headers as string[]).every((h) => truncateCell(h, 120) === h), "headers cut to 120");
      const merged = c.merged ?? [];
      need(Array.isArray(merged) && merged.length <= MAX_MERGED && merged.every((m) => a1(m) === m), "merged");
      const counts = c.counts ?? {};
      need(isRecord(counts) && Object.keys(counts).every((k) => COUNT_KEYS.has(k)) && Object.values(counts).every(isCount), "counts");
      return 1 + (headers as unknown[]).length + (merged as unknown[]).length;
    }
    case "get_selection": {
      const c = keys(content, ["sheet", "address", "cells", "values"], ["sheet", "address", "cells"]);
      need(sheetOk(c.sheet) && a1(c.address) === c.address, "sheet and address");
      need(isCount(c.cells), "cells");
      let n = 0;
      if ("values" in c) {
        n = countCells(c.values);
        need(n <= MAX_SELECTION_VALUES, "values only for <= 25 cells");
        need(n === c.cells, "values match the selection");
      }
      return 2 + n;
    }
    case "find": {
      const c = keys(content, ["hits", "truncated"], ["hits"]);
      need(Array.isArray(c.hits) && (c.hits as unknown[]).length <= MAX_RAW_HITS, "hits");
      need(c.truncated === undefined || typeof c.truncated === "boolean", "truncated");
      const limit = Math.min(120, limits.cell_char_limit);
      for (const h of c.hits as unknown[]) {
        need(isRecord(h) && Object.keys(h).sort().join() === "address,sheet,text" && typeof h.text === "string", "hit keys");
        const hit = h as Record<string, unknown>;
        // The server drops invalid hits silently; the client must never send one.
        need(sheetOk(hit.sheet) && a1(hit.address) === hit.address, "hit sheet/address");
        need([...(hit.text as string)].length <= limit, "excerpt length");
      }
      need((c.hits as unknown[]).length <= 50, "client keeps <= 50 hits");
      return 3 * (c.hits as unknown[]).length;
    }
    case "read_range": {
      need(isRecord(content) && Array.isArray(content.values), "malformed read_range result: values must be a 2D list");
      const c = content as Record<string, unknown>;
      need(c.formulas === undefined || Array.isArray(c.formulas), "formulas must be a 2D list");
      const spec = parseRange(request.range!);
      const grids = (c.formulas === undefined ? [c.values] : [c.values, c.formulas]) as unknown[][];
      const counts = grids.map(countCells);
      for (const g of grids) need(g.length <= spec.rows && g.every((row) => (row as unknown[]).length <= spec.cols), "larger than the requested range");
      for (const n of counts) need(n <= limits.max_cells_per_call, "grid over the per-call cap");
      const payload: Record<string, unknown> = {
        ok: true, sheet: "S".repeat(31), range: spec.a1(), rows: (c.values as unknown[]).length, cols: 0,
        values: c.values, truncated: c.truncated === true,
      };
      if (c.formulas !== undefined) payload.formulas = c.formulas;
      need(wrapLength(payload) <= MAX_READ_RESULT_BYTES, "result too large");
      // Client-side extras the server ignores, checked for honesty: address lies within the request and matches the grid.
      const addr = parseRange(c.address as string);
      need(addr.a1() === c.address, "address canonical");
      need(addr.r1 === spec.r1 && addr.c1 === spec.c1 && addr.r2 <= spec.r2 && addr.c2 <= spec.c2, "address within the request");
      need(c.rows === addr.rows && c.cols === addr.cols, "rows/cols match the address");
      for (const g of grids) need(g.length === addr.rows && g.every((row) => (row as unknown[]).length === addr.cols), "grid is rows x cols");
      need(Object.keys(c).every((k) => ["address", "rows", "cols", "values", "formulas", "truncated"].includes(k)), "read_range keys");
      return Math.max(...counts);
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

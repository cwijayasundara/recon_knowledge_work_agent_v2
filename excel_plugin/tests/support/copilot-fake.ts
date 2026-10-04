// Strict fake workbook for the Copilot's read tools. Like Office: a property throws PropertyNotLoaded until load() and
// sync() have both run, a missing sheet fails at sync() with ItemNotFound, a null object's properties throw, and an
// empty sheet's getUsedRange() is A1. Every write, select or activate is recorded so tests can assert there are none.
// Casts are confined to this fake.
import { columnLetters, parseRange } from "../../src/copilot/rules";

export type FakeValue = string | number | boolean | null;
/** A formula cell: Excel's `formulas` shows `f`, `values` shows the computed `v`. */
export interface FakeFormula { f: string; v: FakeValue }
export type FakeCell = FakeValue | FakeFormula | undefined;

export interface FakeSheet {
  /** Rows from A1; `undefined`, null and "" are empty cells. */
  cells: FakeCell[][];
  merged?: string[];
  protected?: boolean;
  /** Excel.SheetVisibility; default "Visible". */
  visibility?: "Visible" | "Hidden" | "VeryHidden";
}

export interface FakeSelection {
  sheet: string;
  address: string;
}

const ERRORS = new Set(["#N/A", "#DIV/0!", "#REF!", "#VALUE!", "#NAME?", "#NUM!", "#NULL!", "#SPILL!", "#CALC!"]);
const isFormulaCell = (c: FakeCell): c is FakeFormula => typeof c === "object" && c !== null;
const isEmpty = (c: FakeCell) => c === undefined || c === null || c === "";

function notLoaded(key: string): Error {
  return Object.assign(new Error(`PropertyNotLoaded: ${key}`), { code: "PropertyNotLoaded" });
}

export interface FakeOptions {
  selection?: FakeSelection;
  /** Excel builds before ExcelApi 1.13 have no Range.getMergedAreasOrNullObject. */
  noMergedApi?: boolean;
  /** getMergedAreasOrNullObject fails at sync (Excel can refuse it on very large ranges). */
  mergedFails?: boolean;
}

export function createCopilotFake(sheets: Record<string, FakeSheet>, opts: FakeOptions = {}) {
  const writes: string[] = [];
  const loads: { address: string; props: string[]; cells: number }[] = [];
  const queued: (() => void)[] = [];
  const requested = new Set<string>();
  let syncs = 0;
  let mergedCalls = 0;
  const visibility = (n: string) => sheets[n]?.visibility ?? "Visible";
  let runs = 0;
  let failNext: unknown = null;
  let hold: { promise: Promise<void>; release: () => void } | null = null;
  const order: string[] = [];

  /** Any assignment is a write; it is recorded (and applied nowhere). */
  function guard<T extends object>(o: T, label: string): T {
    return new Proxy(o, {
      set(t, prop, v) {
        if (Object.getOwnPropertyDescriptor(t, prop)?.set) return Reflect.set(t, prop, v);
        writes.push(`${label}.${String(prop)}=`);
        return true;
      },
    });
  }

  function loadable(label: string, read: Record<string, () => unknown>, onLoad?: (props: string[]) => void): Record<string, unknown> {
    const loaded = new Set<string>();
    const o: Record<string, unknown> = {
      load(names: string) {
        if (typeof names !== "string") throw new Error("fake supports load(string) only");
        const list = names.split(",").map((n) => n.trim());
        for (const n of list) if (!(n in read)) throw new Error(`fake: ${label} has no property ${n}`);
        onLoad?.(list);
        queued.push(() => list.forEach((n) => loaded.add(n)));
      },
    };
    for (const [key, get] of Object.entries(read)) {
      Object.defineProperty(o, key, {
        configurable: true,
        get() {
          if (!loaded.has(key)) throw notLoaded(key);
          return get();
        },
        set() {
          writes.push(`${label}.${key}=`);
        },
      });
    }
    for (const m of ["select", "activate", "clear", "delete", "insert", "merge", "unmerge", "copyFrom", "autofitColumns", "autofitRows"]) {
      o[m] = () => { writes.push(`${label}.${m}()`); };
    }
    return o;
  }

  function rangeApi(sheetName: string, address: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const p = parseRange(address);
    const sheet = () => sheets[sheetName]!;
    const at = (r: number, c: number): FakeCell => sheet().cells[r - 1]?.[c - 1];
    const grid = <T,>(f: (c: FakeCell) => T) => {
      const rows: T[][] = [];
      for (let r = p.r1; r <= p.r2; r++) {
        const row: T[] = [];
        for (let c = p.c1; c <= p.c2; c++) row.push(f(at(r, c)));
        rows.push(row);
      }
      return rows;
    };
    const value = (c: FakeCell): FakeValue => (isFormulaCell(c) ? c.v : isEmpty(c) ? "" : (c as FakeValue));
    const range = loadable(
      `${sheetName}!${address}`,
      {
        values: () => grid(value),
        formulas: () => grid((c) => (isFormulaCell(c) ? c.f : isEmpty(c) ? "" : (c as FakeValue))),
        valueTypes: () =>
          grid((c) => {
            const v = value(c);
            if (isEmpty(c)) return "Empty";
            if (typeof v === "string") return ERRORS.has(v) ? "Error" : v === "" ? "Empty" : "String";
            return typeof v === "number" ? "Double" : "Boolean";
          }),
        isNullObject: () => false,
        rowIndex: () => p.r1 - 1,
        columnIndex: () => p.c1 - 1,
        rowCount: () => p.rows,
        columnCount: () => p.cols,
        // Excel quotes some sheet names; executors must build addresses from indices, not parse this.
        address: () => `'${sheetName}'!${address}`,
      },
      (props) => {
        if (props.some((n) => n === "values" || n === "formulas" || n === "valueTypes")) loads.push({ address: `${sheetName}!${p.a1()}`, props, cells: p.cells });
      },
    );
    if (!opts.noMergedApi) {
      range.getMergedAreasOrNullObject = () => {
        mergedCalls += 1;
        if (opts.mergedFails) failNext = Object.assign(new Error("merged failed"), { code: "GeneralException" });
        const inside = (sheet().merged ?? []).map((m) => parseRange(m)).filter((m) => m.r1 <= p.r2 && m.r2 >= p.r1 && m.c1 <= p.c2 && m.c2 >= p.c1);
        const areas = loadable(`${sheetName} merged`, { isNullObject: () => inside.length === 0, areaCount: () => { if (!inside.length) throw new Error("null object"); return inside.length; } });
        areas.areas = {
          getItemAt(i: number) {
            const m = inside[i];
            if (!m) throw new Error("fake: getItemAt out of range");
            return rangeApi(sheetName, m.a1());
          },
        };
        return areas;
      };
    }
    Object.assign(range, extra);
    return guard(range, `${sheetName}!${address}`);
  }

  function usedSpan(name: string): string | null {
    const cells = sheets[name]?.cells ?? [];
    let r1 = Infinity, c1 = Infinity, r2 = 0, c2 = 0;
    cells.forEach((row, r) => row.forEach((c, i) => {
      if (isEmpty(c)) return;
      r1 = Math.min(r1, r + 1); r2 = Math.max(r2, r + 1); c1 = Math.min(c1, i + 1); c2 = Math.max(c2, i + 1);
    }));
    return r2 === 0 ? null : `${columnLetters(c1)}${r1}:${columnLetters(c2)}${r2}`;
  }

  function nullRange(label: string): Record<string, unknown> {
    const nope = () => { throw new Error("null object"); };
    return loadable(label, { isNullObject: () => true, rowIndex: nope, columnIndex: nope, rowCount: nope, columnCount: nope, address: nope });
  }

  function sheetApi(name: string): Record<string, unknown> {
    requested.add(name);
    const ws = loadable(`sheet ${name}`, { name: () => name, visibility: () => visibility(name) });
    ws.getRange = (addr: string) => rangeApi(name, addr);
    ws.getUsedRange = () => rangeApi(name, usedSpan(name) ?? "A1");
    ws.getUsedRangeOrNullObject = () => {
      const span = usedSpan(name);
      return span ? rangeApi(name, span) : nullRange(`${name} used`);
    };
    ws.protection = loadable(`sheet ${name} protection`, { protected: () => sheets[name]?.protected ?? false });
    return guard(ws, `sheet ${name}`);
  }

  const ctx = {
    workbook: {
      worksheets: guard({
        load(names: string) {
          // Only the shape Office documents for collections; a missing visibility load must fail the test.
          if (names !== "items/name,items/visibility") throw new Error("fake supports worksheets.load('items/name,items/visibility') only");
          queued.push(() => { itemsLoaded = true; });
        },
        get items() {
          if (!itemsLoaded) throw notLoaded("items");
          return Object.keys(sheets).map((n) => ({ name: n, visibility: visibility(n) }));
        },
        getItem: (name: string) => sheetApi(name),
        add(name: string) { writes.push(`add ${name}`); },
      }, "worksheets"),
      getSelectedRange() {
        const s = opts.selection;
        if (!s) throw new Error("fake: no selection");
        requested.add(s.sheet);
        return rangeApi(s.sheet, s.address, { worksheet: loadable("selection sheet", { name: () => s.sheet, visibility: () => visibility(s.sheet) }) });
      },
    },
    async sync() {
      syncs += 1;
      if (failNext) {
        const e = failNext;
        failNext = null;
        queued.length = 0;
        throw e;
      }
      const missing = [...requested].find((n) => !(n in sheets));
      requested.clear();
      if (missing !== undefined) {
        queued.length = 0;
        throw Object.assign(new Error(`The requested resource doesn't exist: ${missing}`), { code: "ItemNotFound" });
      }
      queued.splice(0).forEach((f) => f());
    },
  };
  let itemsLoaded = false;

  return {
    ctx,
    writes,
    mergedCalls: () => mergedCalls,
    loads,
    order,
    runs: () => runs,
    syncs: () => syncs,
    /** The next sync fails with this error (an Office error object). */
    failNextSync(e: unknown) { failNext = e; },
    /** Excel.run is deferred (the user is editing a cell) until release(). */
    hold() {
      let release!: () => void;
      const promise = new Promise<void>((r) => { release = r; });
      hold = { promise, release };
      return release;
    },
    run: <T,>(cb: (c: never) => Promise<T>): Promise<T> => {
      runs += 1;
      itemsLoaded = false; // each run is a fresh request context
      order.push(`run ${runs}`);
      const h = hold;
      return h ? h.promise.then(() => cb(ctx as never)) : cb(ctx as never);
    },
  };
}

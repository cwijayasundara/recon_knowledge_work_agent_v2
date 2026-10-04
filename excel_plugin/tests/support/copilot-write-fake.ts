// Strict fake workbook for the Copilot's write executor. Like Office: a property throws PropertyNotLoaded until
// load() and sync() have both run; writes are queued and applied at sync(); sheet names match case-insensitively;
// a value written into a cell formatted "@" is stored as text, otherwise Excel interprets it ("=..." becomes a
// formula, "12" a number); a formula written into a "@" cell is stored as text. Every range request, load and write
// is logged in order (with "sync" markers) so tests can assert what was touched and when. Casts are confined here.
import { parseRange } from "../../src/copilot/rules";

export type FakeScalar = string | number | boolean;
/** A formula cell; reading `values` gives 0 (the fake does not calculate). */
export interface FakeFormulaCell { f: string }
export type FakeCell = FakeScalar | FakeFormulaCell | null | undefined;

export interface FakeWriteSheet {
  name: string;
  /** Rows from A1; null/undefined/"" are empty. */
  cells?: FakeCell[][];
  /** Number formats by A1 address ("General" when absent). */
  formats?: Record<string, string>;
  protected?: boolean;
  visibility?: "Visible" | "Hidden" | "VeryHidden";
  /** Worksheet-scoped defined names (an ownership marker goes here). */
  names?: string[];
  /** Merged areas (A1 ranges). */
  merged?: string[];
  /** Worksheet-scoped defined names with their formulas (in addition to `names`, whose markers point at A1). */
  scopedNames?: Record<string, string>;
}

interface Sheet {
  id: string;
  name: string;
  cells: Map<string, FakeScalar | FakeFormulaCell>;
  formats: Map<string, string>;
  protected: boolean;
  visibility: string;
  names: Map<string, { hidden: boolean; formula: string }>;
  merged: string[];
}

const key = (r: number, c: number) => `${r},${c}`;
const isFormulaCell = (c: unknown): c is FakeFormulaCell => typeof c === "object" && c !== null && "f" in c;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SENTINEL_FAKE = "SENTINEL-fake-office-text";
const officeError = (code: string, message: string) => Object.assign(new Error(message), { code });

export interface WriteFakeOptions {
  /** Requested names Excel resolves to another sheet (its matching can be broader than the client's case fold). */
  aliases?: Record<string, string>;
  /** Workbook-scoped defined names with their formulas. */
  names?: Record<string, string>;
  /** Tables and the sheet each is on. */
  tables?: { name: string; sheet: string }[];
  /** Loading defined names (workbook.names or a worksheet's names) fails at sync, as on hosts without ExcelApi 1.7. */
  namesFail?: boolean;
  /** Loading tables fails at sync. */
  tablesFail?: boolean;
  /** worksheets.items come back rotated by one (positions stay right), so callers must sort by position. */
  rotateItems?: boolean;
}

export function createWriteFake(init: FakeWriteSheet[], opts: WriteFakeOptions = {}) {
  const sheets: Sheet[] = [];
  /** Ordered log: "range S!A1", "load S!A1 values", "set numberFormat S!A1", "sync", "add S", ... */
  const log: string[] = [];
  const queued: (() => void)[] = [];
  let nextId = 1;
  let syncs = 0;
  let failAt: { n: number; error: unknown } | null = null;
  let stallAt: { n: number; promise: Promise<void> } | null = null;
  let hold: Promise<void> | null = null;
  let afterSync: ((n: number) => void) | null = null;
  let runs = 0;

  function addSheet(s: FakeWriteSheet): Sheet {
    const sheet: Sheet = {
      id: `{id-${nextId++}}`,
      name: s.name,
      cells: new Map(),
      formats: new Map(),
      protected: s.protected ?? false,
      visibility: s.visibility ?? "Visible",
      names: new Map([
        ...(s.names ?? []).map((n): [string, { hidden: boolean; formula: string }] => [n, { hidden: true, formula: `='${s.name}'!$A$1` }]),
        ...Object.entries(s.scopedNames ?? {}).map(([n, f]): [string, { hidden: boolean; formula: string }] => [n, { hidden: false, formula: f }]),
      ]),
      merged: s.merged ?? [],
    };
    (s.cells ?? []).forEach((row, r) => row.forEach((c, i) => {
      if (c !== null && c !== undefined && c !== "") sheet.cells.set(key(r + 1, i + 1), c);
    }));
    for (const [addr, fmt] of Object.entries(s.formats ?? {})) {
      const p = parseRange(addr);
      for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) sheet.formats.set(key(r, c), fmt);
    }
    sheets.push(sheet);
    return sheet;
  }
  init.forEach(addSheet);

  const find = (requested: string) => {
    const name = opts.aliases?.[requested] ?? requested;
    return sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
  };

  function loadable(label: string, read: Record<string, () => unknown>, set: Record<string, (v: unknown) => void> = {}): Record<string, unknown> {
    const loaded = new Set<string>();
    const o: Record<string, unknown> = {
      load(names: string) {
        if (typeof names !== "string") throw new Error("fake supports load(string) only");
        const list = names.split(",").map((n) => n.trim());
        for (const n of list) if (!(n in read)) throw new Error(`fake: ${label} has no property ${n}`);
        log.push(`load ${label} ${list.join(",")}`);
        queued.push(() => list.forEach((n) => loaded.add(n)));
      },
    };
    for (const [k, get] of Object.entries(read)) {
      Object.defineProperty(o, k, {
        configurable: true,
        enumerable: true,
        get() {
          if (!loaded.has(k)) throw Object.assign(new Error(`PropertyNotLoaded: ${k}`), { code: "PropertyNotLoaded" });
          return get();
        },
        set(v: unknown) {
          const setter = set[k];
          if (!setter) {
            log.push(`write ${label}.${k}`);
            return;
          }
          setter(v);
        },
      });
    }
    // Any other data assignment (column widths, ...) is logged as an unexpected write; the fake's own methods and
    // sub-objects are attached with plain assignment.
    return new Proxy(o, {
      set(t, prop, v) {
        if (Object.getOwnPropertyDescriptor(t, prop)?.set || typeof v === "function" || (typeof v === "object" && v !== null && !Array.isArray(v))) return Reflect.set(t, prop, v);
        log.push(`write ${label}.${String(prop)}`);
        return true;
      },
    });
  }

  function cellsOf(addr: string) {
    const p = parseRange(addr);
    const out: [number, number][][] = [];
    for (let r = p.r1; r <= p.r2; r++) {
      const row: [number, number][] = [];
      for (let c = p.c1; c <= p.c2; c++) row.push([r, c]);
      out.push(row);
    }
    return out;
  }

  /** Excel's interpretation of a value written into a cell with format `fmt`. */
  function interpret(v: unknown, fmt: string, viaFormulas: boolean): FakeScalar | FakeFormulaCell | null {
    const text = fmt === "@";
    if (typeof v === "number") return text ? String(v) : v;
    if (typeof v === "boolean") return text ? (v ? "TRUE" : "FALSE") : v;
    if (typeof v !== "string") throw officeError("InvalidArgument", "bad value");
    if (v === "") return null;
    if (text) return v;
    if (v.startsWith("=")) return { f: v };
    if (!viaFormulas && NUMBER.test(v.trim())) return Number(v);
    if (v === "TRUE" || v === "FALSE") return v === "TRUE";
    return v;
  }

  function grid(v: unknown, rows: number, cols: number): unknown[][] {
    if (!Array.isArray(v) || v.length !== rows || v.some((r) => !Array.isArray(r) || r.length !== cols)) {
      throw officeError("InvalidArgument", "The number of rows or columns in the input array doesn't match the size or dimensions of the range.");
    }
    return v as unknown[][];
  }

  function rangeApi(s: Sheet, addr: string): Record<string, unknown> {
    const p = parseRange(addr);
    const label = `${s.name}!${p.a1()}`;
    log.push(`range ${label}`);
    const cells = cellsOf(addr);
    const at = (r: number, c: number) => s.cells.get(key(r, c));
    const writer = (prop: "values" | "formulas" | "numberFormat") => (v: unknown) => {
      log.push(`set ${prop} ${label}`);
      queued.push(() => {
        const g = grid(v, p.rows, p.cols);
        if (s.protected) throw officeError("AccessDenied", "The cell or chart you're trying to change is protected.");
        cells.forEach((row, i) => row.forEach(([r, c], j) => {
          const val = g[i]![j];
          if (prop === "numberFormat") {
            if (val !== null) s.formats.set(key(r, c), String(val));
            return;
          }
          if (val === null) return; // Office ignores null entries when setting values/formulas
          const stored = interpret(val, s.formats.get(key(r, c)) ?? "General", prop === "formulas");
          if (stored === null) s.cells.delete(key(r, c));
          else s.cells.set(key(r, c), stored);
        }));
      });
    };
    const range = loadable(
      label,
      {
        values: () => cells.map((row) => row.map(([r, c]) => { const v = at(r, c); return v === undefined ? "" : isFormulaCell(v) ? 0 : v; })),
        formulas: () => cells.map((row) => row.map(([r, c]) => { const v = at(r, c); return v === undefined ? "" : isFormulaCell(v) ? v.f : v; })),
        numberFormat: () => cells.map((row) => row.map(([r, c]) => s.formats.get(key(r, c)) ?? "General")),
      },
      { values: writer("values"), formulas: writer("formulas"), numberFormat: writer("numberFormat") },
    );
    for (const m of ["clear", "delete", "insert", "merge", "copyFrom", "autofitColumns", "autofitRows"]) {
      (range as Record<string, unknown>)[m] = () => { log.push(`call ${label}.${m}`); };
    }
    (range as Record<string, unknown>).select = () => { log.push(`select ${label}`); };
    (range as Record<string, unknown>).getMergedAreasOrNullObject = () => {
      log.push(`merged ${label}`);
      const hit = s.merged.some((m) => {
        const q = parseRange(m);
        return q.r1 <= p.r2 && q.r2 >= p.r1 && q.c1 <= p.c2 && q.c2 >= p.c1;
      });
      return loadable(`merged ${label}`, { isNullObject: () => !hit });
    };
    return range;
  }

  function sheetApi(s: Sheet | undefined, requested: string): Record<string, unknown> {
    const label = s?.name ?? requested;
    const nullish = () => { throw officeError("InvalidObjectPath", "null object"); };
    const ws = loadable(`sheet ${label}`, {
      isNullObject: () => s === undefined,
      id: () => (s ? s.id : nullish()),
      name: () => (s ? s.name : nullish()),
      visibility: () => (s ? s.visibility : nullish()),
    });
    const w = ws as Record<string, unknown>;
    w.getRange = (addr: string) => {
      if (!s) throw new Error("fake: getRange on a null sheet");
      return rangeApi(s, addr);
    };
    w.protection = Object.assign(loadable(`sheet ${label} protection`, { protected: () => (s ? s.protected : nullish()) }), {
      protect() { log.push(`protect ${label}`); },
      unprotect() { log.push(`unprotect ${label}`); },
    });
    w.names = {
      add(name: string) {
        log.push(`name add ${label} ${name}`);
        const entry = { hidden: false, formula: `='${label}'!$A$1` };
        queued.push(() => s?.names.set(name, entry));
        return loadable(`name ${name}`, { visible: () => !entry.hidden }, { visible: (v) => { log.push(`name hide ${name}`); entry.hidden = v === false; } });
      },
      getItemOrNullObject(name: string) {
        return loadable(`name ${name}`, { isNullObject: () => !s?.names.has(name) });
      },
    };
    w.activate = () => { log.push(`activate ${label}`); };
    w.delete = () => { log.push(`delete ${label}`); };
    return ws;
  }

  let failNextLoad: unknown = null;
  /** A collection with Office's `load("items/...")` strictness: items throw until load() and sync(). */
  function collection<T>(label: string, props: string, items: () => T[], fails = false): { load(p: string): void; readonly items: T[] } {
    let loaded = false;
    return {
      load(p: string) {
        if (p !== props) throw new Error(`fake: ${label} supports load('${props}') only`);
        log.push(`load ${label} ${p}`);
        if (fails) failNextLoad = officeError("ApiNotFound", `${SENTINEL_FAKE} ${label}`);
        queued.push(() => { loaded = true; });
      },
      get items() {
        if (!loaded) throw Object.assign(new Error(`PropertyNotLoaded: ${label} items`), { code: "PropertyNotLoaded" });
        return items();
      },
    };
  }
  const nameItems = (m: Map<string, { formula: string }> | Record<string, string>) =>
    (m instanceof Map ? [...m.entries()].map(([name, v]) => ({ name, formula: v.formula })) : Object.entries(m).map(([name, formula]) => ({ name, formula })));

  const ctx = {
    workbook: {
      get names() {
        return collection("workbook names", "items/name,items/formula", () => nameItems(opts.names ?? {}), opts.namesFail);
      },
      get tables() {
        return collection("tables", "items/name,items/worksheet/name", () => (opts.tables ?? []).map((t) => ({ name: t.name, worksheet: { name: t.sheet } })), opts.tablesFail);
      },
      // A fresh collection proxy per access, as each Office request context hands out its own.
      get worksheets() {
        const list = collection("worksheets", "items/name,items/visibility,items/position", () => {
          const all = sheets.map((sh, position) => ({
            name: sh.name,
            visibility: sh.visibility,
            position,
            names: collection(`sheet ${sh.name} names`, "items/name,items/formula", () => nameItems(sh.names), opts.namesFail),
          }));
          return opts.rotateItems ? [...all.slice(1), ...all.slice(0, 1)] : all;
        });
        return {
        load: (p: string) => list.load(p),
        get items() { return list.items; },
        getItemOrNullObject(name: string) {
          log.push(`sheet ${name}`);
          return sheetApi(find(name), name);
        },
        add(name: string) {
          log.push(`add ${name}`);
          if (find(name)) {
            failAt = { n: syncs + 1, error: officeError("ItemAlreadyExists", `sheet ${name} exists`) };
            return sheetApi(undefined, name);
          }
          return sheetApi(addSheet({ name }), name);
        },
        };
      },
    },
    async sync() {
      syncs += 1;
      log.push("sync");
      if (failNextLoad) {
        const e = failNextLoad;
        failNextLoad = null;
        queued.length = 0;
        throw e;
      }
      if (stallAt && stallAt.n === syncs) {
        const wait = stallAt.promise;
        stallAt = null;
        await wait;
      }
      if (failAt && failAt.n === syncs) {
        const e = failAt.error;
        failAt = null;
        queued.length = 0;
        throw e;
      }
      try {
        for (const f of queued.splice(0)) f();
      } catch (e) {
        queued.length = 0;
        throw e;
      }
      afterSync?.(syncs);
    },
  };

  const cellAt = (sheet: string, addr: string): FakeScalar | FakeFormulaCell | undefined => {
    const s = find(sheet);
    const p = parseRange(addr);
    return s?.cells.get(key(p.r1, p.c1));
  };

  return {
    log,
    runs: () => runs,
    syncs: () => syncs,
    sheetNames: () => sheets.map((s) => s.name),
    hasName: (sheet: string, name: string) => find(sheet)?.names.has(name) ?? false,
    nameHidden: (sheet: string, name: string) => find(sheet)?.names.get(name)?.hidden ?? false,
    cell: cellAt,
    format: (sheet: string, addr: string) => {
      const p = parseRange(addr);
      return find(sheet)?.formats.get(key(p.r1, p.c1)) ?? "General";
    },
    /** Changes a cell outside the add-in (as the user would). */
    edit(sheet: string, addr: string, v: FakeScalar | FakeFormulaCell) {
      const p = parseRange(addr);
      find(sheet)!.cells.set(key(p.r1, p.c1), v);
    },
    /** The `n`th sync from now fails with `error`; nothing queued for it is applied. */
    failSync(n: number, error: unknown) { failAt = { n: syncs + n, error }; },
    onSync(f: ((n: number) => void) | null) { afterSync = f; },
    /** The `n`th sync from now does not finish until the returned release() is called (Excel is slow). */
    stallSync(n: number): () => void {
      let release!: () => void;
      stallAt = { n: syncs + n, promise: new Promise<void>((r) => { release = r; }) };
      return () => release();
    },
    /** Hides or shows a sheet (as the user would). */
    setVisibility(name: string, v: "Visible" | "Hidden" | "VeryHidden") { find(name)!.visibility = v; },
    /** Renames a sheet (as the user would); its id stays. */
    rename(from: string, to: string) { find(from)!.name = to; },
    /** Adds a sheet outside the add-in. */
    addSheet(s: FakeWriteSheet) { addSheet(s); },
    sheetId: (name: string) => find(name)?.id,
    /** Excel.run is deferred (the user is editing a cell) until the returned release() is called. */
    hold(): () => void {
      let release!: () => void;
      hold = new Promise<void>((r) => { release = r; });
      return () => { hold = null; release(); };
    },
    run: <T,>(cb: (c: never) => Promise<T>): Promise<T> => {
      runs += 1;
      return hold ? hold.then(() => cb(ctx as never)) : cb(ctx as never);
    },
  };
}

// Strict fake Excel context: a loaded property throws until load() and sync() have both run,
// like the real API (PropertyNotLoaded). Casts are confined to this fake.
export interface FakeSheetSpec {
  /** 1-based cell grid anchored at A1, like the server's grid. */
  grid: string[][];
  /** Used-range origin (0-based), to prove the origin is not added. */
  origin?: { row: number; col: number };
}

export interface FakeSelection {
  sheet: string;
  columnIndex: number;
  columnCount: number;
  rowIndex?: number;
  rowCount?: number;
}

const colNum = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

function parse(addr: string) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(addr);
  if (!m) throw new Error(`bad address ${addr}`);
  return { c1: colNum(m[1]!), r1: Number(m[2]), c2: colNum(m[3] ?? m[1]!), r2: Number(m[4] ?? m[2]) };
}

export function createFakeExcel(sheets: Record<string, FakeSheetSpec>, selection?: FakeSelection) {
  const log: string[] = [];
  const queued: (() => void)[] = [];
  const requested = new Set<string>();
  let selected = selection ? { ...selection } : undefined;

  function loadable(read: Record<string, () => unknown>): Record<string, unknown> {
    const loaded = new Set<string>();
    const o: Record<string, unknown> = {
      load(names: string) {
        const list = names.split(",").map((n) => n.trim());
        queued.push(() => list.forEach((n) => loaded.add(n)));
      },
    };
    for (const [key, get] of Object.entries(read)) {
      Object.defineProperty(o, key, {
        get() {
          if (!loaded.has(key)) throw Object.assign(new Error(`PropertyNotLoaded: ${key}`), { code: "PropertyNotLoaded" });
          return get();
        },
      });
    }
    return o;
  }

  const ctx = {
    workbook: {
      worksheets: {
        getItem(name: string) {
          requested.add(name);
          const spec = sheets[name];
          const g = spec?.grid ?? [];
          const o = spec?.origin ?? { row: 0, col: 0 };
          const width = Math.max(0, ...g.map((r) => r.length));
          return {
            activate() { log.push(`activate ${name}`); },
            getUsedRange: () =>
              loadable({ rowIndex: () => o.row, columnIndex: () => o.col, rowCount: () => g.length - o.row, columnCount: () => width - o.col }),
            getRange(addr: string) {
              const range = loadable({
                values: () => {
                  const p = parse(addr);
                  const rows: string[][] = [];
                  for (let r = p.r1; r <= p.r2; r++) {
                    const row: string[] = [];
                    for (let c = p.c1; c <= p.c2; c++) row.push(g[r - 1]?.[c - 1] ?? "");
                    rows.push(row);
                  }
                  return rows;
                },
              });
              range.select = () => {
                log.push(`select ${name}!${addr}`);
                const p = parse(addr);
                selected = { sheet: name, columnIndex: p.c1 - 1, columnCount: p.c2 - p.c1 + 1, rowIndex: p.r1 - 1, rowCount: p.r2 - p.r1 + 1 };
              };
              return range;
            },
          };
        },
      },
      getSelectedRange() {
        const s = selected!;
        const range = loadable({ rowIndex: () => s.rowIndex ?? 0, columnIndex: () => s.columnIndex, rowCount: () => s.rowCount ?? 1, columnCount: () => s.columnCount });
        range.worksheet = loadable({ name: () => s.sheet });
        return range;
      },
    },
    // Like Office, a missing sheet only fails at sync time.
    async sync() {
      const missing = [...requested].find((n) => !(n in sheets));
      if (missing) throw Object.assign(new Error(`The requested resource doesn't exist: ${missing}`), { code: "ItemNotFound" });
      queued.splice(0).forEach((f) => f());
    },
  };
  /** The user clicks somewhere in Excel. */
  const userSelect = (next: FakeSelection) => { selected = { ...next }; };
  return { ctx, log, userSelect, run: <T,>(cb: (c: never) => Promise<T>): Promise<T> => cb(ctx as never) };
}

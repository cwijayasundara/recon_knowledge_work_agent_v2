// Strict fake workbook for the Review sheet: reads throw until load()+sync(), writes apply at sync(),
// and writes to locked cells on a protected sheet fail at sync() like Excel. Casts are confined here.
const colNum = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

export function parse(addr: string) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(addr);
  if (!m) throw new Error(`bad address ${addr}`);
  return { c1: colNum(m[1]!), r1: Number(m[2]), c2: colNum(m[3] ?? m[1]!), r2: Number(m[4] ?? m[2]) };
}

interface Sheet {
  id: string;
  name: string;
  values: Map<string, string>;
  formats: Map<string, string>;
  unlocked: Set<string>;
  protected: boolean;
  frozen: number;
  /** Worksheet-scoped defined names; they go away with the sheet. */
  names: Set<string>;
}
type Handler = (args: { address: string; worksheetId: string }) => unknown;

export function createFakeReview(opts: { emitOnWrite?: boolean } = {}) {
  const emitOnWrite = opts.emitOnWrite ?? true;
  const sheets = new Map<string, Sheet>();
  const handlers = new Set<Handler>();
  const log: string[] = [];
  const hooks: { afterSync?: () => void } = {};
  let runs = 0;
  let failingWrites: string | null = null;
  let failingDeletes = false;
  const queued: (() => void)[] = [];
  const pendingEvents: { address: string; worksheetId: string }[] = [];
  let nextId = 1;

  const key = (r: number, c: number) => `${r},${c}`;
  const cells = (addr: string) => {
    const p = parse(addr);
    const out: [number, number][] = [];
    for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) out.push([r, c]);
    return { p, out };
  };

  function loadable(read: Record<string, () => unknown>): Record<string, unknown> {
    const loaded = new Set<string>();
    const o: Record<string, unknown> = {
      load(names: string) {
        const list = names.split(",").map((n) => n.trim());
        queued.push(() => list.forEach((n) => loaded.add(n)));
      },
    };
    for (const [k, get] of Object.entries(read)) {
      Object.defineProperty(o, k, {
        configurable: true,
        get() {
          if (!loaded.has(k)) throw Object.assign(new Error(`PropertyNotLoaded: ${k}`), { code: "PropertyNotLoaded" });
          return get();
        },
      });
    }
    return o;
  }

  // Excel interprets values written into a non-text cell: numbers lose their text, "=..." becomes a formula.
  function coerce(s: Sheet, r: number, c: number, v: string): string {
    if ((s.formats.get(key(r, c)) ?? "General") === "@") return v;
    if (v.startsWith("=")) return `#FORMULA:${v}`;
    return v.trim() !== "" && !Number.isNaN(Number(v)) ? String(Number(v)) : v;
  }

  function sheetApi(s: Sheet) {
    const ws = loadable({ name: () => s.name, id: () => s.id, isNullObject: () => false });
    ws.protection = Object.assign(loadable({ protected: () => s.protected }), {
      protect(o: unknown) { log.push(`protect ${JSON.stringify(o)}`); queued.push(() => { s.protected = true; }); },
      unprotect() { log.push("unprotect"); queued.push(() => { s.protected = false; }); },
    });
    ws.freezePanes = { freezeRows(n: number) { log.push(`freeze ${n}`); queued.push(() => { s.frozen = n; }); } };
    ws.delete = () => { log.push(`delete ${s.name}`); queued.push(() => { if (failingDeletes) throw new Error("delete failed"); sheets.delete(s.id); }); };
    ws.names = {
      add(name: string) {
        log.push(`name ${name}`);
        queued.push(() => { s.names.add(name); });
        return { set visible(v: boolean) { log.push(`name ${name} visible=${v}`); } };
      },
      getItemOrNullObject(name: string) { return loadable({ isNullObject: () => !s.names.has(name) }); },
    };
    ws.getRange = (addr?: string) => {
      const range = loadable({
        values: () => {
          const p = parse(addr!);
          const rows: string[][] = [];
          for (let r = p.r1; r <= p.r2; r++) {
            const row: string[] = [];
            for (let c = p.c1; c <= p.c2; c++) row.push(s.values.get(key(r, c)) ?? "");
            rows.push(row);
          }
          return rows;
        },
      });
      Object.defineProperty(range, "values", {
        configurable: true,
        get: Object.getOwnPropertyDescriptor(range, "values")!.get,
        set(v: unknown[][]) {
          log.push(`values ${addr}`);
          queued.push(() => {
            const { p, out } = cells(addr!);
            if (failingWrites === s.name) throw new Error("write failed");
            if (v.length !== p.r2 - p.r1 + 1 || v[0]!.length !== p.c2 - p.c1 + 1) throw new Error(`shape mismatch for ${addr}`);
            for (const [r, c] of out) {
              if (s.protected && !s.unlocked.has(key(r, c))) throw new Error(`The cell or chart you're trying to change is on a protected sheet: ${addr}`);
              s.values.set(key(r, c), coerce(s, r, c, String(v[r - p.r1]![c - p.c1])));
            }
            pendingEvents.push({ address: addr!, worksheetId: s.id });
          });
        },
      });
      Object.defineProperty(range, "numberFormat", {
        set(v: unknown[][]) {
          log.push(`format ${addr}`);
          queued.push(() => {
            const { p, out } = cells(addr!);
            if (s.protected) throw new Error(`The cell or chart you're trying to change is on a protected sheet: ${addr}`);
            for (const [r, c] of out) s.formats.set(key(r, c), String(v[r - p.r1]![c - p.c1]));
          });
        },
      });
      range.format = {
        protection: {
          set locked(v: boolean) {
            queued.push(() => { for (const [r, c] of cells(addr!).out) { if (v) s.unlocked.delete(key(r, c)); else s.unlocked.add(key(r, c)); } });
          },
        },
        font: { set bold(_v: boolean) { /* cosmetic */ } },
      };
      range.clear = () => {
        log.push("clear");
        queued.push(() => { s.values.clear(); s.formats.clear(); s.unlocked.clear(); });
      };
      return range;
    };
    return ws;
  }

  const byName = (n: string) => [...sheets.values()].find((s) => s.name === n || s.id === n);

  const ctx = {
    workbook: {
      worksheets: {
        add(name: string) {
          log.push(`add ${name}`);
          const s: Sheet = { id: `id${nextId++}`, name, values: new Map(), formats: new Map(), unlocked: new Set(), protected: false, frozen: 0, names: new Set() };
          queued.push(() => { sheets.set(s.id, s); });
          return sheetApi(s);
        },
        getItem(n: string) {
          const s = byName(n);
          if (!s) throw Object.assign(new Error("ItemNotFound"), { code: "ItemNotFound" });
          return sheetApi(s);
        },
        getItemOrNullObject(n: string) {
          const s = byName(n);
          if (s) return sheetApi(s);
          return loadable({ isNullObject: () => true, name: () => { throw new Error("null object"); } });
        },
        onChanged: {
          add(h: Handler) {
            handlers.add(h);
            log.push("onChanged.add");
            const result = { context: ctx, remove() { handlers.delete(h); log.push("onChanged.remove"); } };
            return result;
          },
        },
      },
    },
    async sync() {
      queued.splice(0).forEach((f) => f());
      if (emitOnWrite && pendingEvents.length) {
        const events = pendingEvents.splice(0);
        // Excel reports a change to its own writes asynchronously, after the run.
        setTimeout(() => events.forEach((e) => [...handlers].forEach((h) => void h(e))), 0);
      } else pendingEvents.length = 0;
      hooks.afterSync?.();
    },
  };

  const read = (name: string, addr: string): string[][] => {
    const s = byName(name)!;
    const p = parse(addr);
    const rows: string[][] = [];
    for (let r = p.r1; r <= p.r2; r++) {
      const row: string[] = [];
      for (let c = p.c1; c <= p.c2; c++) row.push(s.values.get(key(r, c)) ?? "");
      rows.push(row);
    }
    return rows;
  };

  return {
    ctx,
    log,
    hooks,
    failWrites: (name: string | null) => { failingWrites = name; },
    runs: () => runs,
    run: <T,>(cb: (c: never) => Promise<T>): Promise<T> => { runs++; return cb(ctx as never); },
    /** A sheet the user made (no ownership marker unless `names` says so); returns it for direct edits. */
    addSheet(name: string, names: string[] = []): Sheet {
      const s: Sheet = { id: `id${nextId++}`, name, values: new Map(), formats: new Map(), unlocked: new Set(), protected: false, frozen: 0, names: new Set(names) };
      sheets.set(s.id, s);
      return s;
    },
    failDeletes: (on: boolean) => { failingDeletes = on; },
    sheetNames: () => [...sheets.values()].map((s) => s.name),
    format: (name: string, r: number, c: number) => byName(name)!.formats.get(key(r, c)) ?? "General",
    sheet: (name: string) => byName(name),
    read,
    handlerCount: () => handlers.size,
    isLocked: (name: string, r: number, c: number) => !byName(name)!.unlocked.has(key(r, c)),
    /** The user types or pastes values; the change event is delivered to every handler. */
    async userEdit(name: string, addr: string, values: string[][], pasteFormat?: string): Promise<void> {
      const s = byName(name)!;
      const p = parse(addr);
      values.forEach((row, i) => row.forEach((v, j) => {
        // Pasting from another cell carries its number format; typed values are interpreted by the cell's format.
        if (pasteFormat) s.formats.set(key(p.r1 + i, p.c1 + j), pasteFormat);
        s.values.set(key(p.r1 + i, p.c1 + j), coerce(s, p.r1 + i, p.c1 + j, v));
      }));
      await Promise.all([...handlers].map((h) => h({ address: addr, worksheetId: s.id })));
    },
    /** Delivers a change event for an address with no preceding edit (a stale or foreign event). */
    async fire(name: string, addr: string): Promise<void> {
      const s = byName(name);
      await Promise.all([...handlers].map((h) => h({ address: addr, worksheetId: s?.id ?? "gone" })));
    },
    deleteSheet(name: string) { sheets.delete(byName(name)!.id); },
    /** Lets asynchronous change events from the add-in's own writes arrive. */
    flush: () => new Promise<void>((r) => setTimeout(r, 15)),
  };
}

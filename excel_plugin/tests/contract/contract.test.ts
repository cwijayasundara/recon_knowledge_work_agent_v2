// Contract tests: the real add-in client/store/SSE against the offline scripted API.
// Run: `pnpm test:contract` (globalSetup starts `uv run python -m tests.e2e.serve_scripted` from the repo root).
// Needs `uv` and, because of the hidden-.pth workaround on macOS Python 3.12, the string matcher sources at
// STRING_MATCHER_PATH (default ../../advance_research/string_matcher_v1 relative to the repo root).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, test } from "vitest";
import { ApiError, createClient, type Client } from "../../src/api/client";
import { streamEvents } from "../../src/api/sse";
import { devAuth } from "../../src/auth/dev";
import { createRunStore, type RunState, type RunStore } from "../../src/state/store";
import { markApply, verdictFrom, type ItemIdEdit, type Verdict } from "../../src/state/verdict";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/affiliate");
const HEADER = "ITEM_ID,NAME,ITEM_TYPE,DESCRIPTION,DONOTIMPORT";

let client: Client;
const stores: RunStore[] = [];
const T0 = Date.now();
/** Per store: every SSE message it received (id, event, ms since the suite started), for failure diagnostics. */
const sseLogs = new WeakMap<RunStore, string[]>();
/** Per store: idleSeq before the last gate post the test made directly with client.gate (not through the store). */
const directPosts = new WeakMap<RunStore, number>();
beforeAll(() => {
  const baseUrl = process.env.CONTRACT_API_URL;
  if (!baseUrl) throw new Error("CONTRACT_API_URL not set: run through `pnpm test:contract` (globalSetup starts the API)");
  client = createClient({ baseUrl, auth: devAuth("contract-test") });
});
afterEach(() => { stores.splice(0).forEach((s) => s.stop()); });

async function start(fixture: string, sponsor: string, opts: Parameters<typeof createRunStore>[1] = {}) {
  const bytes = readFileSync(path.join(FIXTURES, fixture));
  const { run_id } = await client.startRun(sponsor, new Blob([bytes]), fixture);
  const log: string[] = [];
  const inner = opts.streamer ?? streamEvents;
  // Records every message the store receives, then hands it on unchanged.
  const streamer: typeof streamEvents = (o) => inner({
    ...o,
    onMessage: (m) => { log.push(`${m.id ?? "-"} ${m.event} +${Date.now() - T0}ms`); o.onMessage(m); },
  });
  const store = createRunStore(client, { ...opts, streamer });
  sseLogs.set(store, log);
  stores.push(store);
  store.start(run_id);
  return { runId: run_id, store };
}

/** The store state that matters when a wait fails: idle counters, the last decisions, the gate message, the SSE log. */
function diagnostics(store: RunStore): string {
  const s = store.get();
  const last3 = (s.snap?.decisions ?? []).slice(-3).map((d) => `${d.seq}:${d.kind}`);
  const seen3 = s.decisionLog.slice(-3).map((d) => `${d.seq}:${d.kind}@idle${d.idleSeq}`);
  return [
    `idleSeq=${s.idleSeq} snapIdleSeq=${s.snapIdleSeq} postIdleSeq=${s.postIdleSeq} directPostIdleSeq=${directPosts.get(store) ?? "-"} busy=${s.busy} connection=${s.connection}`,
    `error: ${s.error}`,
    `notice: ${s.notice}`,
    `snapshot: ${JSON.stringify(s.snap && { status: s.snap.status, phase: s.snap.phase, working: s.snap.working, gate: s.snap.pending?.gate ?? null, job_error: s.snap.job_error })}`,
    `pending.message: ${JSON.stringify(s.snap?.pending?.message ?? null)}`,
    `last 3 decisions (snapshot): ${JSON.stringify(last3)}`,
    `last 3 decisions (stream): ${JSON.stringify(seen3)}`,
    `activity: ${JSON.stringify(s.activity)}`,
    `sse (id event +ms): ${JSON.stringify(sseLogs.get(store) ?? [])}`,
  ].join("\n");
}

// Kept above the store's 30 s settle bound, so a wait never ends before the store would re-enable on its own.
async function until(store: RunStore, label: string, pred: (s: RunState) => boolean, ms = 45_000): Promise<RunState> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = store.get();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${label}\n${diagnostics(store)}`);
}
function failure(store: RunStore, what: string): string {
  return `${what}\n${diagnostics(store)}`;
}
/**
 * The snapshot was read by a refresh that started after an idle that followed the last gate post (the store's own, or
 * one made directly with client.gate): it shows that post's outcome, not a mix of before and after.
 */
const fresh = (store: RunStore) => (s: RunState) => s.snapIdleSeq > Math.max(s.postIdleSeq, directPosts.get(store) ?? 0);
const atGate = (store: RunStore, gate: string) => (s: RunState) =>
  s.snap?.pending?.gate === gate && !s.snap.working && !s.busy && fresh(store)(s);

async function approve(store: RunStore, gate: string, next: (s: RunState) => boolean, label: string) {
  await until(store, `${gate} gate`, atGate(store, gate));
  expect(await store.respond({ action: "approve" }), failure(store, `approve at ${gate}`)).toBe(true);
  return until(store, label, next);
}

test("1 renamed.xlsx / sponsor-a: brief -> findings -> signoff -> locked, CSV downloads", async () => {
  const { runId, store } = await start("renamed.xlsx", "sponsor-a");
  await approve(store, "brief", atGate(store, "findings"), "findings gate");
  const signoff = await approve(store, "findings", atGate(store, "signoff"), "signoff gate");
  const names = (signoff.snap?.pending?.artifacts ?? []).map((a) => a.name);
  expect(names).toContain("Affiliates.csv");
  expect(names).toContain("review.xlsx");
  expect(names).not.toContain("manifest.json"); // appears only after the final approve locks the run
  const locked = await approve(store, "signoff", (s) => s.snap?.status === "locked" && !s.snap.working && !s.busy && fresh(store)(s), "locked");
  expect(locked.snap?.pending).toBeNull();
  const all = locked.snap?.artifacts.map((a) => a.name) ?? [];
  expect(all).toEqual(expect.arrayContaining(["Affiliates.csv", "manifest.json"]));
  const csv = await (await client.artifact(runId, "Affiliates.csv")).text();
  expect(csv.split(/\r?\n/)[0]).toBe(HEADER);
  expect(locked.grid.length).toBeGreaterThan(0);
});

test("2 titled.xlsx / sponsor-b: source grid is A1-anchored (row N = Excel row N)", async () => {
  const { runId, store } = await start("titled.xlsx", "sponsor-b");
  const s = await until(store, "brief gate", atGate(store, "brief"));
  expect(s.snap?.brief?.source.header_row).toBe(4);
  const source = await client.source(runId);
  expect(source.sheet).toBe("Affiliates");
  expect(source.header_row).toBe(4);
  const rows = source.rows;
  expect(rows.map((r) => r.row).slice(0, 5)).toEqual([1, 2, 3, 4, 5]); // 1-based, leading title rows kept
  const at = (n: number) => rows[n - 1]!.cells;
  expect(at(1)[0]).toBe("Affiliate Register");
  expect(at(2)[0]).toContain("Prepared for sponsor-a");
  expect(at(3).every((c) => c === "")).toBe(true);
  const header = rows[source.header_row! - 1]!.cells;
  expect(header.slice(0, 2)).toEqual(["Affiliate ID", "Affiliate Name"]); // column i is Excel column i
  expect(at(5)[0]).toBe("AFF_9001");
  expect(at(5)[1]).toBe("Meridian Capital GP IV, LLC");
});

test("3 a gate posted while working, or not at a gate, is a 409 and the store stays consistent", async () => {
  const { runId, store } = await start("clean.csv", "sponsor-a");
  // Posted in the same tick as start(), with no await in between: the scope job was submitted before the upload
  // returned, so this is a 409 unless the job already finished in one round trip. Either outcome is checked.
  const early = await store.respond({ action: "approve" });
  if (!early) {
    const err = store.get().error;
    expect(err, failure(store, "early respond error")).toMatch(/^(the run is already working|the run is not waiting at a gate) \(ref [0-9a-f-]+\)$/);
    expect(store.get().busy).toBe(false);
    await new Promise((r) => setTimeout(r, 400)); // let the debounced refresh run: the action error must persist
    expect(store.get().error).toBe(err);
  } else {
    // Accepted (202): the run was already at a gate, so (a fresh run having approved nothing) an approve decision must
    // be recorded once the run settles.
    const s = await until(store, "early approve recorded", (st) => !st.busy && !st.snap?.working && fresh(store)(st) && (st.snap?.decisions.some((d) => d.kind.endsWith(".approve")) ?? false));
    expect(s.snap?.decisions.filter((d) => d.kind.endsWith(".approve")), failure(store, "early approve")).toHaveLength(1);
  }
  // clean.csv for a known sponsor may skip the brief, so the run can be at any gate here.
  const settledAtGate = (s: RunState) => !s.busy && !s.snap?.working && fresh(store)(s) && ["brief", "findings", "signoff"].includes(s.snap?.pending?.gate ?? "");
  const before = await until(store, "a gate", settledAtGate);
  const gate = before.snap!.pending!.gate;

  // Two concurrent posts at a pending gate: the per-run job lock lets exactly one through.
  directPosts.set(store, store.get().idleSeq);
  const [x, y] = await Promise.allSettled([client.gate(runId, { action: "approve" }), client.gate(runId, { action: "approve" })]);
  const results = [x, y];
  expect(results.filter((r) => r.status === "fulfilled"), `concurrent posts at ${gate}`).toHaveLength(1);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
  expect(rejected.reason).toBeInstanceOf(ApiError);
  expect((rejected.reason as ApiError).status).toBe(409);
  expect((rejected.reason as ApiError).message).toMatch(/already working|not waiting at a gate/);
  await store.refresh();
  // The winning approve was recorded exactly once.
  const afterPosts = await until(store, `approve at ${gate} recorded`, (s) => !s.busy && !s.snap?.working && fresh(store)(s) && (s.snap?.decisions.filter((d) => d.kind === `${gate}.approve`).length ?? 0) > before.snap!.decisions.filter((d) => d.kind === `${gate}.approve`).length);
  expect(afterPosts.snap!.decisions.filter((d) => d.kind === `${gate}.approve`).length).toBe(before.snap!.decisions.filter((d) => d.kind === `${gate}.approve`).length + 1);

  // Walk the remaining gates to the lock (none left when the race happened at sign-off).
  const locked = (s: RunState) => s.snap?.status === "locked" && !s.snap.working && !s.busy && fresh(store)(s);
  for (let i = 0; i < 3 && !locked(store.get()); i++) {
    const s = await until(store, "next gate or locked", (st) => locked(st) || settledAtGate(st));
    if (locked(s)) break;
    expect(await store.respond({ action: "approve" }), failure(store, `approve ${s.snap?.pending?.gate}`)).toBe(true);
    await until(store, "gate passed", (st) => !st.busy && (locked(st) || (settledAtGate(st) && st.snap?.pending?.gate !== s.snap?.pending?.gate)));
  }
  await until(store, "locked", locked);
  // Locked: there is no gate any more.
  expect(await store.respond({ action: "approve" })).toBe(false);
  const lockedError = store.get().error;
  expect(lockedError, failure(store, "post-lock")).toMatch(/^the run is not waiting at a gate \(ref /);
  await new Promise((r) => setTimeout(r, 400)); // the debounced refresh must not erase the action error
  expect(store.get().error).toBe(lockedError);
  expect(store.get().snap?.status).toBe("locked");
  const after = await client.run(runId);
  expect(after.status).toBe("locked");
  expect(after.pending).toBeNull();
});

test("4 SSE aborted mid-run: the store reconnects with Last-Event-ID and reaches the final state", async () => {
  const seenLast: (string | null)[] = [];
  let firstId: string | null = null;
  let firstCut!: () => void;
  const cutDone = new Promise<void>((r) => { firstCut = r; });
  const streamer: typeof streamEvents = (o) => {
    let cutFirst: (() => void) | null = null;
    return streamEvents({
      ...o,
      backoffMs: [100],
      open: async (last, signal) => {
        seenLast.push(last);
        if (seenLast.length > 1) return o.open(last, signal);
        // First connection only: abort the response after its first message that carries an id.
        const cut = new AbortController();
        signal.addEventListener("abort", () => cut.abort());
        cutFirst = () => { cutFirst = null; cut.abort(); firstCut(); };
        return o.open(last, cut.signal);
      },
      onMessage: (m) => {
        o.onMessage(m);
        if (m.id && seenLast.length === 1) firstId = m.id; // last id delivered on the first connection
        if (m.id && cutFirst) cutFirst();
      },
    });
  };
  const { store } = await start("clean.csv", "sponsor-c", { streamer });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cutDone,
      new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error(`no SSE message with an id arrived within 10 s on the first connection\n${failure(store, "case 4")}`)), 10_000); }),
    ]);
  } finally { clearTimeout(guard); }
  await until(store, "reconnect", () => seenLast.length >= 2);
  await approve(store, "brief", atGate(store, "findings"), "findings gate");
  await approve(store, "findings", atGate(store, "signoff"), "signoff gate");
  const done = await approve(store, "signoff", (s) => s.snap?.status === "locked" && !s.snap.working && !s.busy && fresh(store)(s), "locked");
  expect(done.connection).toBe("connected");
  expect(seenLast[0]).toBeNull();
  expect(firstId).not.toBeNull();
  expect(seenLast[1], failure(store, "second open")).toBe(firstId); // resumed with the last id the first connection delivered
  expect(done.grid.length).toBeGreaterThan(0);
});

test("5 dry-run returns an Impact and changes nothing; a change gate then updates the run", async () => {
  const { runId, store } = await start("edge.csv", "sponsor-b");
  await approve(store, "brief", atGate(store, "findings"), "findings gate");
  const before = await client.run(runId);
  const gridBefore = await client.grid(runId);

  const impact = await client.dryRun(runId, [{ kind: "override_item_id", row: 2, value: "AFF_9999" }]);
  expect(Array.isArray(impact.violations)).toBe(true);
  expect(typeof impact.requires_rebuild).toBe("boolean");
  expect(Array.isArray(impact.rows_changed)).toBe(true);
  expect(Array.isArray(impact.findings_added)).toBe(true);
  expect(Array.isArray(impact.findings_removed)).toBe(true);
  expect(Array.isArray(impact.preview)).toBe(true);
  expect(typeof impact.publishable_before).toBe("boolean");
  expect(typeof impact.publishable_after).toBe("boolean");

  expect(await client.run(runId)).toEqual(before);
  expect((await client.grid(runId)).rows).toEqual(gridBefore.rows);

  expect(await store.respond({ action: "change", changes: [{ kind: "override_item_id", row: 2, value: "AFF_9999" }] })).toBe(true);
  const s = await until(store, "override applied", (st) => !st.busy && !st.snap?.working && fresh(store)(st) && st.snap?.options.id_overrides["2"] === "AFF_9999");
  const row = s.grid.find((r) => r.ITEM_ID === "AFF_9999");
  expect(row?.id_method).toBe("override");
  expect(s.snap?.pending?.gate).toBe("findings");
});

test("6 POST /gate is 202 before validation: a refused override is reported as refused with the server's message, a valid one as applied", async () => {
  const { runId, store } = await start("edge.csv", "sponsor-b");
  // A sponsor with mapping history may skip the brief.
  const first = await until(store, "brief or findings gate", (s) => atGate(store, "brief")(s) || atGate(store, "findings")(s));
  if (first.snap?.pending?.gate === "brief") expect(await store.respond({ action: "approve" }), failure(store, "approve brief")).toBe(true);
  await until(store, "findings gate", atGate(store, "findings"));

  // Exactly what ReviewPanel.apply does: note the last decision and idle count, post, then read the verdict from a
  // snapshot fetched after the job's idle event.
  async function apply(edit: ItemIdEdit): Promise<Verdict> {
    const mark = markApply(store.get());
    expect(await store.respond({ action: "change", changes: [{ kind: "override_item_id", ...edit }] }), failure(store, "gate post")).toBe(true);
    const s = await until(store, `verdict for ${edit.value}`, (st) => verdictFrom(st, edit, mark).kind !== "pending");
    expect(s.snapIdleSeq, failure(store, "verdict snapshot")).toBeGreaterThan(mark.idleSeq);
    // Read after an idle that followed this Apply's own decision event.
    const ours = s.decisionLog.filter((d) => d.seq > mark.sinceSeq && d.kind === "findings.change").at(-1);
    expect(ours, failure(store, "decision event")).toBeDefined();
    expect(s.snapIdleSeq, failure(store, "idle after decision")).toBeGreaterThan(ours!.idleSeq);
    expect(s.busy).toBe(false);
    return verdictFrom(s, edit, mark);
  }

  const gridBefore = (await client.grid(runId)).rows;
  const refused = await apply({ row: 2, value: "BAD-ID" }); // "-" breaks the ITEM_ID charset rule
  expect(refused.kind, failure(store, "refused verdict")).toBe("refused");
  const message = refused.kind === "refused" ? refused.message : "";
  expect(message).toMatch(/^Changes refused: item_id\.charset: ITEM_ID may contain only A-Z, 0-9 and _/);
  const server = await client.run(runId);
  expect(server.pending?.gate).toBe("findings");
  expect(server.pending?.message).toBe(message); // the server's message, verbatim
  expect(server.decisions.at(-1)?.kind).toBe("findings.change");
  expect(server.options.id_overrides["2"]).toBeUndefined();
  expect((await client.grid(runId)).rows).toEqual(gridBefore); // nothing changed

  const applied = await apply({ row: 2, value: "AFF_8888" });
  expect(applied.kind, failure(store, "applied verdict")).toBe("applied");
  const after = store.get();
  expect(after.snap?.options.id_overrides["2"]).toBe("AFF_8888");
  expect(after.snap?.pending?.message ?? null).toBeNull();
  expect(after.grid.find((r) => r.row === 2)?.ITEM_ID).toBe("AFF_8888");
});

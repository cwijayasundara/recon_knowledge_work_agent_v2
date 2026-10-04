import { ApiError, type Client } from "../api/client";
import { streamEvents, type SseMessage } from "../api/sse";
import type { GateBody, GridRow, Snapshot } from "../api/types";

export interface RunState {
  runId: string | null;
  snap: Snapshot | null;
  grid: GridRow[];
  activity: string[];
  error: string | null;
  busy: boolean;
  connection: "idle" | "connected" | "reconnecting";
  /** Count of `idle` events seen for this run: the server publishes one each time a job (advance, gate) finishes. */
  idleSeq: number;
  /** idleSeq when the refresh that fetched `snap` started: that snapshot was read after every job up to that idle. */
  snapIdleSeq: number;
}
export interface RunStore {
  get(): RunState;
  subscribe(fn: () => void): () => void;
  start(runId: string): void;
  stop(): void;
  refresh(): Promise<void>;
  /** True when the gate POST was accepted; false when it failed (the error is then in state.error). */
  respond(body: GateBody): Promise<boolean>;
}
export interface RunStoreOptions { debounceMs?: number; streamer?: typeof streamEvents }

const REFRESH_ON = new Set(["gate", "idle", "brief", "report", "findings", "decision", "artifact", "error", "change_impact", "phase", "question"]);
const ACTIVITY_CAP = 20;
const EMPTY: RunState = { runId: null, snap: null, grid: [], activity: [], error: null, busy: false, connection: "idle", idleSeq: 0, snapIdleSeq: 0 };

const describe = (e: unknown): string =>
  e instanceof ApiError ? `${e.message} (ref ${e.requestId})` : e instanceof Error ? e.message : String(e);

export function createRunStore(client: Client, opts: RunStoreOptions = {}): RunStore {
  const debounceMs = opts.debounceMs ?? 120;
  const streamer = opts.streamer ?? streamEvents;
  const listeners = new Set<() => void>();
  let state: RunState = EMPTY;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshSeq = 0;
  // Action and stream errors live apart from the snapshot's job_error so a refresh cannot erase them.
  let actionError: string | null = null;
  let refreshError: string | null = null; // transient: reset by the next successful refresh

  const set = (patch: Partial<Omit<RunState, "error">>) => {
    const next = { ...state, ...patch };
    state = { ...next, error: actionError ?? refreshError ?? next.snap?.job_error ?? null };
    listeners.forEach((fn) => fn());
  };
  const active = (c: AbortController | null) => c !== null && c === controller && !c.signal.aborted;

  async function refresh(): Promise<void> {
    const c = controller;
    const runId = state.runId;
    if (!c || !runId) return;
    const seq = ++refreshSeq;
    const current = () => active(c) && seq === refreshSeq;
    // Read before the fetch: the server can assemble a snapshot from state read on both sides of a job's end, so only
    // a refresh started after that job's idle event is known to see its outcome whole.
    const idleAtStart = state.idleSeq;
    try {
      const snap = await client.run(runId);
      if (!current()) return;
      const grid = snap.result ? (await client.grid(runId)).rows : [];
      if (!current()) return;
      if (state.snap && state.snap.pending?.gate !== snap.pending?.gate) actionError = null;
      refreshError = null;
      set({ snap, grid, busy: snap.working, snapIdleSeq: idleAtStart });
    } catch (e) {
      if (current()) { refreshError = describe(e); set({}); }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    const c = controller;
    timer = setTimeout(() => { timer = null; if (active(c)) void refresh(); }, debounceMs);
  }

  function note(line: string) {
    set({ activity: [...state.activity, line].slice(-ACTIVITY_CAP) });
  }

  function onMessage(c: AbortController, m: SseMessage) {
    if (!active(c)) return;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(m.data);
      if (typeof parsed !== "object" || parsed === null) return;
      data = parsed as Record<string, unknown>;
    } catch { return; }
    if (m.event === "agent_message" && data.mode) note(`Agent: ${String(data.mode)} mode`);
    else if (m.event === "decision") {
      const entry = (data.entry ?? data) as { kind?: unknown; actor?: unknown };
      if (typeof entry.actor === "string" && typeof entry.kind === "string") note(`${entry.actor}: ${entry.kind}`);
    } else if (m.event === "error") note(`Error: ${String(data.message)}`);
    if (m.event === "idle") set({ busy: false, idleSeq: state.idleSeq + 1 });
    if (REFRESH_ON.has(m.event)) schedule();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    const c = controller;
    controller = null;
    c?.abort();
    // A stopped run is gone from the pane: nothing of it (cards, grid, errors) may show during the next upload.
    actionError = null;
    refreshError = null;
    if (state !== EMPTY) {
      state = EMPTY;
      listeners.forEach((fn) => fn());
    }
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    start(runId) {
      stop();
      const c = new AbortController();
      controller = c;
      actionError = null;
      refreshError = null;
      state = { ...EMPTY, runId };
      listeners.forEach((fn) => fn());
      let wasReconnecting = false;
      void refresh();
      streamer({
        open: (last, signal) => client.openEvents(runId, last, signal),
        onMessage: (m) => onMessage(c, m),
        onStatus: (s) => {
          if (!active(c)) return;
          set({ connection: s });
          if (s === "connected" && wasReconnecting) schedule();
          wasReconnecting = s === "reconnecting";
        },
        signal: c.signal,
      }).catch((e: unknown) => { if (active(c)) { actionError = describe(e); set({}); } });
    },
    stop,
    refresh,
    async respond(body) {
      const c = controller;
      const runId = state.runId;
      if (!c || !runId) return false;
      refreshSeq++; // an older in-flight refresh must not overwrite the post-click state
      actionError = null;
      set({ busy: true });
      let accepted = true;
      try {
        await client.gate(runId, body);
      } catch (e) {
        accepted = false;
        if (active(c)) { actionError = describe(e); set({ busy: false }); }
      }
      if (active(c)) schedule();
      return accepted;
    },
  };
}

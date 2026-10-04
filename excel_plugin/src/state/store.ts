import { ApiError, RequestTimeout, type Client } from "../api/client";
import { streamEvents, type SseMessage } from "../api/sse";
import type { GateBody, GridRow, Snapshot } from "../api/types";
import { decisionMatches, lastDecisionSeq, type SeenDecision } from "./verdict";

export interface RunState {
  runId: string | null;
  snap: Snapshot | null;
  grid: GridRow[];
  activity: string[];
  error: string | null;
  /**
   * True while the server works, and from a gate post until the store has a snapshot that shows the post's outcome
   * (see respond): gate cards stay disabled meanwhile, so a card for a gate already passed cannot be clicked.
   */
  busy: boolean;
  connection: "idle" | "connected" | "reconnecting";
  /** Count of `idle` events seen for this run: the server publishes one each time a job (advance, gate) finishes. */
  idleSeq: number;
  /** idleSeq when the refresh that fetched `snap` started: that snapshot was read after every job up to that idle. */
  snapIdleSeq: number;
  /** idleSeq when the last gate post was sent (0 before any). */
  postIdleSeq: number;
  /** Decision events seen on the stream (newest last, capped), each with the idleSeq at its arrival. */
  decisionLog: SeenDecision[];
  /** A status line about the last gate post (checking a timed-out post, or a status that may be out of date). */
  notice: string | null;
}
export interface RunStore {
  get(): RunState;
  subscribe(fn: () => void): () => void;
  start(runId: string): void;
  stop(): void;
  refresh(): Promise<void>;
  /**
   * True when the gate POST was accepted (or, after a timeout, the run shows it was received); false when it was not
   * (the error is then in state.error).
   */
  respond(body: GateBody): Promise<boolean>;
}
export interface RunStoreOptions {
  debounceMs?: number;
  streamer?: typeof streamEvents;
  /** Stream silence after which a held gate post is re-checked; GATE_SETTLE_TIMEOUT_MS unless a test shortens it. */
  settleTimeoutMs?: number;
  /** Longest a gate post holds the cards in any case; SETTLE_HARD_CAP_MS unless a test shortens it. */
  settleHardCapMs?: number;
}

/**
 * How long a held gate post waits without any event for the run before it is re-checked. With the stream connected the
 * job is simply still running (a live-model job can take minutes), so the hold continues; with the stream down or
 * reconnecting the cards come back with STALE_NOTICE. Every event for the run restarts the wait.
 */
export const GATE_SETTLE_TIMEOUT_MS = 30_000;
/** Longest a gate post keeps the cards disabled even with the stream connected. */
export const SETTLE_HARD_CAP_MS = 10 * 60_000;
export const WORKING_NOTICE = "Still working…";
export const CHECKING_NOTICE = "The request timed out and may have been received. Checking the run…";
export const STALE_NOTICE = "Status may be out of date — refresh.";
export const NOT_RECEIVED = "Not received — you can retry.";

const REFRESH_ON = new Set(["gate", "idle", "brief", "report", "findings", "decision", "artifact", "error", "change_impact", "phase", "question"]);
const ACTIVITY_CAP = 20;
const DECISION_CAP = 50;
const EMPTY: RunState = {
  runId: null, snap: null, grid: [], activity: [], error: null, busy: false, connection: "idle",
  idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null,
};

const describe = (e: unknown): string =>
  e instanceof ApiError ? `${e.message} (ref ${e.requestId})` : e instanceof Error ? e.message : String(e);

/**
 * A gate post waiting for its outcome. The run records the post as a decision and then publishes `idle`; only a
 * snapshot fetched by a refresh that started after an idle that followed that decision event shows the outcome whole.
 * An idle that arrives before the decision (the previous job's, published after it dropped its busy flag) is ignored.
 */
interface Hold {
  c: AbortController;
  body: GateBody;
  gate: string | null;
  sinceSeq: number;
  idleAtPost: number;
  /** idleSeq when this post's decision arrived (or, for a job that failed first, before its idle); null until then. */
  idleAtDecision: number | null;
  /** A job `error` event arrived before the decision: the job's next idle settles the post. */
  errored: boolean;
  /** When the post was accepted (Date.now()), for the hard cap; null until then. */
  acceptedAt: number | null;
  /** The run showed this post's outcome (its decision, then idle, then a snapshot): the server received it. */
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createRunStore(client: Client, opts: RunStoreOptions = {}): RunStore {
  const debounceMs = opts.debounceMs ?? 120;
  const streamer = opts.streamer ?? streamEvents;
  const settleTimeoutMs = opts.settleTimeoutMs ?? GATE_SETTLE_TIMEOUT_MS;
  const settleHardCapMs = opts.settleHardCapMs ?? SETTLE_HARD_CAP_MS;
  const listeners = new Set<() => void>();
  let state: RunState = EMPTY;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshSeq = 0;
  // Action and stream errors live apart from the snapshot's job_error so a refresh cannot erase them.
  let actionError: string | null = null;
  let refreshError: string | null = null; // transient: reset by the next successful refresh
  let notice: string | null = null;
  let serverBusy = false;
  let hold: Hold | null = null;

  const set = (patch: Partial<Omit<RunState, "error" | "busy" | "notice">> = {}) => {
    const next = { ...state, ...patch };
    state = { ...next, busy: hold !== null || serverBusy, notice, error: actionError ?? refreshError ?? next.snap?.job_error ?? null };
    listeners.forEach((fn) => fn());
  };
  const active = (c: AbortController | null) => c !== null && c === controller && !c.signal.aborted;

  function release(h: Hold) {
    if (h.timer) clearTimeout(h.timer);
    h.timer = null;
    if (hold === h) hold = null;
  }

  /** The run state and grid, read now. */
  async function fetchState(runId: string, current: () => boolean): Promise<{ snap: Snapshot; grid: GridRow[] } | null> {
    const snap = await client.run(runId);
    if (!current()) return null;
    const grid = snap.result ? (await client.grid(runId)).rows : [];
    return current() ? { snap, grid } : null;
  }

  /** Publishes a snapshot read by a fetch that started at idle count `idleAtStart`. */
  function land(snap: Snapshot, grid: GridRow[], idleAtStart: number) {
    if (state.snap && state.snap.pending?.gate !== snap.pending?.gate) actionError = null;
    refreshError = null;
    serverBusy = snap.working;
    if (hold && hold.idleAtDecision !== null && idleAtStart > hold.idleAtDecision) {
      hold.settled = true;
      release(hold);
    }
    if (notice === STALE_NOTICE || (notice === WORKING_NOTICE && !hold)) notice = null;
    set({ snap, grid, snapIdleSeq: idleAtStart });
  }

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
      const got = await fetchState(runId, current);
      if (got) land(got.snap, got.grid, idleAtStart);
    } catch (e) {
      if (current()) { refreshError = describe(e); set(); }
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

  function onDecision(entry: Record<string, unknown>) {
    const { seq, kind, payload } = entry;
    if (typeof seq !== "number" || typeof kind !== "string") return;
    if (state.decisionLog.some((d) => d.seq === seq)) return; // a replay after a reconnect: the first arrival counts
    const seen: SeenDecision = { seq, kind, payload: typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}, idleSeq: state.idleSeq };
    if (hold && hold.idleAtDecision === null && seq > hold.sinceSeq && decisionMatches(seen, hold.body, hold.gate)) hold.idleAtDecision = state.idleSeq;
    set({ decisionLog: [...state.decisionLog, seen].slice(-DECISION_CAP) });
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
      const entry = (data.entry ?? data) as Record<string, unknown>;
      if (typeof entry.actor === "string" && typeof entry.kind === "string") note(`${entry.actor}: ${entry.kind}`);
      onDecision(entry);
    } else if (m.event === "error") {
      note(`Error: ${String(data.message)}`);
      // An error does not end the job; but a job that fails before recording the post's decision still ends with an
      // idle, and that idle settles the post.
      if (hold && hold.idleAtDecision === null) hold.errored = true;
    }
    if (m.event === "idle") {
      if (hold && hold.idleAtDecision === null && hold.errored) hold.idleAtDecision = state.idleSeq;
      serverBusy = false;
      set({ idleSeq: state.idleSeq + 1 });
    }
    // The run is talking: a held post's job is alive, so its silence wait starts over.
    if (hold && hold.timer) arm(hold);
    if (REFRESH_ON.has(m.event)) schedule();
  }

  function dropHold() {
    if (hold) release(hold);
    notice = null;
    serverBusy = false;
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    const c = controller;
    controller = null;
    c?.abort();
    // A stopped run is gone from the pane: nothing of it (cards, grid, errors) may show during the next upload.
    actionError = null;
    refreshError = null;
    dropHold();
    if (state !== EMPTY) {
      state = EMPTY;
      listeners.forEach((fn) => fn());
    }
  }

  /**
   * (Re)starts the silence wait of an accepted post. When it runs out with the stream connected, the job is still
   * running: the hold continues with WORKING_NOTICE. Only with the stream down or reconnecting (its idle may never
   * arrive), or after the hard cap, are the cards re-enabled, with STALE_NOTICE.
   */
  function arm(h: Hold) {
    if (h.timer) clearTimeout(h.timer);
    h.acceptedAt ??= Date.now();
    h.timer = setTimeout(() => {
      h.timer = null;
      if (hold !== h || !active(h.c)) return;
      const capped = Date.now() - (h.acceptedAt ?? Date.now()) >= settleHardCapMs;
      if (state.connection === "connected" && !capped) {
        notice = WORKING_NOTICE;
        arm(h);
        set();
        return;
      }
      release(h);
      notice = STALE_NOTICE;
      set();
    }, settleTimeoutMs);
  }

  /**
   * A timed-out POST may have reached the server. Reads the run before anything is re-enabled: the post took effect if
   * its decision is recorded, the gate moved on, or a job is running (only the post starts one at a gate).
   */
  async function checkReceived(h: Hold, runId: string, timeout: RequestTimeout): Promise<boolean> {
    notice = CHECKING_NOTICE;
    set();
    const idleAtStart = state.idleSeq;
    const seq = ++refreshSeq;
    // Not superseded by a refresh (an event may schedule one meanwhile): the check must always conclude. If the post
    // settled meanwhile (its decision and idle arrived and a refresh landed), it was received.
    const current = () => active(h.c) && hold === h;
    const settledMeanwhile = () => {
      notice = null;
      set();
      return true;
    };
    // Stopped, or replaced by a newer post (whose own notice must stay): nothing to report for this one.
    const abandoned = () => {
      if (active(h.c) && hold === null) { notice = null; set(); }
      return false;
    };
    const publish = (snap: Snapshot, grid: GridRow[]) => { if (seq === refreshSeq) land(snap, grid, idleAtStart); };
    let got: { snap: Snapshot; grid: GridRow[] } | null;
    try {
      got = await fetchState(runId, current);
    } catch (e) {
      if (h.settled && active(h.c)) return settledMeanwhile();
      if (!current()) return abandoned();
      // Unknown either way: never claim "not received", a retry could post the action twice.
      actionError = `${describe(timeout)}; the run could not be checked (${describe(e)}). Refresh before you retry.`;
      notice = null;
      release(h);
      set();
      return false;
    }
    if (h.settled && active(h.c)) return settledMeanwhile();
    if (!got) return abandoned();
    const { snap } = got;
    const received = snap.working || (snap.pending?.gate ?? null) !== h.gate
      || snap.decisions.some((d) => d.seq > h.sinceSeq && decisionMatches(d, h.body, h.gate));
    notice = null;
    if (received) {
      arm(h);
      publish(snap, got.grid);
      set();
      schedule();
      return true;
    }
    actionError = `${NOT_RECEIVED} (${describe(timeout)})`;
    release(h);
    publish(snap, got.grid);
    set();
    return false;
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
      }).catch((e: unknown) => { if (active(c)) { actionError = describe(e); set(); } });
    },
    stop,
    refresh,
    async respond(body) {
      const c = controller;
      const runId = state.runId;
      if (!c || !runId) return false;
      // One post at a time: a click that slipped through while the last one is held is refused, not posted (a second
      // post would be a 409 at best, and must not drop the hold either).
      if (hold) return false;
      refreshSeq++; // an older in-flight refresh must not overwrite the post-click state
      actionError = null;
      notice = null;
      // Noted before the post: the job may record its decision and finish before the 202 arrives.
      const h: Hold = { c, body, gate: state.snap?.pending?.gate ?? null, sinceSeq: lastDecisionSeq(state.snap), idleAtPost: state.idleSeq, idleAtDecision: null, errored: false, acceptedAt: null, settled: false, timer: null };
      hold = h;
      set({ postIdleSeq: h.idleAtPost });
      try {
        await client.gate(runId, body);
      } catch (e) {
        // The run already showed this post's outcome (the 202 was lost or late): it was received, whatever the error.
        if (h.settled && active(c)) return true;
        if (!active(c) || hold !== h) return false;
        if (e instanceof RequestTimeout) return checkReceived(h, runId, e);
        actionError = describe(e);
        release(h);
        set();
        schedule(); // a refusal (409) means the run moved on: show where it is
        return false;
      }
      if (active(c) && hold === h) {
        arm(h);
        schedule();
      }
      return true;
    },
  };
}

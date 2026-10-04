import { REQUEST_TIMEOUT_MS } from "../api/client";
import type { Decision, GateBody, Snapshot, TypedChange } from "../api/types";
import { gateMessage } from "./gates";
import type { RunState } from "./store";

/** How long an accepted Apply waits for the run to record and settle its change before the verdict is "unknown". */
export const VERDICT_TIMEOUT_MS = 30_000;
/**
 * Longest an Apply holds uploads ("Onboard again") before the hold is released anyway. Its requests are bounded by
 * REQUEST_TIMEOUT_MS each, but Excel calls are not. After a hung request, releasing is safe: Onboard stops the store
 * first and an Apply never starts a render for a run that is no longer the store's. A render already running shares the
 * Excel queue with Onboard's sheet removal, so it cannot recreate the sheet after it; a hung render then holds Onboard
 * at "Uploading..." instead.
 */
export const APPLY_HOLD_MAX_MS = VERDICT_TIMEOUT_MS + REQUEST_TIMEOUT_MS;

export interface ItemIdEdit { row: number; value: string }
export type Verdict =
  | { kind: "pending" }
  | { kind: "applied" }
  | { kind: "refused"; message: string }
  | { kind: "unknown" };

/** Highest decision seq in the snapshot (0 when none): an Apply's verdict is read only from decisions after it. */
export const lastDecisionSeq = (snap: Snapshot | null): number =>
  (snap?.decisions ?? []).reduce((m, d) => Math.max(m, d.seq), 0);

/** A decision event the store saw on the stream, with the idle count when it arrived. */
export interface SeenDecision { seq: number; kind: string; payload: Record<string, unknown>; idleSeq: number }

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Every field `wanted` sets is equal in `recorded`. */
function covers(recorded: unknown, wanted: object): boolean {
  if (typeof recorded !== "object" || recorded === null) return false;
  const r = recorded as Record<string, unknown>;
  return Object.entries(wanted).every(([k, v]) => v === undefined || same(r[k], v));
}

/**
 * Whether a decision records the gate post `body` made at `gate` (null: the gate was not known). The run records
 * `<gate>.<action>` with the server's dump of the body as payload, defaults filled in, so only the posted fields are
 * compared, and each posted change must be among the recorded ones.
 */
export function decisionMatches(d: Pick<Decision, "kind" | "payload">, body: GateBody, gate: string | null): boolean {
  if (gate ? d.kind !== `${gate}.${body.action}` : !d.kind.endsWith(`.${body.action}`)) return false;
  return Object.entries(body).every(([k, v]) => {
    if (v === undefined) return true;
    if (k !== "changes") return same(d.payload[k], v);
    const recorded = d.payload.changes;
    return Array.isArray(recorded) && (v as TypedChange[]).every((c) => recorded.some((r: unknown) => covers(r, c)));
  });
}

/** The gate body an Apply posts. */
export const applyBody = (edit: ItemIdEdit): GateBody => ({ action: "change", changes: [{ kind: "override_item_id", row: edit.row, value: edit.value }] });

/** The decision the run records for this Apply: findings.change whose payload carries this exact override. */
function isApplyDecision(d: Pick<Decision, "seq" | "kind" | "payload">, edit: ItemIdEdit, sinceSeq: number): boolean {
  return d.seq > sinceSeq && decisionMatches(d, applyBody(edit), "findings");
}

/**
 * POST /gate answers 202 before the run checks a change, so the verdict is read from the run itself once it has
 * recorded this Apply's decision and settled at a gate. The server clears gate_message when it applies a change and
 * sets it ("Changes refused: ...") when it refuses one. A decision recorded after ours (another action) means the
 * gate message may be about that one; only the applied override itself is then conclusive.
 */
export function applyVerdict(snap: Snapshot | null, busy: boolean, edit: ItemIdEdit, sinceSeq: number): Verdict {
  if (!snap || snap.working || busy || !snap.pending) return { kind: "pending" };
  const ours = snap.decisions.filter((d) => isApplyDecision(d, edit, sinceSeq)).at(-1);
  if (!ours) return { kind: "pending" };
  const inEffect = snap.options.id_overrides[String(edit.row)] === edit.value.trim();
  if (inEffect) return { kind: "applied" };
  if (snap.decisions.some((d) => d.seq > ours.seq)) return { kind: "unknown" };
  const message = gateMessage(snap);
  return message ? { kind: "refused", message } : { kind: "applied" };
}

/** What an Apply notes before it posts: the last decision seq and the idle events seen so far. */
export interface ApplyMark { sinceSeq: number; idleSeq: number }
export const markApply = (state: Pick<RunState, "snap" | "idleSeq">): ApplyMark =>
  ({ sinceSeq: lastDecisionSeq(state.snap), idleSeq: state.idleSeq });

/**
 * The Apply's verdict from store state. GET /runs/{id} reads the graph checkpoint (gate, message, overrides) before the
 * busy flag and the decisions, so a snapshot taken while the job ends can pair the old gate with `working: false` and
 * the new decision. Only a snapshot fetched by a refresh that started after an idle event that arrived after this
 * Apply's own decision event is read: an idle from the job before (published after that job dropped its busy flag, or
 * replayed after a reconnect) does not count. If no such idle arrives (stream down), the Apply's timeout makes the
 * verdict unknown.
 */
export function verdictFrom(state: Pick<RunState, "snap" | "busy" | "snapIdleSeq" | "decisionLog">, edit: ItemIdEdit, mark: ApplyMark): Verdict {
  if (state.snapIdleSeq <= mark.idleSeq) return { kind: "pending" };
  const seen = state.decisionLog.find((d) => isApplyDecision(d, edit, mark.sinceSeq));
  if (!seen || state.snapIdleSeq <= seen.idleSeq) return { kind: "pending" };
  return applyVerdict(state.snap, state.busy, edit, mark.sinceSeq);
}

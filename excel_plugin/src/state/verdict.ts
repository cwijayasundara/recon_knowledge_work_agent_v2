import { REQUEST_TIMEOUT_MS } from "../api/client";
import type { Decision, Snapshot } from "../api/types";
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

function isOverride(c: unknown, edit: ItemIdEdit): boolean {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  return o.kind === "override_item_id" && o.row === edit.row && o.value === edit.value;
}

/** The decision the run records for this Apply: findings.change whose payload carries this exact override. */
function isApplyDecision(d: Decision, edit: ItemIdEdit, sinceSeq: number): boolean {
  if (d.seq <= sinceSeq || d.kind !== "findings.change") return false;
  const changes = d.payload.changes;
  return Array.isArray(changes) && changes.some((c: unknown) => isOverride(c, edit));
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
 * the new decision. Only a snapshot fetched by a refresh that started after an idle event that followed the post is
 * read; if no idle arrives (stream down), the Apply's timeout makes the verdict unknown.
 */
export function verdictFrom(state: Pick<RunState, "snap" | "busy" | "snapIdleSeq">, edit: ItemIdEdit, mark: ApplyMark): Verdict {
  if (state.snapIdleSeq <= mark.idleSeq) return { kind: "pending" };
  return applyVerdict(state.snap, state.busy, edit, mark.sinceSeq);
}

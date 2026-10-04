import type { Pending, Snapshot } from "../api/types";

export const pendingGate = (s: Snapshot | null): Pending["gate"] | null => s?.pending?.gate ?? null;
export const blockedReasons = (s: Snapshot | null): string[] => s?.pending?.blocked_reasons ?? [];
export const canApprove = (s: Snapshot | null, busy: boolean): boolean =>
  !busy && !!s?.pending && s.pending.allowed_actions.includes("approve") && s.pending.blocked_reasons.length === 0;
/**
 * Acknowledge, Exclude row and Apply are findings-gate changes. A re-entered brief gate also lists "change" (and may
 * still carry a stale result), but routes changes to scoping, where these would be dropped.
 */
export const canChangeFindings = (s: Snapshot | null): boolean =>
  pendingGate(s) === "findings" && (s?.pending?.allowed_actions.includes("change") ?? false);
/**
 * The server's note for the gate it is waiting at, verbatim: a refusal ("Changes refused: ...", "Cannot pass the
 * gate: ...") comes back this way because POST /gate answers 202 before the run validates the action.
 * `pending.message` is the gate payload's own (for findings it is `gate_message or error`); the top-level
 * `gate_message` is the fallback. Null when not at a gate or there is nothing to say.
 */
export const gateMessage = (s: Snapshot | null): string | null =>
  s?.pending ? (s.pending.message || s.gate_message || null) : null;

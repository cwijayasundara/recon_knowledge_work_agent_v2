import type { GateBody, Snapshot, TypedChange } from "../api/types";
import { gateMessage } from "./gates";
import type { RunState } from "./store";
import { decisionMatches, lastDecisionSeq } from "./verdict";

/** Longest instruction the composer sends (after trimming), so a paste cannot make a huge POST. */
export const CHAT_MAX_CHARS = 2000;
export const NO_REPLY_TEXT = "The agent did not reply.";
export const BRIEF_UNCHANGED = "The agent re-read the file; the brief is unchanged.";

export const ACK_NOT_FROM_CHAT = "This proposal acknowledges warnings. Acknowledge warnings yourself in the Findings list.";
export const RESCOPE_NOTE = "Applying this re-scopes the run: you'll return to the brief gate.";
export const RESCOPE_SENT = "Sent. The run is re-scoping — check the brief.";

export type Proposal = NonNullable<Snapshot["proposal"]>;

/** The chat never acknowledges for the analyst: a proposal with any acknowledgement is not applyable from it. */
export const acknowledges = (p: Pick<Proposal, "changes">): boolean => p.changes.some((c) => c.kind === "acknowledge_finding");

/** Layout changes and recipe revisions send the run back to scoping (the server's LAYOUT_CHANGES), not to a rebuild. */
const RESCOPING = new Set<TypedChange["kind"]>(["set_sheet", "set_header_row", "set_column_binding", "request_recipe_revision"]);
export const rescopes = (p: Pick<Proposal, "changes">): boolean => p.changes.some((c) => RESCOPING.has(c.kind));

/** One line per typed change (ported from the web workbench's Copilot). */
export function describeChange(c: TypedChange): string {
  switch (c.kind) {
    case "override_item_id": return `Set ITEM_ID of row ${c.row} to ${c.value}`;
    case "exclude_row": return `Exclude row ${c.row} (DONOTIMPORT '#')`;
    case "acknowledge_finding": return `Acknowledge ${c.code}${c.row ? ` on row ${c.row}` : ""}`;
    case "set_item_type": return `Set ITEM_TYPE to ${c.value}${c.rows ? ` for rows ${c.rows.join(", ")}` : ""}`;
    case "set_column_binding": return `Bind ${c.field} to ${c.column ?? "no column"}`;
    case "set_sheet": return `Use sheet ${c.sheet}`;
    case "set_header_row": return `Header on row ${c.header_row}`;
    case "request_recipe_revision": return `Revise the recipe: ${c.instruction}`;
  }
}

/** The run waits at a gate that takes an instruction (brief and findings today). */
export const canInstruct = (s: Snapshot | null): boolean => s?.pending?.allowed_actions.includes("instruct") ?? false;

/** Why the composer's text cannot be sent, or null when it can. */
export function sendBlocked(text: string): "empty" | "too-long" | null {
  const t = text.trim();
  if (!t) return "empty";
  return t.length > CHAT_MAX_CHARS ? "too-long" : null;
}

export const instructBody = (text: string): GateBody => ({ action: "instruct", text: text.trim() });

/** What a gate post notes before it is sent: its decision and idle are read only after these. */
export interface PostMark { runId: string | null; gate: string | null; sinceSeq: number; idleSeq: number }
export interface ChatMark extends PostMark { text: string; briefBefore: string | null }

type Markable = Pick<RunState, "runId" | "snap" | "idleSeq" | "decisionLog">;

/** The newest decision seen so far, in the snapshot or on the stream: only decisions after it can be this post's. */
const lastSeenSeq = (s: Markable): number => s.decisionLog.reduce((m, d) => Math.max(m, d.seq), lastDecisionSeq(s.snap));

export const markPost = (s: Markable): PostMark =>
  ({ runId: s.runId, gate: s.snap?.pending?.gate ?? null, sinceSeq: lastSeenSeq(s), idleSeq: s.idleSeq });

export const markChat = (s: Markable, text: string): ChatMark =>
  ({ ...markPost(s), text: text.trim(), briefBefore: s.snap?.brief ? JSON.stringify(s.snap.brief) : null });

type Fresh = Pick<RunState, "runId" | "snap" | "busy" | "snapIdleSeq" | "decisionLog">;

/** This post's decision as seen on the stream: the newest one after the mark that records exactly this body. */
const ownDecision = (state: Fresh, body: GateBody, mark: PostMark) =>
  state.decisionLog.filter((d) => d.seq > mark.sinceSeq && decisionMatches(d, body, mark.gate)).at(-1);

/**
 * The snapshot that shows a gate post's outcome whole, or null while there is none: the same rule as an Apply's verdict
 * (see verdictFrom). Read only from a snapshot fetched by a refresh that started after an idle that arrived after this
 * post's own decision event, with the run settled at a gate; an earlier idle (the previous job's) does not count.
 */
function settledSnapshot(state: Fresh, body: GateBody, mark: PostMark): Snapshot | null {
  if (state.runId !== mark.runId || state.snapIdleSeq <= mark.idleSeq) return null;
  const seen = ownDecision(state, body, mark);
  if (!seen || state.snapIdleSeq <= seen.idleSeq) return null;
  const snap = state.snap;
  if (!snap || snap.working || state.busy || !snap.pending) return null;
  return snap;
}

export type ChatReply =
  | { kind: "pending" }
  | { kind: "reply"; lines: string[]; proposal: Proposal | null };

/**
 * The agent's reply to an instruction, from the run once it settled. At the findings gate the run stores the agent's
 * reading as `proposal` (restated, typed changes, impact) or a gate message when the agent failed; at the brief gate
 * an instruction re-scopes, so the reply is the new brief (or the gate message).
 */
export function chatReplyFrom(state: Fresh, mark: ChatMark): ChatReply {
  const snap = settledSnapshot(state, instructBody(mark.text), mark);
  if (!snap) return { kind: "pending" };
  const message = gateMessage(snap);
  if (mark.gate === "brief") {
    const changed = snap.brief !== null && JSON.stringify(snap.brief) !== mark.briefBefore;
    const lines = [...(changed && snap.brief ? [`Updated the brief: ${snap.brief.summary}`] : []), ...(message ? [message] : [])];
    return { kind: "reply", lines: lines.length ? lines : [BRIEF_UNCHANGED], proposal: null };
  }
  const proposal = snap.proposal;
  const lines = [...(message ? [message] : []), ...(proposal ? [proposal.restated] : [])];
  return { kind: "reply", lines: lines.length ? lines : [NO_REPLY_TEXT], proposal };
}

/** The run still offers exactly this proposal (an applied change, an approve or a newer instruction clears it). */
export const proposalIsCurrent = (snap: Snapshot | null, p: Proposal): boolean =>
  !!snap?.proposal && JSON.stringify(snap.proposal.changes) === JSON.stringify(p.changes) && snap.proposal.restated === p.restated;

export const UNKNOWN_OUTCOME = "Verdict unknown — check the findings gate.";

/** The line an Apply's settled outcome shows (chat and copilot proposal cards). */
export function outcomeText(o: Exclude<ChangeOutcome, { kind: "pending" }>): string {
  switch (o.kind) {
    case "applied": return "Applied.";
    case "rescoping": return RESCOPE_SENT;
    case "refused": return `Not applied: ${o.message}`;
    case "unknown": return UNKNOWN_OUTCOME;
  }
}

export type ChangeOutcome =
  | { kind: "pending" } | { kind: "applied" } | { kind: "rescoping" } | { kind: "refused"; message: string } | { kind: "unknown" };

/**
 * The outcome of a proposal's Apply (`change` with the proposal's changes). POST /gate answers 202 before the run checks
 * the changes: a refusal comes back as the gate message ("Changes refused: ..."), an applied change clears it. A decision
 * recorded after ours makes the message ambiguous. Re-scoping changes leave the findings gate for the brief gate, where
 * the message is the new scoping's, so they are reported as sent and re-scoping, never as applied.
 */
export function changeOutcome(state: Fresh, changes: TypedChange[], mark: PostMark): ChangeOutcome {
  const body: GateBody = { action: "change", changes };
  const snap = settledSnapshot(state, body, mark);
  const ours = ownDecision(state, body, mark);
  if (!snap || !ours) return { kind: "pending" };
  if (state.decisionLog.some((d) => d.seq > ours.seq) || snap.decisions.some((d) => d.seq > ours.seq)) return { kind: "unknown" };
  const message = gateMessage(snap);
  if (rescopes({ changes })) {
    if (snap.pending?.gate === "brief") return { kind: "rescoping" };
    return message ? { kind: "refused", message } : { kind: "unknown" };
  }
  return message ? { kind: "refused", message } : { kind: "applied" };
}

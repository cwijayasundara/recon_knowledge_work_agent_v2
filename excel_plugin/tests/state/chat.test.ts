import { expect, test } from "vitest";
import type { Brief, Decision, Pending, TypedChange } from "../../src/api/types";
import {
  CHAT_MAX_CHARS, BRIEF_UNCHANGED, NO_REPLY_TEXT, acknowledges, canInstruct, rescopes, changeOutcome, chatReplyFrom, describeChange, instructBody,
  markChat, markPost, proposalIsCurrent, sendBlocked, type ChatMark,
} from "../../src/state/chat";
import type { RunState } from "../../src/state/store";
import type { SeenDecision } from "../../src/state/verdict";
import { fakeSnapshot } from "../support/fakes";

const brief = (summary: string): Brief => ({
  source: { file: "a.xlsx", sheet: "S1", header_row: 1, rows_read: 1, rows_emitted: 1, rows_dropped: 0, drop_reasons: [] },
  bindings: [], id_strategy: "source_id", item_type: "Inventory", recipe: { kind: "builtin", id: null }, expected_findings: [], questions: [], confidence: 1, summary,
});
const pending = (gate: Pending["gate"], over: Partial<Pending> = {}): Pending => ({ gate, message: null, blocked_reasons: [], allowed_actions: ["approve", "change", "instruct", "reject"], ...over });
const decision = (seq: number, kind: string, payload: Record<string, unknown>): Decision => ({ run_id: "r1", seq, kind, payload, actor: "a", at: "t" });
const seen = (seq: number, kind: string, payload: Record<string, unknown>, idleSeq: number): SeenDecision => ({ seq, kind, payload, idleSeq });
function state(over: Partial<RunState> = {}): RunState {
  return { runId: "r1", snap: fakeSnapshot({ pending: pending("findings") }), grid: [], activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null, ...over };
}
const exclude: TypedChange = { kind: "exclude_row", row: 2, reason: "exclude row 2" };
const proposal = { restated: "Exclude row 2 from the import.", applicable: true, changes: [exclude], impact: null };

test("describeChange covers every typed change", () => {
  expect([
    { kind: "override_item_id", row: 2, value: "X" },
    { kind: "exclude_row", row: 3, reason: "r" },
    { kind: "acknowledge_finding", code: "W1", row: 4 },
    { kind: "acknowledge_finding", code: "W2", row: null },
    { kind: "set_item_type", value: "Non-Inventory" },
    { kind: "set_item_type", value: "Non-Inventory", rows: [2, 3] },
    { kind: "set_column_binding", field: "affiliate_id", column: "ID" },
    { kind: "set_column_binding", field: "affiliate_id", column: null },
    { kind: "set_sheet", sheet: "S2" },
    { kind: "set_header_row", header_row: 4 },
    { kind: "request_recipe_revision", instruction: "split names" },
  ].map((c) => describeChange(c as TypedChange))).toEqual([
    "Set ITEM_ID of row 2 to X",
    "Exclude row 3 (DONOTIMPORT '#')",
    "Acknowledge W1 on row 4",
    "Acknowledge W2",
    "Set ITEM_TYPE to Non-Inventory",
    "Set ITEM_TYPE to Non-Inventory for rows 2, 3",
    "Bind affiliate_id to ID",
    "Bind affiliate_id to no column",
    "Use sheet S2",
    "Header on row 4",
    "Revise the recipe: split names",
  ]);
});

test("canInstruct follows the pending gate's allowed actions; sendBlocked trims and caps", () => {
  expect(canInstruct(null)).toBe(false);
  expect(canInstruct(fakeSnapshot())).toBe(false);
  expect(canInstruct(fakeSnapshot({ pending: pending("signoff", { allowed_actions: ["approve", "reject"] }) }))).toBe(false);
  expect(canInstruct(fakeSnapshot({ pending: pending("brief") }))).toBe(true);
  expect(sendBlocked("")).toBe("empty");
  expect(sendBlocked("   \n ")).toBe("empty");
  expect(sendBlocked("x".repeat(CHAT_MAX_CHARS))).toBeNull();
  expect(sendBlocked(` ${"x".repeat(CHAT_MAX_CHARS)} `)).toBeNull();
  expect(sendBlocked("x".repeat(CHAT_MAX_CHARS + 1))).toBe("too-long");
  expect(instructBody("  hi  ")).toEqual({ action: "instruct", text: "hi" });
});

test("markChat notes the gate, last decision seq, idle count and the brief", () => {
  const s = state({ idleSeq: 3, snap: fakeSnapshot({ brief: brief("B"), pending: pending("brief"), decisions: [decision(4, "brief.answer", {})] }) });
  const m = markChat(s, " go ");
  expect(m).toMatchObject({ runId: "r1", gate: "brief", sinceSeq: 4, idleSeq: 3, text: "go" });
  expect(m.briefBefore).toBe(JSON.stringify(brief("B")));
  expect(markPost(s)).toEqual({ runId: "r1", gate: "brief", sinceSeq: 4, idleSeq: 3 });
  expect(markChat(state({ runId: null, snap: null }), "x")).toMatchObject({ runId: null, gate: null, sinceSeq: 0, briefBefore: null });
});

const findingsMark: ChatMark = { runId: "r1", gate: "findings", sinceSeq: 0, idleSeq: 0, text: "exclude row 2", briefBefore: null };
const ours = (idleSeq: number) => seen(1, "findings.instruct", { action: "instruct", text: "exclude row 2", actor: "a" }, idleSeq);

test("chat reply stays pending until a snapshot read after an idle that followed this instruct's own decision", () => {
  const settledSnap = fakeSnapshot({ pending: pending("findings"), proposal });
  // No idle since the post.
  expect(chatReplyFrom(state({ snap: settledSnap, decisionLog: [ours(0)] }), findingsMark).kind).toBe("pending");
  // Idle arrived, but no decision of ours (the previous job's idle).
  expect(chatReplyFrom(state({ snap: settledSnap, snapIdleSeq: 1, idleSeq: 1 }), findingsMark).kind).toBe("pending");
  // Another text's decision does not count.
  expect(chatReplyFrom(state({ snap: settledSnap, snapIdleSeq: 2, idleSeq: 2, decisionLog: [seen(1, "findings.instruct", { action: "instruct", text: "other" }, 0)] }), findingsMark).kind).toBe("pending");
  // An older decision (seq not after the mark) does not count.
  expect(chatReplyFrom(state({ snap: settledSnap, snapIdleSeq: 2, idleSeq: 2, decisionLog: [ours(0)] }), { ...findingsMark, sinceSeq: 1 }).kind).toBe("pending");
  // Decision arrived after an idle that the snapshot was read at: stale.
  expect(chatReplyFrom(state({ snap: settledSnap, snapIdleSeq: 1, idleSeq: 1, decisionLog: [ours(1)] }), findingsMark).kind).toBe("pending");
  // Fresh but still busy / working / not at a gate / other run.
  const fresh = { snapIdleSeq: 2, idleSeq: 2, decisionLog: [ours(1)] };
  expect(chatReplyFrom(state({ ...fresh, snap: settledSnap, busy: true }), findingsMark).kind).toBe("pending");
  expect(chatReplyFrom(state({ ...fresh, snap: { ...settledSnap, working: true } }), findingsMark).kind).toBe("pending");
  expect(chatReplyFrom(state({ ...fresh, snap: { ...settledSnap, pending: null } }), findingsMark).kind).toBe("pending");
  expect(chatReplyFrom(state({ ...fresh, snap: null }), findingsMark).kind).toBe("pending");
  expect(chatReplyFrom(state({ ...fresh, snap: settledSnap, runId: "r2" }), findingsMark).kind).toBe("pending");
  // Settled.
  expect(chatReplyFrom(state({ ...fresh, snap: settledSnap }), findingsMark)).toEqual({ kind: "reply", lines: ["Exclude row 2 from the import."], proposal });
});

test("findings reply: gate message verbatim, a non-applicable proposal, or the fallback", () => {
  const fresh = { snapIdleSeq: 2, idleSeq: 2, decisionLog: [ours(1)] };
  const refused = fakeSnapshot({ pending: pending("findings", { message: "The agent could not read the instruction: boom" }), proposal: null });
  expect(chatReplyFrom(state({ ...fresh, snap: refused }), findingsMark)).toEqual({ kind: "reply", lines: ["The agent could not read the instruction: boom"], proposal: null });
  const declined = { restated: "'hi' does not map to any Affiliate change.", applicable: false, changes: [], impact: null };
  expect(chatReplyFrom(state({ ...fresh, snap: fakeSnapshot({ pending: pending("findings"), proposal: declined }) }), findingsMark)).toEqual({ kind: "reply", lines: [declined.restated], proposal: declined });
  expect(chatReplyFrom(state({ ...fresh, snap: fakeSnapshot({ pending: pending("findings") }) }), findingsMark)).toEqual({ kind: "reply", lines: [NO_REPLY_TEXT], proposal: null });
});

test("brief reply: the new summary when the brief changed, else the gate message, else 'unchanged'", () => {
  const before = brief("Old");
  const mark: ChatMark = { runId: "r1", gate: "brief", sinceSeq: 0, idleSeq: 0, text: "use sheet 2", briefBefore: JSON.stringify(before) };
  const fresh = { snapIdleSeq: 2, idleSeq: 2, decisionLog: [seen(1, "brief.instruct", { action: "instruct", text: "use sheet 2" }, 1)] };
  expect(chatReplyFrom(state({ ...fresh, snap: fakeSnapshot({ brief: brief("New"), pending: pending("brief") }) }), mark)).toEqual({ kind: "reply", lines: ["Updated the brief: New"], proposal: null });
  expect(chatReplyFrom(state({ ...fresh, snap: fakeSnapshot({ brief: brief("New"), pending: pending("brief", { message: "note" }) }) }), mark)).toEqual({ kind: "reply", lines: ["Updated the brief: New", "note"], proposal: null });
  expect(chatReplyFrom(state({ ...fresh, snap: fakeSnapshot({ brief: before, pending: pending("brief") }) }), mark)).toEqual({ kind: "reply", lines: [BRIEF_UNCHANGED], proposal: null });
  expect(chatReplyFrom(state({ ...fresh, snap: fakeSnapshot({ brief: null, pending: pending("brief", { message: "The agent did not submit a brief." }) }) }), mark)).toEqual({ kind: "reply", lines: ["The agent did not submit a brief."], proposal: null });
  // A brief-gate instruct never shows a proposal card (proposals are findings-gate changes).
  expect(chatReplyFrom(state({ ...fresh, snap: fakeSnapshot({ brief: before, pending: pending("brief"), proposal }) }), mark)).toEqual({ kind: "reply", lines: [BRIEF_UNCHANGED], proposal: null });
});

test("proposalIsCurrent: only while the run still offers this exact proposal", () => {
  expect(proposalIsCurrent(fakeSnapshot({ proposal }), proposal)).toBe(true);
  expect(proposalIsCurrent(fakeSnapshot({ proposal: { ...proposal, changes: [{ ...exclude, row: 3 }] } }), proposal)).toBe(false);
  expect(proposalIsCurrent(fakeSnapshot({ proposal: null }), proposal)).toBe(false);
  expect(proposalIsCurrent(null, proposal)).toBe(false);
});

test("changeOutcome: pending until fresh after its own decision; refused with the gate message, else applied; unknown if another decision followed", () => {
  const mark = { runId: "r1", gate: "findings", sinceSeq: 0, idleSeq: 0 };
  const changeSeen = seen(1, "findings.change", { action: "change", changes: [{ ...exclude }] }, 1);
  const fresh = { snapIdleSeq: 2, idleSeq: 2, decisionLog: [changeSeen] };
  const applied = fakeSnapshot({ pending: pending("findings"), decisions: [decision(1, "findings.change", changeSeen.payload)] });
  expect(changeOutcome(state({ snap: applied }), [exclude], mark).kind).toBe("pending");
  expect(changeOutcome(state({ snap: applied, snapIdleSeq: 2, idleSeq: 2 }), [exclude], mark).kind).toBe("pending");
  expect(changeOutcome(state({ ...fresh, snap: applied, busy: true }), [exclude], mark).kind).toBe("pending");
  expect(changeOutcome(state({ ...fresh, snap: applied, runId: "r2" }), [exclude], mark).kind).toBe("pending");
  expect(changeOutcome(state({ ...fresh, snap: applied }), [exclude], mark)).toEqual({ kind: "applied" });
  const refused = { ...applied, pending: pending("findings", { message: "Changes refused: nope" }) };
  expect(changeOutcome(state({ ...fresh, snap: refused }), [exclude], mark)).toEqual({ kind: "refused", message: "Changes refused: nope" });
  const later = { ...refused, decisions: [...refused.decisions, decision(2, "findings.change", {})] };
  expect(changeOutcome(state({ ...fresh, snap: later }), [exclude], mark)).toEqual({ kind: "unknown" });
});

test("the mark counts decisions seen on the stream, so an older same-text decision is never taken as the reply's", () => {
  const s = state({ idleSeq: 2, snap: fakeSnapshot({ pending: pending("findings"), decisions: [decision(1, "findings.instruct", {})] }), decisionLog: [ours(0), seen(3, "findings.instruct", { action: "instruct", text: "exclude row 2" }, 1)] });
  expect(markChat(s, "exclude row 2").sinceSeq).toBe(3);
  expect(markPost(s).sinceSeq).toBe(3);
  // Two of our decisions after the mark (a replay or a retry): the newest decides freshness.
  const settledSnap = fakeSnapshot({ pending: pending("findings"), proposal });
  const both = [ours(0), seen(2, "findings.instruct", { action: "instruct", text: "exclude row 2" }, 2)];
  expect(chatReplyFrom(state({ snap: settledSnap, snapIdleSeq: 2, idleSeq: 2, decisionLog: both }), findingsMark).kind).toBe("pending");
  expect(chatReplyFrom(state({ snap: settledSnap, snapIdleSeq: 3, idleSeq: 3, decisionLog: both }), findingsMark).kind).toBe("reply");
});

test("acknowledges and rescopes classify a proposal's changes", () => {
  expect(acknowledges({ ...proposal, changes: [exclude, { kind: "acknowledge_finding", code: "W1", row: 2 }] })).toBe(true);
  expect(acknowledges(proposal)).toBe(false);
  for (const c of [{ kind: "set_sheet", sheet: "S" }, { kind: "set_header_row", header_row: 2 }, { kind: "set_column_binding", field: "affiliate_id", column: "A" }, { kind: "request_recipe_revision", instruction: "x" }] as TypedChange[]) {
    expect(rescopes({ changes: [exclude, c] })).toBe(true);
  }
  expect(rescopes({ changes: [exclude, { kind: "set_item_type", value: "Non-Inventory" }, { kind: "override_item_id", row: 2, value: "X" }] })).toBe(false);
});

test("a re-scoping change is 'rescoping' at the brief gate, refused with a findings message, never 'applied'", () => {
  const bind: TypedChange = { kind: "set_column_binding", field: "affiliate_id", column: "A" };
  const mark = { runId: "r1", gate: "findings", sinceSeq: 0, idleSeq: 0 };
  const d = seen(1, "findings.change", { action: "change", changes: [bind] }, 1);
  const fresh = { snapIdleSeq: 2, idleSeq: 2, decisionLog: [d] };
  expect(changeOutcome(state({ ...fresh, snap: fakeSnapshot({ pending: pending("brief", { message: "The agent did not submit a brief." }) }) }), [bind], mark)).toEqual({ kind: "rescoping" });
  expect(changeOutcome(state({ ...fresh, snap: fakeSnapshot({ pending: pending("findings", { message: "Changes refused: x" }) }) }), [bind], mark)).toEqual({ kind: "refused", message: "Changes refused: x" });
  expect(changeOutcome(state({ ...fresh, snap: fakeSnapshot({ pending: pending("findings") }) }), [bind], mark)).toEqual({ kind: "unknown" });
  // A later decision on the stream makes any outcome ambiguous.
  expect(changeOutcome(state({ ...fresh, decisionLog: [d, seen(2, "findings.approve", {}, 1)], snap: fakeSnapshot({ pending: pending("brief") }) }), [bind], mark)).toEqual({ kind: "unknown" });
});

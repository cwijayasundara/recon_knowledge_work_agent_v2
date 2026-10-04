import { expect, test } from "vitest";
import type { Decision, Snapshot } from "../../src/api/types";
import { APPLY_HOLD_MAX_MS, applyVerdict, lastDecisionSeq, VERDICT_TIMEOUT_MS } from "../../src/state/verdict";
import { fakeSnapshot } from "../support/fakes";

const edit = { row: 2, value: "AFF_1" };
const d = (seq: number, kind = "findings.change", changes: unknown = [{ kind: "override_item_id", row: 2, value: "AFF_1" }]): Decision =>
  ({ run_id: "r1", seq, kind, payload: { action: "change", changes }, actor: "a", at: "t" });
const snap = (decisions: Decision[], over: Partial<Snapshot> = {}, message: string | null = null): Snapshot =>
  fakeSnapshot({ decisions, pending: { gate: "findings", message, blocked_reasons: [], allowed_actions: ["approve", "change"] }, ...over });

test("pending until the run has recorded this Apply's decision and settled at a gate", () => {
  expect(applyVerdict(null, false, edit, 0)).toEqual({ kind: "pending" });
  expect(applyVerdict(snap([d(1)], { working: true }), false, edit, 0)).toEqual({ kind: "pending" });
  expect(applyVerdict(snap([d(1)]), true, edit, 0)).toEqual({ kind: "pending" });
  expect(applyVerdict(snap([d(1)], { pending: null }), false, edit, 0)).toEqual({ kind: "pending" });
  expect(applyVerdict(snap([d(1)], {}, "Changes refused: x"), false, edit, 1)).toEqual({ kind: "pending" }); // recorded before the post
});

test("only findings.change carrying this exact override counts", () => {
  const others = [
    d(1, "findings.approve", []),
    d(2, "brief.change"),
    d(3, "findings.change", [{ kind: "acknowledge_finding", code: "W", row: 2 }]),
    d(4, "findings.change", [{ kind: "override_item_id", row: 3, value: "AFF_1" }]),
    d(5, "findings.change", [{ kind: "override_item_id", row: 2, value: "AFF_2" }]),
    d(6, "findings.change", "not a list"),
    d(7, "findings.change", [null, 1]),
  ];
  expect(applyVerdict(snap(others, {}, "Cannot pass the gate: 1 error"), false, edit, 0)).toEqual({ kind: "pending" });
});

test("refused with the server's message; applied when the gate has no message or the override is in effect", () => {
  expect(applyVerdict(snap([d(1)], {}, "Changes refused: item_id.charset: bad"), false, edit, 0)).toEqual({ kind: "refused", message: "Changes refused: item_id.charset: bad" });
  expect(applyVerdict(snap([d(1)]), false, edit, 0)).toEqual({ kind: "applied" });
  const inEffect = { options: { ...fakeSnapshot().options, id_overrides: { "2": "AFF_1" } } };
  expect(applyVerdict(snap([d(1)], inEffect, "recipe failed: standing error"), false, edit, 0)).toEqual({ kind: "applied" });
});

test("a later decision makes the gate message ambiguous: applied only when the override is in effect, else unknown", () => {
  const later = [d(1), d(2, "findings.approve", [])];
  expect(applyVerdict(snap(later, {}, "Cannot pass the gate: 1 error"), false, edit, 0)).toEqual({ kind: "unknown" });
  expect(applyVerdict(snap(later), false, edit, 0)).toEqual({ kind: "unknown" });
  const inEffect = { options: { ...fakeSnapshot().options, id_overrides: { "2": "AFF_1" } } };
  expect(applyVerdict(snap(later, inEffect, "Cannot pass the gate: 1 error"), false, edit, 0)).toEqual({ kind: "applied" });
});

test("lastDecisionSeq is the highest seq, 0 without decisions; the timeout is bounded", () => {
  expect(lastDecisionSeq(null)).toBe(0);
  expect(lastDecisionSeq(snap([d(3), d(9), d(4)]))).toBe(9);
  expect(VERDICT_TIMEOUT_MS).toBe(30_000);
  expect(APPLY_HOLD_MAX_MS).toBe(60_000); // the verdict wait plus one request bound
});

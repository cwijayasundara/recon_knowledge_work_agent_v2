import { expect, test } from "vitest";
import { blockedReasons, canApprove, canChangeFindings, pendingGate } from "../../src/state/gates";
import { fakeSnapshot } from "../support/fakes";

const pending = (over = {}) => ({ gate: "signoff" as const, message: null, blocked_reasons: [], allowed_actions: ["approve", "change"], ...over });

test("approve is allowed only when the gate lists it, nothing blocks and the run is idle", () => {
  expect(canApprove(fakeSnapshot({ pending: pending() }), false)).toBe(true);
  expect(canApprove(fakeSnapshot({ pending: pending({ allowed_actions: ["change"] }) }), false)).toBe(false);
  expect(canApprove(fakeSnapshot({ pending: pending({ blocked_reasons: ["2 errors"] }) }), false)).toBe(false);
  expect(canApprove(fakeSnapshot({ pending: pending() }), true)).toBe(false);
  expect(canApprove(fakeSnapshot({ pending: null }), false)).toBe(false);
  expect(canApprove(null, false)).toBe(false);
});
test("blockedReasons and pendingGate read the pending gate", () => {
  const s = fakeSnapshot({ pending: pending({ blocked_reasons: ["a"] }) });
  expect(blockedReasons(s)).toEqual(["a"]);
  expect(pendingGate(s)).toBe("signoff");
  expect(pendingGate(null)).toBeNull();
});
test("findings changes need the findings gate offering change; a re-entered brief gate with a stale result does not count", () => {
  const result = { rows_emitted: 1, rows_dropped: 0, findings_by_code: {}, errors: 0, ack_required: 0, publishable: true, findings: [] };
  expect(canChangeFindings(fakeSnapshot({ pending: pending({ gate: "findings" }) }))).toBe(true);
  expect(canChangeFindings(fakeSnapshot({ pending: pending({ gate: "findings", allowed_actions: ["approve"] }) }))).toBe(false);
  expect(canChangeFindings(fakeSnapshot({ result, pending: pending({ gate: "brief", allowed_actions: ["approve", "change"] }) }))).toBe(false);
  expect(canChangeFindings(fakeSnapshot({ pending: null }))).toBe(false);
  expect(canChangeFindings(null)).toBe(false);
});

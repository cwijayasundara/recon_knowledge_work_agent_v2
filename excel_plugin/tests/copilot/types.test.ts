import { describe, expect, test } from "vitest";
import { COPILOT_CLIENT_TOOLS, type CopilotChange, type StepBody, type StepOut } from "../../src/copilot/types";

// Mirrors CLIENT_TOOLS in src/onboarding_agent/copilot/schemas.py; update both together.
const SERVER_CLIENT_TOOLS = ["describe_sheet", "find", "get_selection", "list_sheets", "read_range"];

describe("copilot types", () => {
  test("client tool names match the server's CLIENT_TOOLS", () => {
    expect([...COPILOT_CLIENT_TOOLS].sort()).toEqual(SERVER_CLIENT_TOOLS);
  });

  test("CopilotChange excludes acknowledge_finding (compile-time)", () => {
    const ok = { kind: "exclude_row", row: 3, reason: "dup" } satisfies CopilotChange;
    // @ts-expect-error acknowledge_finding is not a copilot change
    const bad: CopilotChange = { kind: "acknowledge_finding", code: "X", row: null };
    expect(ok.kind).toBe("exclude_row");
    expect(bad.kind).toBe("acknowledge_finding");
  });

  test("StepOut shape (compile-time)", () => {
    const s = { status: "final", tool_calls: [], text: "hi", proposed_changes: [], proposed_writes: [{ sheet: "S", range: "A1", values: [[1]], note: "" }], notes: [] } satisfies StepOut;
    expect(s.status).toBe("final");
  });

  test("StepBody is exactly one of user_message or tool_results (compile-time)", () => {
    const a: StepBody = { user_message: "hi" };
    const b: StepBody = { tool_results: [{ call_id: "c", ok: true, content: null }] };
    // @ts-expect-error both fields at once
    const both: StepBody = { user_message: "hi", tool_results: [] };
    // @ts-expect-error neither field
    const neither: StepBody = {};
    expect([a, b, both, neither]).toHaveLength(4);
  });
});

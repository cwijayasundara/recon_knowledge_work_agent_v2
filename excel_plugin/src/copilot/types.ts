// Wire types for the Copilot API (src/onboarding_agent/copilot/schemas.py and routes.py); keep in sync.
import type { TypedChange } from "../api/types";

export interface CopilotLimits {
  max_cells_per_call: number;
  max_cells_per_session: number;
  max_steps_per_turn: number;
  max_write_cells: number;
  cell_char_limit: number;
}

export interface CopilotStart {
  session_id: string;
  limits: CopilotLimits;
  tools: string[];
  run_bound: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  call_id: string;
  ok: boolean;
  content: unknown;
}

/** The stage-1 typed changes minus acknowledge_finding: only an analyst's explicit click acknowledges a finding. */
export type CopilotChange = Exclude<TypedChange, { kind: "acknowledge_finding" }>;

export type CopilotScalar = string | number | boolean | null;

export interface WriteProposal {
  sheet: string;
  range: string;
  values?: CopilotScalar[][] | null;
  formulas?: string[][] | null;
  note: string;
}

export interface StepOut {
  status: "tool_calls" | "final";
  tool_calls: ToolCall[];
  text: string;
  proposed_changes: CopilotChange[];
  proposed_writes: WriteProposal[];
  notes: string[];
}

/** Exactly one of the two (StepIn._one_of in schemas.py). */
export type StepBody = { user_message: string; tool_results?: never } | { tool_results: ToolResult[]; user_message?: never };

/** Tools the pane executes in Excel (CLIENT_TOOLS in schemas.py). */
export const COPILOT_CLIENT_TOOLS = ["list_sheets", "describe_sheet", "read_range", "find", "get_selection"] as const;
export type CopilotClientTool = (typeof COPILOT_CLIENT_TOOLS)[number];

// Client tool result contents (spec section 3 table); any other shape is refused by the server.
export interface ListSheetsResult { sheets: string[] }
export interface DescribeSheetResult {
  used_range?: string | null;
  headers?: string[];
  merged?: string[];
  counts?: { formulas?: number; constants?: number; blanks?: number };
}
export interface SelectionResult {
  sheet: string;
  address: string;
  cells: number;
  values?: CopilotScalar[][];
}
export interface ReadRangeResult {
  values: CopilotScalar[][];
  formulas?: CopilotScalar[][];
  truncated?: boolean;
}
export interface FindResult {
  hits: { sheet: string; address: string; text: string }[];
  truncated?: boolean;
}

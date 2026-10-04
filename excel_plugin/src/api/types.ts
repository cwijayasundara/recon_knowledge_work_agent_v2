// Mirrors web/lib/types.ts; keep in sync.

export type TypedChange =
  | { kind: "set_sheet"; sheet: string }
  | { kind: "set_header_row"; header_row: number }
  | { kind: "set_column_binding"; field: string; column: string | null }
  | { kind: "set_item_type"; value: string; rows?: number[] | null }
  | { kind: "override_item_id"; row: number; value: string }
  | { kind: "exclude_row"; row: number; reason: string }
  | { kind: "acknowledge_finding"; code: string; row: number | null }
  | { kind: "request_recipe_revision"; instruction: string };

export interface Binding {
  field: "affiliate_id" | "affiliate_name";
  column: string | null;
  route: string | null;
  confidence: number | null;
  evidence: string;
}
export interface Question {
  id: string;
  text: string;
  options: string[];
  evidence: string;
  target: string;
}
export interface Brief {
  source: { file: string; sheet: string; header_row: number; rows_read: number; rows_emitted: number; rows_dropped: number; drop_reasons: string[] };
  bindings: Binding[];
  id_strategy: "source_id" | "derive_from_name" | "mixed";
  item_type: string;
  recipe: { kind: string; id: string | null };
  expected_findings: string[];
  questions: Question[];
  confidence: number;
  summary: string;
}
export interface Finding {
  code: string;
  severity: "error" | "warning" | "info";
  scope: string;
  row: number | null;
  source_row: number | null;
  message: string;
  requires_ack: boolean;
  acknowledged: boolean;
}
export interface Report {
  summary: string;
  findings_by_code: Record<string, number>;
  explanations: Record<string, string>;
  proposed_changes: TypedChange[];
  blocking_count: number;
  ack_required: number;
}
export interface Impact {
  violations: { rule: string; message: string }[];
  requires_rebuild: boolean;
  rows_changed: number[];
  findings_added: [string, number | null][];
  findings_removed: [string, number | null][];
  preview: { row: number; before: Record<string, string>; after: Record<string, string> }[];
  publishable_before: boolean;
  publishable_after: boolean;
}
export interface Pending {
  gate: "brief" | "findings" | "signoff";
  message: string | null;
  blocked_reasons: string[];
  allowed_actions: string[];
  artifacts?: Artifact[];
}
export interface Artifact {
  name: string;
  key: string;
  sha256: string;
  kind: string;
  bytes: number;
}
export interface Decision {
  run_id: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  actor: string;
  at: string;
}
export interface FieldResolution {
  field: string;
  column: string | null;
  route: string | null;
  score: number | null;
  decision: string;
  candidates: { column: string; score: number; route: string }[];
}
export interface Snapshot {
  run_id: string;
  sponsor_id: string;
  status: string;
  phase: string;
  upload: { key: string; name: string; sha256?: string };
  fingerprint?: string;
  brief: Brief | null;
  bindings: Record<string, string | null> | null;
  binding_routes?: Record<string, string | null>;
  layout: { sheet: string; header_row: number } | null;
  resolution: { headers: string[]; fields: Record<string, FieldResolution> } | null;
  options: {
    item_type: string | null;
    row_item_types: Record<string, string>;
    id_overrides: Record<string, string>;
    excluded_rows: Record<string, string>;
    acknowledged: [string, number | null][];
  };
  result: { rows_emitted: number; rows_dropped: number; findings_by_code: Record<string, number>; errors: number; ack_required: number; publishable: boolean; findings: Finding[] } | null;
  report: Report | null;
  proposal: { restated: string; applicable: boolean; changes: TypedChange[]; impact: Impact | null } | null;
  gate_message: string | null;
  artifacts: Artifact[];
  approvers: { gate: string; actor: string; at: string }[];
  replay: boolean;
  error: string | null;
  pending: Pending | null;
  working: boolean;
  job_error: string | null;
  decisions: Decision[];
}
export interface GridRow {
  row: number;
  ITEM_ID: string;
  NAME: string;
  ITEM_TYPE: string;
  DESCRIPTION: string;
  DONOTIMPORT: string;
  id_method: "direct" | "derived" | "override";
  source_sheet: string;
  source_row: number;
  source_id: string | null;
  source_name: string | null;
  flags: string[];
  derivation: [string, "keep" | "strip" | "cut" | "ruler"][] | null;
  lineage: Record<string, { rule_id: string; operation: string; source_sheet: string | null; source_row: number | null; source_field: string | null; source_column: string | null }>;
}

export interface GateBody {
  action: "approve" | "answer" | "change" | "instruct" | "reject";
  question_id?: string;
  option?: string;
  changes?: TypedChange[];
  text?: string;
  reason?: string;
}
export interface SourceGrid {
  sheet: string;
  header_row: number | null;
  total: number;
  rows: { row: number; cells: string[] }[];
}
export interface PreviewGrid {
  total: number;
  rows: GridRow[];
  item_id_limit: number;
}

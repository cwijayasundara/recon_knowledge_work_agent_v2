import type { Snapshot } from "../../src/api/types";

export function fakeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    run_id: "r1",
    sponsor_id: "sponsor-a",
    status: "running",
    phase: "brief",
    upload: { key: "uploads/r1", name: "affiliates.xlsx" },
    brief: null,
    bindings: null,
    layout: null,
    resolution: null,
    options: { item_type: null, row_item_types: {}, id_overrides: {}, excluded_rows: {}, acknowledged: [] },
    result: null,
    report: null,
    proposal: null,
    gate_message: null,
    artifacts: [],
    approvers: [],
    replay: false,
    error: null,
    pending: null,
    working: false,
    job_error: null,
    decisions: [],
    ...over,
  };
}

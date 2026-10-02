import type { Snapshot } from "./types";

export type PhaseState = { cls: "done" | "you" | "block" | "wait"; label: string };

const passed = (s: Snapshot, gate: string) => s.approvers?.some((a) => a.gate === gate);

export function phaseState(id: string, s: Snapshot | null): PhaseState {
  if (!s) return { cls: "wait", label: "Loading" };
  const gate = s.pending?.gate;
  const r = s.result;
  const errors = r?.findings.filter((f) => f.severity === "error").length ?? 0;
  const warns = r?.findings.filter((f) => f.severity === "warning" && !f.acknowledged).length ?? 0;
  const collisions = r?.findings.filter((f) => f.code.includes("DUPLICATE") || f.code.includes("COLLISION")).length ?? 0;
  switch (id) {
    case "p1":
      if (gate === "brief") return { cls: "you", label: s.brief?.questions.length ? `${s.brief.questions.length} question` : "Confirm columns" };
      if (s.replay) return { cls: "done", label: "Recalled from history" };
      if (passed(s, "brief")) return { cls: "done", label: "Done" };
      return { cls: "wait", label: s.working ? "Agent working" : "Waiting" };
    case "p2":
      if (!r) return { cls: "wait", label: "Opens after the Phase 1 gate" };
      if (collisions) return { cls: "block", label: `${collisions} collision${collisions > 1 ? "s" : ""}` };
      return { cls: "done", label: "No collisions" };
    case "p3":
      if (!r) return { cls: "wait", label: "Opens after the Phase 1 gate" };
      if (passed(s, "findings") && gate !== "findings") return { cls: "done", label: "Gate passed" };
      if (errors) return { cls: "block", label: `${errors} ERR · ${warns} WARN` };
      if (warns) return { cls: "you", label: `${warns} WARN to acknowledge` };
      return { cls: "you", label: "Ready to pass" };
    case "p4":
      if (s.status === "locked") return { cls: "done", label: "Generated · locked" };
      if (gate === "signoff") return { cls: "you", label: "Sign off" };
      return { cls: "wait", label: "Opens after the Phase 3 gate" };
  }
  return { cls: "wait", label: "" };
}

export function activePhase(s: Snapshot | null): number {
  if (!s) return 1;
  if (s.status === "locked" || s.pending?.gate === "signoff") return 4;
  if (s.pending?.gate === "findings") return s.result?.findings.some((f) => f.code.includes("DUPLICATE") || f.code.includes("COLLISION")) ? 2 : 3;
  return 1;
}

export const ROUTE_LABEL: Record<string, string> = {
  history: "history",
  ontology_exact: "ontology alias",
  fuzzy: "fuzzy",
  embedding: "embedding",
  llm: "llm",
  human_approved: "analyst",
  agent: "agent",
  analyst: "analyst",
};

export type GateState = { cls: "done" | "you" | "wait"; label: string };

const GATE_NAME: Record<string, string> = { brief: "Brief gate", findings: "Findings gate", signoff: "Sign-off gate" };

export function gateName(gate: string): string {
  return GATE_NAME[gate] ?? `${gate} gate`;
}

export function gateState(gate: string, s: Snapshot | null): GateState {
  if (!s) return { cls: "wait", label: "Waiting" };
  if (s.pending?.gate === gate) return { cls: "you", label: "Waiting for you" };
  const approval = s.approvers?.find((a) => a.gate === gate);
  if (approval) return { cls: "done", label: `Passed · ${approval.actor}` };
  // A replayed run recalls its column choices, so the brief gate never opens.
  if (gate === "brief" && s.replay && s.result) return { cls: "done", label: "Skipped · recalled" };
  return { cls: "wait", label: "Not reached" };
}

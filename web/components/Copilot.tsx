"use client";

import { forwardRef, useState } from "react";
import { ROUTE_LABEL } from "@/lib/phases";
import type { Snapshot, TypedChange } from "@/lib/types";

function describe(c: TypedChange): string {
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

export const Copilot = forwardRef<HTMLInputElement, {
  snap: Snapshot | null;
  activity: string[];
  busy: boolean;
  onRespond: (body: Record<string, unknown>) => void;
}>(function Copilot({ snap, activity, busy, onRespond }, composerRef) {
  const [text, setText] = useState("");
  const gate = snap?.pending?.gate;
  const brief = snap?.brief;
  const proposal = snap?.proposal;
  const canInstruct = gate === "brief" || gate === "findings";
  return (
    <aside className="cop" aria-label="Copilot">
      <div className="cop-h"><h2>Copilot</h2><span className="grow" /><span className="who agent">Agent</span></div>
      <div className="cop-b" aria-live="polite">
        <div className="ticker">{busy && <span className="spin" aria-hidden="true" />}<span>{busy ? activity.at(-1) ?? "Working…" : gate ? `Waiting for you at the ${gate} gate` : snap?.status ?? "Loading"}</span></div>
        {snap?.gate_message && <div className="msg" role="status">{snap.gate_message}</div>}
        {snap?.error && <div className="msg" role="alert">{snap.error}</div>}
        {brief && gate === "brief" && (
          <div className="card" data-testid="brief-card">
            <div className="ct"><span>Brief · Phase 1</span><span>confidence {Math.round(brief.confidence * 100)}%</span></div>
            <p>{brief.summary}</p>
            <p className="sd">Sheet <b>{brief.source.sheet}</b>, header row {brief.source.header_row}, {brief.source.rows_emitted} rows · recipe {brief.recipe.kind} · IDs: {brief.id_strategy.replaceAll("_", " ")}</p>
            {brief.bindings.map((b) => <p key={b.field} className="sd">{b.field} ← <b>{b.column ?? "none (derive)"}</b> <span className="tag prov">{ROUTE_LABEL[b.route ?? ""] ?? b.route ?? "—"}</span></p>)}
            {brief.expected_findings.length > 0 && <p className="sd">Expected flags: {brief.expected_findings.join(", ")}</p>}
          </div>
        )}
        {brief?.questions.map((q) => (
          <div className="card" key={q.id} data-testid="question-card">
            <div className="ct"><span>Question</span><span>{q.target}</span></div>
            <p>{q.text}</p>
            {q.evidence && <p className="sd">{q.evidence}</p>}
            <div className="acts">
              {q.options.map((o) => <button key={o} className="btn pri" disabled={busy || gate !== "brief"} onClick={() => onRespond({ action: "answer", question_id: q.id, option: o })}>{o}</button>)}
            </div>
          </div>
        ))}
        {snap?.report && gate === "findings" && (
          <div className="card">
            <div className="ct"><span>Explanation · Phase 3</span></div>
            <p>{snap.report.summary}</p>
          </div>
        )}
        {proposal && gate === "findings" && (
          <div className="card chg" data-testid="change-card">
            <div className="ct"><span>Change proposal</span><span>{proposal.applicable ? `${proposal.changes.length} change(s)` : "nothing to apply"}</span></div>
            <p>{proposal.restated}</p>
            {proposal.changes.map((c, i) => <p key={i} className="sd">• {describe(c)}</p>)}
            {proposal.impact && (
              <p className="sd">Rows changed: {proposal.impact.rows_changed.join(", ") || "none"} · <span className="minus">−{proposal.impact.findings_removed.length} flags</span> · +{proposal.impact.findings_added.length} flags</p>
            )}
            {proposal.applicable && (
              <div className="acts">
                <button className="btn ok" disabled={busy} onClick={() => onRespond({ action: "change", changes: proposal.changes })}>Apply</button>
              </div>
            )}
          </div>
        )}
        {snap?.status === "locked" && <div className="saved">Run locked. Affiliates.csv, review.xlsx and manifest.json are ready.</div>}
      </div>
      <form className="comp" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onRespond({ action: "instruct", text });
        setText("");
      }}>
        <label className="sr" htmlFor="composer">Tell the agent</label>
        <input id="composer" ref={composerRef} placeholder={canInstruct ? "Tell the agent…" : "The agent listens at the brief and findings gates"} value={text} onChange={(e) => setText(e.target.value)} disabled={!canInstruct || busy} />
        <button className="btn pri" disabled={!canInstruct || busy || !text.trim()}>Send</button>
      </form>
    </aside>
  );
});

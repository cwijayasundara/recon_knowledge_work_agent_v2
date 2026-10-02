import { Fragment } from "react";
import { gateName, gateState, phaseState } from "@/lib/phases";
import type { Flow, Snapshot } from "@/lib/types";

const MARK = { done: "✓", you: "●", block: "!", wait: "" } as const;

/** The run's phases and approval gates, left to right, with the current stage marked. */
export function WorkflowDiagram({ flow, snap, current, shown, onSelect }: {
  flow: Flow;
  snap: Snapshot;
  current: number;
  shown: number;
  onSelect: (phase: number) => void;
}) {
  const locked = snap.status === "locked";
  return (
    <nav className="box wf-box" aria-label="Workflow">
      <h3>Workflow</h3>
      <ol className="wf">
        {flow.phases.map((p, i) => {
          const n = i + 1;
          const st = phaseState(p.id, snap);
          const here = n === current && !locked;
          const gate = p.gate ? gateState(p.gate, snap) : null;
          return (
            <Fragment key={p.id}>
              {i > 0 && !flow.phases[i - 1].gate && <li className="wf-link" aria-hidden="true" />}
              <li className="wf-item">
                <button
                  type="button"
                  className={`wf-node ${p.id} ${st.cls}${here ? " here" : ""}${n === shown ? " shown" : ""}`}
                  aria-current={here ? "step" : undefined}
                  onClick={() => onSelect(n)}
                  data-testid={`wf-node-${p.id}`}
                >
                  <span className="wf-n">Phase {n}{MARK[st.cls] && <span className={`wf-mark ${st.cls}`} aria-hidden="true">{MARK[st.cls]}</span>}</span>
                  <span className="wf-name">{p.name}</span>
                  <span className={`state ${st.cls}`} data-testid={`phase-state-${p.id}`}>{st.label}</span>
                  {here && <span className="wf-here">You are here</span>}
                </button>
              </li>
              {p.gate && gate && (
                <li className={`wf-gate ${gate.cls}`} data-testid={`wf-gate-${p.gate}`}>
                  <span className="wf-diamond" aria-hidden="true"><i>{gate.cls === "done" ? "✓" : gate.cls === "you" ? "!" : ""}</i></span>
                  <span className="wf-gname">{gateName(p.gate)}</span>
                  <span className="wf-glabel">{gate.label}</span>
                </li>
              )}
            </Fragment>
          );
        })}
        {locked && <li className="wf-end" aria-label="Run locked">🔒 Locked</li>}
      </ol>
    </nav>
  );
}

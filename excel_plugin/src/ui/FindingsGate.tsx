import type { Snapshot } from "../api/types";
import { blockedReasons, canApprove } from "../state/gates";

export interface FindingsGateProps {
  snap: Snapshot;
  busy: boolean;
  onApprove: () => void;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The findings gate: shown whenever the run waits there, even with zero findings. */
export function FindingsGate({ snap, busy, onApprove }: FindingsGateProps) {
  const result = snap.result;
  const warnings = result?.findings.filter((f) => f.severity === "warning").length ?? 0;
  const reasons = blockedReasons(snap);
  const enabled = canApprove(snap, busy);
  return (
    <section class="card findings-gate" data-testid="findings-gate">
      <h2>Findings gate</h2>
      <p data-testid="findings-summary">
        {`${count(result?.errors ?? 0, "error", "errors")}, ${count(warnings, "warning", "warnings")}, ${count(result?.ack_required ?? 0, "acknowledgement", "acknowledgements")} required`}
      </p>
      <button type="button" data-testid="findings-approve" disabled={!enabled} onClick={() => { if (enabled) onApprove(); }}>
        Approve findings
      </button>
      {reasons.length > 0 ? (
        <ul class="blocked" data-testid="findings-blocked-reasons">
          {reasons.map((r, i) => (
            <li key={`${i}-${r}`}>{r}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

import type { Decision } from "@/lib/types";

const TONE = (d: Decision) => (d.actor === "system" ? "sys" : d.kind === "run.locked" ? "out" : "ana");

export function DecisionLedger({ decisions, pending }: { decisions: Decision[]; pending?: string | null }) {
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(decisions, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "decisions.json";
    a.click();
  };
  return (
    <section className="ledger" aria-labelledby="ledger-h">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 id="ledger-h">Decision ledger</h2>
        <span className="grow" style={{ flex: 1 }} />
        <button className="btn" onClick={exportJson} disabled={!decisions.length}>Export</button>
      </div>
      <div className="tl" data-testid="ledger">
        {decisions.map((d) => {
          const payload = d.payload as { changes?: unknown[]; option?: string; text?: string };
          return (
            <div key={d.seq} className={`ev ${TONE(d)}`}>
              <span className="tm">{d.at.slice(11, 19)}</span>
              <b>{d.kind}</b>
              <span>{d.actor}</span>
              {payload.changes && payload.changes.length > 0 && <span className="sd">{payload.changes.length} change(s)</span>}
              {payload.option && <span className="sd">answered “{payload.option}”</span>}
              {payload.text && <span className="sd">“{payload.text}”</span>}
            </div>
          );
        })}
        {pending && <div className="ev open"><span className="tm">now</span><b>{pending} gate</b><span>waiting for you</span></div>}
        {!decisions.length && !pending && <p className="note">Decisions appear here as they are made.</p>}
      </div>
    </section>
  );
}

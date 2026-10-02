"use client";

import type { Finding, Report, TypedChange } from "@/lib/types";

export function DqPanel({ findings, report, enabled, active, onChange, onEdit }: {
  findings: Finding[];
  report: Report | null;
  enabled: boolean;
  active: number;
  onChange: (changes: TypedChange[]) => void;
  onEdit: (row: number) => void;
}) {
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warning");
  const pending = (code: string) => warns.filter((w) => w.code === code && !w.acknowledged);
  const flag = (f: Finding, i: number, kind: "err" | "warn") => (
    <div className={`flag${active === i ? " active" : ""}`} key={`${f.code}-${f.row}`} data-flag={i}>
      <span className={`pillf ${kind}`}>{kind.toUpperCase()}</span>
      <span>
        {f.message}
        <span className="rows">{f.row ? `Row ${f.row}${f.source_row ? ` (sheet row ${f.source_row})` : ""}` : "Whole file"} · <span className="mono">{f.code}</span></span>
        {report?.explanations[f.code] && <span className="rows">{report.explanations[f.code]}</span>}
      </span>
      <span className="acts">
        {kind === "err" && f.row && (
          <>
            <button className="btn" disabled={!enabled} onClick={() => onEdit(f.row!)}>Edit ID</button>
            <button className="btn" disabled={!enabled} onClick={() => onChange([{ kind: "exclude_row", row: f.row!, reason: `excluded to resolve ${f.code}` }])}>Exclude row</button>
          </>
        )}
        {kind === "warn" && (f.acknowledged ? <span className="state done">Acknowledged</span> : (
          <>
            <button className="btn" disabled={!enabled} onClick={() => onChange([{ kind: "acknowledge_finding", code: f.code, row: f.row }])}>Acknowledge</button>
            {pending(f.code).length > 1 && (
              <button className="btn" disabled={!enabled} onClick={() => onChange(pending(f.code).map((w) => ({ kind: "acknowledge_finding", code: w.code, row: w.row })))}>All {pending(f.code).length}</button>
            )}
          </>
        ))}
      </span>
    </div>
  );
  return (
    <div className="dq" data-testid="dq-panel">
      <div className="bar err">ERR — blocks transformation (must resolve before proceeding)</div>
      {errors.length ? errors.map((f, i) => flag(f, i, "err")) : <div className="flag"><span /><span className="sd">No errors.</span><span /></div>}
      <div className="bar warn">WARN — non-blocking · analyst must acknowledge</div>
      {warns.length ? warns.map((f, i) => flag(f, errors.length + i, "warn")) : <div className="flag"><span /><span className="sd">No warnings.</span><span /></div>}
    </div>
  );
}

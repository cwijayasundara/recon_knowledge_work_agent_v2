import type { Brief } from "../api/types";

export interface BriefCardProps {
  brief: Brief;
  busy: boolean;
  canApprove: boolean;
  blockedReasons?: string[];
  headers?: string[];
  onApprove: () => void;
  onColumn: (field: string, column: string | null) => void;
  onShowColumn?: (column: string) => void;
  onUseSelected?: (field: string) => void;
}

const pct = (c: number | null): string => (c === null ? "n/a" : `${Math.round(c * 100)}%`);

export function BriefCard({ brief, busy, canApprove, blockedReasons = [], headers, onApprove, onColumn, onShowColumn, onUseSelected }: BriefCardProps) {
  return (
    <section class="card brief-card" data-testid="brief-card">
      <h2>Brief</h2>
      <p>{brief.summary}</p>
      <p class="note">{`${brief.source.sheet}, header row ${brief.source.header_row}: ${brief.source.rows_read} rows read, ${brief.source.rows_emitted} emitted`}</p>
      <ul class="bindings">
        {brief.bindings.map((b) => (
          <li key={b.field}>
            <strong>{b.field}</strong>
            {" → "}
            {headers && headers.length > 0 ? (
              <select
                aria-label={`Column for ${b.field}`}
                value={b.column ?? ""}
                disabled={busy}
                onChange={(e) => { if (!busy) onColumn(b.field, e.currentTarget.value || null); }}
              >
                <option value="">(none)</option>
                {b.column && !headers.includes(b.column) ? <option value={b.column}>{b.column}</option> : null}
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            ) : (
              <span>{b.column ?? "(none)"}</span>
            )}
            {` (${pct(b.confidence)})`}
            {onShowColumn && b.column ? (
              <button type="button" class="show-in-sheet" onClick={() => onShowColumn(b.column as string)}>
                Show in sheet
              </button>
            ) : null}
            {onUseSelected ? (
              <button type="button" class="use-selected" disabled={busy} onClick={() => { if (!busy) onUseSelected(b.field); }}>
                Use selected column
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {brief.expected_findings.length > 0 ? (
        <p>Expected findings: {brief.expected_findings.join(", ")}</p>
      ) : null}
      <button type="button" data-testid="approve-brief" disabled={busy || !canApprove} onClick={() => { if (!busy && canApprove) onApprove(); }}>
        Approve brief
      </button>
      {blockedReasons.length > 0 ? (
        <ul class="blocked" data-testid="blocked-reasons">
          {blockedReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

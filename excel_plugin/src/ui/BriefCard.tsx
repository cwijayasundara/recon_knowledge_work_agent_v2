import { useEffect, useRef, useState } from "preact/hooks";
import type { Binding, Brief } from "../api/types";
import { QuestionCard } from "./QuestionCard";

export interface BriefCardProps {
  brief: Brief;
  busy: boolean;
  canApprove: boolean;
  blockedReasons?: string[];
  headers?: string[];
  onApprove: () => void;
  onAnswer?: (questionId: string, option: string) => void;
  /** Posts one set_column_binding; called only from an explicit "Apply change" click. */
  onColumn: (field: string, column: string | null) => void;
  onShowColumn?: (column: string) => void;
  /** Reads the user's Excel selection; resolves to its header (to stage) or null when it cannot be used. */
  onUseSelected?: (field: string) => Promise<string | null>;
}

const FIELD_LABELS: Record<string, string> = { affiliate_id: "Affiliate ID", affiliate_name: "Affiliate Name" };
export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

export const UNAPPLIED_HINT = "You have an unapplied mapping change. Apply it or discard it before approving.";

const pct = (c: number | null): string | null => (c === null ? null : `${Math.round(c * 100)}%`);

/** A picked column, tied to the server column it was picked against: once the server's binding moves, it is void. */
interface Staged { base: string | null; value: string | null }

export function BriefCard({ brief, busy, canApprove, blockedReasons = [], headers, onApprove, onAnswer, onColumn, onShowColumn, onUseSelected }: BriefCardProps) {
  const { source } = brief;
  const [staged, setStaged] = useState<Record<string, Staged>>({});
  const pendingOf = (b: Binding): string | null | undefined => {
    const s = staged[b.field];
    return s && s.base === b.column && s.value !== b.column ? s.value : undefined;
  };
  const unapplied = brief.bindings.some((b) => pendingOf(b) !== undefined);
  const stage = (b: Binding, value: string | null) => setStaged((prev) => ({ ...prev, [b.field]: { base: b.column, value } }));

  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (unapplied && details.current) details.current.open = true;
  }, [unapplied]);

  const approvable = canApprove && !unapplied;
  return (
    <section class="card brief-card" data-testid="brief-card">
      <h2>Brief</h2>
      <p>{brief.summary}</p>
      <button type="button" class="primary" data-testid="approve-brief" disabled={busy || !approvable} onClick={() => { if (!busy && approvable) onApprove(); }}>
        Approve brief
      </button>
      {unapplied ? (
        <div class="unapplied" data-testid="unapplied-hint">
          <p role="status">{UNAPPLIED_HINT}</p>
          <button type="button" class="secondary" data-testid="discard-change" disabled={busy} onClick={() => { if (!busy) setStaged({}); }}>
            Discard change
          </button>
        </div>
      ) : null}
      {blockedReasons.length > 0 ? (
        <ul class="blocked" data-testid="blocked-reasons">
          {blockedReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {brief.questions.length > 0 ? (
        <div class="needs-input" data-testid="needs-input">
          <h3>Needs your input</h3>
          {brief.questions.map((q) => (
            <QuestionCard key={q.id} question={q} busy={busy} onAnswer={(option) => onAnswer?.(q.id, option)} />
          ))}
        </div>
      ) : null}
      <h3>Mapping</h3>
      <ul class="bindings" data-testid="bindings">
        {brief.bindings.map((b) => {
          const c = pct(b.confidence);
          return (
            <li key={b.field} data-testid={`binding-${b.field}`}>
              <strong>{fieldLabel(b.field)}</strong>
              {b.column === null ? " ← no column" : ` ← column "${b.column}"`}
              {c !== null ? <span class="note">{` · ${c}`}</span> : null}
            </li>
          );
        })}
      </ul>
      <p class="note" data-testid="brief-layout">{`${source.sheet}, header row ${source.header_row}: ${source.rows_read} rows read, ${source.rows_emitted} emitted`}</p>
      {source.rows_dropped > 0 ? (
        <p class="note" data-testid="brief-dropped">
          {`${source.rows_dropped} dropped${source.drop_reasons.length > 0 ? `: ${source.drop_reasons.join("; ")}` : ""}`}
        </p>
      ) : null}
      {brief.expected_findings.length > 0 ? (
        <p class="note">Expected findings: {brief.expected_findings.join(", ")}</p>
      ) : null}
      <details class="overrides" data-testid="change-mapping" ref={details}>
        <summary>Change mapping</summary>
        {brief.bindings.map((b) => (
          <BindingOverride
            key={b.field}
            binding={b}
            pending={pendingOf(b)}
            busy={busy}
            headers={headers}
            onStage={(value) => stage(b, value)}
            onColumn={onColumn}
            onShowColumn={onShowColumn}
            onUseSelected={onUseSelected}
          />
        ))}
      </details>
    </section>
  );
}

interface BindingOverrideProps {
  binding: Binding;
  /** The picked column when it differs from the server's binding; undefined when nothing is pending. */
  pending: string | null | undefined;
  busy: boolean;
  headers?: string[];
  onStage: (value: string | null) => void;
  onColumn: (field: string, column: string | null) => void;
  onShowColumn?: (column: string) => void;
  onUseSelected?: (field: string) => Promise<string | null>;
}

function BindingOverride({ binding: b, pending, busy, headers, onStage, onColumn, onShowColumn, onUseSelected }: BindingOverrideProps) {
  const label = fieldLabel(b.field);
  const changed = pending !== undefined;
  const current = changed ? pending : b.column;
  const extra = [b.column, pending].filter((v): v is string => typeof v === "string" && v !== "" && !(headers ?? []).includes(v));
  return (
    <fieldset class="override" data-testid={`override-${b.field}`}>
      <legend>{label}</legend>
      {headers && headers.length > 0 ? (
        <select
          aria-label={`Column for ${label}`}
          value={current ?? ""}
          disabled={busy}
          onChange={(e) => { if (!busy) onStage(e.currentTarget.value || null); }}
        >
          <option value="">(none)</option>
          {[...new Set(extra)].map((h) => (
            <option key={`extra-${h}`} value={h}>{h}</option>
          ))}
          {headers.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
      ) : (
        <p class="note">{`Column: ${current ?? "(none)"}`}</p>
      )}
      <div class="override-actions">
        {onShowColumn && b.column ? (
          <button type="button" class="secondary" onClick={() => onShowColumn(b.column as string)}>
            Show in sheet
          </button>
        ) : null}
        {onUseSelected ? (
          <button
            type="button"
            class="secondary"
            disabled={busy}
            onClick={() => {
              if (busy) return;
              void onUseSelected(b.field).then((header) => { if (header !== null) onStage(header); });
            }}
          >
            Use selected column
          </button>
        ) : null}
        <button
          type="button"
          class="secondary"
          data-testid={`apply-${b.field}`}
          disabled={busy || !changed}
          onClick={() => { if (!busy && changed) onColumn(b.field, pending); }}
        >
          Apply change
        </button>
      </div>
      {changed ? <p class="note" role="status">{`Not applied yet: ${label} ← ${pending === null ? "no column" : `"${pending}"`}`}</p> : null}
    </fieldset>
  );
}

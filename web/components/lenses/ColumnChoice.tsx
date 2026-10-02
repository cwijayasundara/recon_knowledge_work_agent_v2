"use client";

import { useState } from "react";
import { ROUTE_LABEL } from "@/lib/phases";
import type { Snapshot } from "@/lib/types";

/** The document's column selection list: suggested column, derive-from-name (ID only), other column. */
export function ColumnChoice({ snap, field, enabled, onChange }: {
  snap: Snapshot;
  field: "affiliate_id" | "affiliate_name";
  enabled: boolean;
  onChange: (column: string | null) => void;
}) {
  const binding = snap.brief?.bindings.find((b) => b.field === field);
  const res = snap.resolution?.fields[field];
  const headers = snap.resolution?.headers ?? [];
  const chosen = binding?.column ?? null;
  const [other, setOther] = useState(false);
  const label = field === "affiliate_id" ? "Affiliate ID" : "Affiliate Name";
  const suggestions = [chosen, ...(res?.candidates ?? []).map((c) => c.column)].filter((c, i, a): c is string => !!c && a.indexOf(c) === i).slice(0, 3);
  const provenance = (column: string) => {
    if (column === chosen && binding?.route) return `${ROUTE_LABEL[binding.route] ?? binding.route}${binding.confidence ? ` · ${binding.confidence.toFixed(2)}` : ""}`;
    const c = res?.candidates.find((x) => x.column === column);
    return c ? `${ROUTE_LABEL[c.route] ?? c.route} ${c.score.toFixed(2)}` : "";
  };
  return (
    <div className="optlist" role="radiogroup" aria-label={`Column for ${label}`}>
      <div className="q">
        Select the column for {label} <span>— system highlights best candidate · analyst confirms or overrides</span>
      </div>
      {suggestions.map((column) => (
        <button key={column} className="opt" role="radio" aria-checked={column === chosen} disabled={!enabled} onClick={() => column !== chosen && onChange(column)}>
          <span className="r" />
          <span>{column} <span className="evd">· {provenance(column)}</span>{column === chosen && binding?.evidence && <span className="evd"> — {binding.evidence}</span>}</span>
          {column === chosen ? <span className="tag sug">Suggested</span> : <span />}
        </button>
      ))}
      {field === "affiliate_id" && (
        <button className="opt" role="radio" aria-checked={chosen === null} disabled={!enabled} onClick={() => chosen !== null && onChange(null)}>
          <span className="r" />
          <span>Affiliate Name <span className="evd">(use if no ID column — system will derive ID from name)</span></span>
          {chosen === null ? <span className="tag sug">Suggested</span> : <span />}
        </button>
      )}
      <button className="opt" role="radio" aria-checked={false} disabled={!enabled} onClick={() => setOther((v) => !v)}>
        <span className="r" />
        <span><i>Other column…</i></span>
        <span className="tag man">Manual</span>
      </button>
      {other && (
        <label className="field">
          View all columns in this file
          <select className="inline" defaultValue="" onChange={(e) => e.target.value && onChange(e.target.value)} disabled={!enabled}>
            <option value="" disabled>Choose a column</option>
            {headers.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

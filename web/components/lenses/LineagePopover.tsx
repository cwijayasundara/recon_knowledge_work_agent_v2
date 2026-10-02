"use client";

import { useState } from "react";
import type { Decision, GridRow } from "@/lib/types";

export function LineageCell({ row, column, decisions }: { row: GridRow; column: keyof GridRow & string; decisions: Decision[] }) {
  const [open, setOpen] = useState(false);
  const trace = row.lineage[column];
  const value = String(row[column] ?? "");
  const last = [...decisions].reverse().find((d) => JSON.stringify(d.payload).includes(`"row": ${row.row}`) || JSON.stringify(d.payload).includes(`"row":${row.row}`));
  return (
    <span style={{ position: "relative" }}>
      <button className="cell-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Lineage for ${column} row ${row.row}`}>
        {value || <span style={{ color: "var(--muted)" }}>∅</span>}
      </button>
      {open && trace && (
        <dl className="pop" role="dialog" aria-label="Cell lineage" onClick={() => setOpen(false)}>
          <dt>Rule</dt><dd>{trace.rule_id}</dd>
          <dt>Operation</dt><dd>{trace.operation}</dd>
          {trace.source_row && (<><dt>Source</dt><dd>{trace.source_sheet} · row {trace.source_row}{trace.source_column ? ` · ${trace.source_column}` : ""}</dd></>)}
          <dt>Last decision</dt><dd>{last ? `${last.kind} by ${last.actor}` : "none"}</dd>
        </dl>
      )}
    </span>
  );
}

"use client";

import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { GridRow, Impact, TypedChange } from "@/lib/types";
import { DerivationDiff } from "./DerivationDiff";

const col = createColumnHelper<GridRow>();
export const shortCode = (code: string) => code.replace(/^AFF_(ERR|WARN|INFO)_/, "").replace(/^ITEM_ID_/, "");
const METHOD: Record<string, string> = { direct: "source", derived: "derived", override: "override" };

function IdEditor({ runId, row, onApply, onCancel }: { runId: string; row: GridRow; onApply: (c: TypedChange) => void; onCancel: () => void }) {
  const [value, setValue] = useState(row.ITEM_ID);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!value.trim()) return setCheck({ ok: false, text: "ITEM_ID cannot be blank" });
      try {
        const impact: Impact = await api.dryRun(runId, [{ kind: "override_item_id", row: row.row, value }]);
        setCheck(impact.violations.length
          ? { ok: false, text: impact.violations.map((v) => v.message).join("; ") }
          : { ok: true, text: `✓ ${value.length} chars · valid · unique${impact.findings_removed.length ? ` · clears ${impact.findings_removed.length} flag(s)` : ""}` });
      } catch (e) {
        setCheck({ ok: false, text: (e as Error).message });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [value, runId, row.row]);
  return (
    <span className="edit">
      <label className="sr" htmlFor={`ov${row.row}`}>ITEM_ID for row {row.row}</label>
      <input
        id={`ov${row.row}`}
        value={value}
        aria-describedby={`h${row.row}`}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter" && check?.ok) onApply({ kind: "override_item_id", row: row.row, value });
          if (e.key === "Escape") onCancel();
        }}
      />
      <span id={`h${row.row}`} className={check?.ok ? "hint" : "err-text"}>{check?.text ?? " "}</span>
      <span className="acts" style={{ marginTop: 4 }}>
        <button className="btn ok" disabled={!check?.ok} onClick={() => onApply({ kind: "override_item_id", row: row.row, value })}>Apply ID</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </span>
    </span>
  );
}

export function IdPreviewGrid({ runId, rows, editable, selected, onSelect, editing, setEditing, onApply }: {
  runId: string;
  rows: GridRow[];
  editable: boolean;
  selected: number | null;
  onSelect: (row: number) => void;
  editing: number | null;
  setEditing: (row: number | null) => void;
  onApply: (c: TypedChange) => void;
}) {
  // flexRender treats each cell function as a component type, so columns must be
  // stable or an open editor remounts (and loses what was typed) on every refresh.
  const live = useRef({ editing, editable, runId, onApply, setEditing });
  live.current = { editing, editable, runId, onApply, setEditing };
  const columns = useMemo(() => [
    col.accessor("row", { header: "Row", cell: (c) => c.getValue() }),
    col.accessor("source_name", { header: "Affiliate Name", cell: (c) => c.getValue() || <span style={{ color: "var(--muted)" }}>(blank)</span> }),
    col.accessor("ITEM_ID", {
      header: "ITEM_ID",
      cell: (c) => {
        const r = c.row.original;
        const { editing, editable, runId, onApply, setEditing } = live.current;
        if (editing === r.row) return <IdEditor runId={runId} row={r} onApply={(ch) => { setEditing(null); onApply(ch); }} onCancel={() => setEditing(null)} />;
        return (
          <span className="idv">
            {r.ITEM_ID || "—"}
            {r.derivation && <DerivationDiff segments={r.derivation} />}
            {r.ITEM_ID.length > 30 && <span className="deriv">{r.ITEM_ID.length} chars <span className="ruler" /> limit 30</span>}
            {editable && <button className="btn" style={{ marginLeft: 6 }} onClick={() => setEditing(r.row)} aria-label={`Edit ITEM_ID for row ${r.row}`}>Edit</button>}
          </span>
        );
      },
    }),
    col.accessor("id_method", { header: "Method", cell: (c) => <span className={`meth ${c.getValue() === "derived" ? "der" : c.getValue() === "override" ? "ovr" : ""}`}>{METHOD[c.getValue()]}</span> }),
    col.accessor("flags", {
      header: "Flags",
      cell: (c) => c.getValue().map((f) => <span key={f} className={`code ${f.includes("_ERR_") ? "err" : "warn"}`}>{shortCode(f)}</span>),
    }),
  ], []);
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <div className="tbl">
      <table data-testid="id-grid">
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>{g.headers.map((h) => <th key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</th>)}</tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => {
            const grp = r.original.flags.some((f) => f.includes("DUPLICATE") || f.includes("COLLISION"));
            return (
              <tr key={r.id} className={`${grp ? "grp" : ""} ${selected === r.original.row ? "sel" : ""}`} onClick={() => onSelect(r.original.row)}>
                {r.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={cell.column.id === "row" ? "rn" : undefined}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

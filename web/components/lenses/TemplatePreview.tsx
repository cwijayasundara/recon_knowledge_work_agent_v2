"use client";

import type { Decision, GridRow, TypedChange } from "@/lib/types";
import { LineageCell } from "./LineagePopover";

const COLUMNS = ["ITEM_ID", "NAME", "ITEM_TYPE", "DESCRIPTION", "DONOTIMPORT"] as const;

export function FinalReview({ rows, enabled, onChange }: { rows: GridRow[]; enabled: boolean; onChange: (c: TypedChange[]) => void }) {
  return (
    <div className="tbl">
      <table>
        <thead><tr><th>Row</th><th>NAME</th><th>ITEM_TYPE</th><th>DONOTIMPORT</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row}>
              <td className="rn">{r.row}</td>
              <td>{r.NAME}</td>
              <td>
                <select className="inline" aria-label={`ITEM_TYPE for row ${r.row}`} value={r.ITEM_TYPE} disabled={!enabled}
                  onChange={(e) => onChange([{ kind: "set_item_type", value: e.target.value, rows: [r.row] }])}>
                  <option>Inventory</option>
                  <option>Non-Inventory</option>
                </select>
              </td>
              <td>
                {r.DONOTIMPORT === "#" ? <span className="code warn">#  excluded</span> : (
                  <button className="btn" disabled={!enabled} onClick={() => {
                    const reason = window.prompt(`Why exclude row ${r.row}?`);
                    if (reason?.trim()) onChange([{ kind: "exclude_row", row: r.row, reason }]);
                  }}>Exclude (#)</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TemplatePreview({ rows, decisions }: { rows: GridRow[]; decisions: Decision[] }) {
  return (
    <div className="tbl">
      <table data-testid="template-preview">
        <thead><tr>{COLUMNS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row}>{COLUMNS.map((c) => <td key={c} className={c === "ITEM_ID" ? "idv" : undefined}><LineageCell row={r} column={c} decisions={decisions} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

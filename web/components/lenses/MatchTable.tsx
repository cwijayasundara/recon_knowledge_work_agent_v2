import type { Snapshot } from "@/lib/types";

export function MatchTable({ snap }: { snap: Snapshot }) {
  const name = snap.bindings?.affiliate_name ?? "Affiliate Name";
  const itemType = snap.options.item_type ?? "Inventory";
  const rows: [string, string, string][] = [
    ["ITEM_ID", "Req", "From Phase 2 (inherited or derived, ≤30)"],
    ["NAME", "Req", `${name} (≤100)`],
    ["ITEM_TYPE", "Req", `'${itemType}'`],
    ["DESCRIPTION", "No", "Blank"],
    ["DONOTIMPORT", "No", "Blank or '#'"],
  ];
  return (
    <div className="tbl">
      <table style={{ minWidth: 0 }}>
        <thead><tr><th>Intacct field</th><th>Req?</th><th>Source / logic</th><th>Conf</th><th>Act</th></tr></thead>
        <tbody>
          {rows.map(([f, req, logic]) => (
            <tr key={f}><td className="mono">{f}</td><td>{req}</td><td>{logic}</td><td style={{ color: "var(--out)" }}>● High</td><td>✓ Auto</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

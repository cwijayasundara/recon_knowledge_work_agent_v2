export function GateBar({ label, conditions, reasons, enabled, busy, action, onPass, testId }: {
  label: string;
  conditions: string;
  reasons: string[];
  enabled: boolean;
  busy: boolean;
  action: string;
  onPass: () => void;
  testId: string;
}) {
  const blocked = reasons.length > 0;
  return (
    <div className="gatebar">
      <span><b>{label}</b> — {conditions}</span>
      <span className="grow" />
      <button className="btn ok" data-testid={testId} disabled={!enabled || blocked || busy} title={blocked ? `Still to do: ${reasons.join("; ")}` : undefined} onClick={onPass}>
        {busy ? "Working…" : action}
      </button>
      {enabled && blocked && <span className="sd" style={{ flexBasis: "100%" }}>Still to do: {reasons.slice(0, 4).join("; ")}{reasons.length > 4 ? ` and ${reasons.length - 4} more` : ""}</span>}
    </div>
  );
}

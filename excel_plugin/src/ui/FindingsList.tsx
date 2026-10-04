import { useState } from "preact/hooks";
import type { Finding } from "../api/types";

export interface FindingsListProps {
  findings: Finding[];
  busy: boolean;
  /** False when the pending gate does not offer "change": Acknowledge and Exclude are then unavailable. */
  canChange: boolean;
  onAck: (f: Finding) => void;
  /** Resolves true when the gate accepted the exclusion; false keeps the reason for a retry. */
  onExclude: (f: Finding, reason: string) => Promise<boolean>;
  /** Resolves to a message when a jump failed, null when it worked. */
  onJump: (f: Finding) => Promise<string | null>;
}

const ORDER: Record<Finding["severity"], number> = { error: 0, warning: 1, info: 2 };
/**
 * Keys by (code, row) plus the occurrence of that pair, so an open Exclude box or a note stays with its finding when
 * another finding disappears (a rebuild, another client), and two findings with the same (code, row) stay apart.
 */
function keysOf(sorted: Finding[]): string[] {
  const seen = new Map<string, number>();
  return sorted.map((f) => {
    const base = `${f.code}-${f.row ?? "none"}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}-${n}`;
  });
}

export function FindingsList({ findings, busy: working, canChange, onAck, onExclude, onJump }: FindingsListProps) {
  const busy = working || !canChange;
  const [excluding, setExcluding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const keys = keysOf(sorted);

  async function jump(f: Finding, k: string) {
    const message = await onJump(f);
    setNotes((n) => ({ ...n, [k]: message ?? "" }));
  }

  async function submit(f: Finding) {
    const text = reason.trim();
    if (text === "" || f.row === null || sending || busy) return;
    setSending(true);
    try {
      if (await onExclude(f, text)) {
        setExcluding(null);
        setReason("");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <section class="findings" data-testid="findings-list">
      <h2>Findings</h2>
      {canChange ? null : <p class="note" data-testid="findings-change-hint">Acknowledge and Exclude row are available at the findings gate.</p>}
      <ul>
        {sorted.map((f, i) => {
          const k = keys[i]!;
          const note = notes[k];
          return (
            <li key={k} class={`finding finding-${f.severity}`}>
              <strong>{f.severity === "error" ? "Error" : f.severity === "warning" ? "Warning" : "Info"}</strong>{" "}
              <span>{f.message}</span>
              <span>{f.row !== null ? ` Row ${f.row}.` : ""}</span>
              {f.source_row !== null ? (
                <>
                  {" "}
                  <button type="button" class="link" data-testid={`jump-${k}`} onClick={() => void jump(f, k)}>
                    {`Source row ${f.source_row}`}
                  </button>
                </>
              ) : null}
              {note ? <p class="note" role="status" data-testid={`jump-note-${k}`}>{note}</p> : null}
              {f.acknowledged ? (
                <span> Acknowledged</span>
              ) : f.requires_ack ? (
                <button type="button" data-testid={`ack-${f.code}-${f.row}`} disabled={busy} onClick={() => { if (!busy) onAck(f); }}>
                  Acknowledge
                </button>
              ) : null}
              {f.row !== null ? (
                excluding === k ? (
                  <span>
                    <input
                      type="text"
                      aria-label="Reason for excluding this row"
                      data-testid={`exclude-reason-${f.row}`}
                      value={reason}
                      disabled={busy || sending}
                      onInput={(e) => setReason((e.currentTarget as HTMLInputElement).value)}
                    />
                    <button
                      type="button"
                      data-testid={`exclude-confirm-${f.row}`}
                      disabled={busy || sending || reason.trim() === ""}
                      onClick={() => void submit(f)}
                    >
                      Confirm exclude
                    </button>
                    <button type="button" disabled={sending} onClick={() => { setExcluding(null); setReason(""); }}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button type="button" data-testid={`exclude-${f.row}`} disabled={busy} onClick={() => { if (!busy) { setExcluding(k); setReason(""); } }}>
                    Exclude row
                  </button>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

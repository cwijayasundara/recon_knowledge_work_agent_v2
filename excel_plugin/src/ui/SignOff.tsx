import { useRef, useState } from "preact/hooks";
import type { Artifact, Snapshot } from "../api/types";
import { blockedReasons, canApprove, pendingGate } from "../state/gates";
import { ErrorBanner } from "./ErrorBanner";

export type DownloadResult = { kind: "saved" | "browser" } | { kind: "error"; message: string; requestId?: string };

export interface SignOffProps {
  snap: Snapshot;
  busy: boolean;
  artifacts: Artifact[];
  onApprove: () => void;
  onDownload: (name: string) => Promise<DownloadResult>;
  onOpenBrowser: (name: string) => Promise<DownloadResult>;
}

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;

export function SignOff({ snap, busy, artifacts, onApprove, onDownload, onOpenBrowser }: SignOffProps) {
  const [results, setResults] = useState<Record<string, DownloadResult | null>>({});
  const [inFlight, setInFlight] = useState<Record<string, boolean>>({});
  const flying = useRef(new Set<string>());
  const atGate = pendingGate(snap) === "signoff";
  const reasons = blockedReasons(snap);

  async function run(name: string, act: (n: string) => Promise<DownloadResult>) {
    if (flying.current.has(name)) return;
    flying.current.add(name);
    setInFlight((m) => ({ ...m, [name]: true }));
    setResults((m) => ({ ...m, [name]: null }));
    try {
      const r = await act(name);
      setResults((m) => ({ ...m, [name]: r }));
    } finally {
      flying.current.delete(name);
      setInFlight((m) => ({ ...m, [name]: false }));
    }
  }

  return (
    <section class="card signoff-card" data-testid="signoff-card">
      <h2>Sign-off</h2>
      {atGate ? (
        <>
          <button type="button" data-testid="signoff-approve" disabled={!canApprove(snap, busy)} onClick={() => { if (canApprove(snap, busy)) onApprove(); }}>
            Approve sign-off
          </button>
          {reasons.length > 0 ? (
            <ul class="blocked" data-testid="blocked-reasons">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {artifacts.length > 0 ? (
        <ul class="artifacts" data-testid="artifact-list">
          {artifacts.map((a) => {
            const result = results[a.name];
            const busyNow = inFlight[a.name] === true;
            return (
              <li key={a.name}>
                <button type="button" data-testid={`download-${a.name}`} disabled={busyNow} onClick={() => void run(a.name, onDownload)}>
                  {busyNow ? "Working..." : `Download ${a.name}`}
                </button>
                <button type="button" class="secondary" data-testid={`browser-${a.name}`} disabled={busyNow} onClick={() => void run(a.name, onOpenBrowser)}>
                  Open in browser
                </button>
                <span class="note">{` ${kb(a.bytes)} (${a.bytes} bytes), sha256 ${a.sha256.slice(0, 12)}`}</span>
                {result?.kind === "error" ? <ErrorBanner message={result.message} requestId={result.requestId} /> : null}
                {result?.kind === "saved" ? (
                  <p class="note" role="status" data-testid={`note-${a.name}`}>Download started. If no file appeared, use Open in browser.</p>
                ) : null}
                {result?.kind === "browser" ? (
                  <p class="note" role="status" data-testid={`note-${a.name}`}>Opened in your browser. Check the file there against the size and sha256 shown.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

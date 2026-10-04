import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type Client } from "../api/client";
import { config } from "../config";
import { EXCEL_OP_TIMEOUT_MS, ExcelBusy, excelRun, readSelectedColumn, selectColumn, selectHeaderRow, selectSheet, selectSourceCell, withExcelTimeout, type ExcelRun } from "../office/highlight";
import { artifactUrl, downloadArtifact, officeDownloadDeps, type DownloadDeps } from "../office/download";
import { REVIEW_SHEET, removeReviewSheet, selectReviewRow } from "../office/review";
import type { Artifact, Finding } from "../api/types";
import type { WorkbookFile } from "../office/workbook";
import { blockedReasons, canApprove, canChangeFindings, gateMessage, pendingGate } from "../state/gates";
import { STALE_NOTICE, type RunStore } from "../state/store";
import { BriefCard } from "./BriefCard";
import { ChatPanel } from "./ChatPanel";
import { CopilotPanel, type CopilotWriter } from "./CopilotPanel";
import type { CopilotSession, CopilotSessionDeps } from "../copilot/session";
import { FindingsGate } from "./FindingsGate";
import { FindingsList } from "./FindingsList";
import { GateMessage } from "./GateMessage";
import { ErrorBanner } from "./ErrorBanner";
import { SignOff, type DownloadResult } from "./SignOff";
import { ReviewPanel } from "./ReviewPanel";
import { Progress } from "./Progress";
import { SponsorPicker, type Sponsor } from "./SponsorPicker";
import { useStore } from "./useStore";

export interface PaneProps {
  client: Client;
  store: RunStore;
  readFile: () => Promise<WorkbookFile>;
  apiBase?: string;
  run?: ExcelRun;
  download?: DownloadDeps;
  /** Removes the add-in's own Review sheet before upload; defaults to removeReviewSheet on `run`. */
  removeReview?: (signal: AbortSignal) => Promise<boolean>;
  /** How long Onboard waits for that removal (and Apply for its render); EXCEL_OP_TIMEOUT_MS unless a test shortens it. */
  excelOpTimeoutMs?: number;
  /** How long the chat waits for a reply or an Apply verdict; VERDICT_TIMEOUT_MS unless a test shortens it. */
  chatTimeoutMs?: number;
  /** Test seams for the Copilot panel: its session factory and its Excel writer. */
  copilotSession?: (deps: CopilotSessionDeps) => CopilotSession;
  copilotWriter?: CopilotWriter;
}

function hostOf(base: string): string {
  try { return new URL(base).hostname; } catch { return base; }
}

export function Pane({ client, store, readFile, apiBase = config.apiBase, run = excelRun, download, removeReview, excelOpTimeoutMs = EXCEL_OP_TIMEOUT_MS, chatTimeoutMs, copilotSession, copilotWriter }: PaneProps) {
  const state = useStore(store);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  // Kept apart from localError (upload errors): a Retry must not clear an upload error, nor an upload the sponsor error.
  const [sponsorsError, setSponsorsError] = useState<{ message: string; requestId?: string } | null>(null);
  const [sponsorsAttempt, setSponsorsAttempt] = useState(0);
  const [sponsorId, setSponsorId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState<{ message: string; requestId?: string } | null>(null);

  const [warning, setWarning] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const chatToggle = useRef<HTMLButtonElement>(null);
  // Closing the panel returns focus to its toggle (opening moves it into the panel).
  const toggleChat = () => {
    if (chatOpen) chatToggle.current?.focus();
    setChatOpen(!chatOpen);
  };
  const [copilotOpen, setCopilotOpen] = useState(false);
  const copilotToggle = useRef<HTMLButtonElement>(null);
  const toggleCopilot = () => {
    if (copilotOpen) copilotToggle.current?.focus();
    setCopilotOpen(!copilotOpen);
  };
  const inFlight = useRef(false);
  // An Apply in flight re-renders the Review sheet after its refresh: no upload may start (and delete it) meanwhile.
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const onApplyingChange = (on: boolean) => {
    applyingRef.current = on;
    if (alive.current) setApplying(on);
  };
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; store.stop(); };
  }, [store]);

  useEffect(() => {
    let live = true;
    setSponsorsError(null);
    client.sponsors().then(
      (list) => { if (live) setSponsors(list); },
      (e: unknown) => { if (live) setSponsorsError(toError(e)); },
    );
    return () => { live = false; };
  }, [client, sponsorsAttempt]);

  async function onboard() {
    if (inFlight.current || applyingRef.current) return;
    inFlight.current = true;
    setLocalError(null);
    setWarning(null);
    setUploading(true);
    // Until the new run exists, a failed upload goes back to the previous run (still on the server); its panel
    // re-renders the Review sheet from that run's grid.
    const previous = store.get().runId;
    const restore = () => { if (previous !== null && alive.current) store.start(previous); };
    let uploaded = false;
    try {
      // The previous run's Review sheet is a rendering, not source data: it must not be uploaded for the agent to map.
      // Stopping the store first unmounts its panel, so nothing re-renders the sheet between removal and the read.
      store.stop();
      try {
        // Bounded: Excel defers calls while a cell is being edited. A removal that starts after the bound is skipped,
        // so it cannot delete the sheet the restored run renders again.
        await withExcelTimeout((signal) => (removeReview ?? ((s: AbortSignal) => removeReviewSheet(run, s)))(signal), excelOpTimeoutMs);
      } catch (e) {
        if (alive.current) {
          setLocalError(e instanceof ExcelBusy
            ? { message: e.message }
            : { message: `Could not remove the '${REVIEW_SHEET}' sheet before upload (${toError(e).message}). Delete that sheet, then try again.` });
        }
        restore();
        return;
      }
      const file = await readFile();
      const { run_id } = await client.startRun(sponsorId, file.blob, file.name);
      uploaded = true;
      // Verify against the server directly: the store's refresh can be superseded and skip the check.
      let sha: string | undefined;
      let verifyError: string | null = null;
      try {
        sha = (await client.run(run_id)).upload.sha256;
      } catch (e) {
        verifyError = toError(e).message;
      }
      if (!alive.current) return;
      if (sha && sha !== file.sha256) {
        // The new run is never monitored; the previous run is unaffected by it, so its view comes back.
        store.stop();
        setLocalError({ message: "Upload verification failed: the server copy does not match this workbook. Try again." });
        restore();
        return;
      }
      store.start(run_id); // the run exists server-side: monitor it even if verification could not run
      if (verifyError !== null) setWarning(`Uploaded as run ${run_id}, but its integrity could not be verified (${verifyError}).`);
    } catch (e) {
      if (alive.current) setLocalError(toError(e));
      if (!uploaded) restore();
    } finally {
      inFlight.current = false;
      if (alive.current) setUploading(false);
    }
  }

  const layout = state.snap?.layout ?? null;
  const gate = pendingGate(state.snap);
  const sheet = layout?.sheet;
  const headerRow = layout?.header_row;
  const [selectionNote, setSelectionNote] = useState<string | null>(null);

  // Once per change of (run, sheet, header_row): a gate bounce must not overwrite the user's selection.
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (!sheet || headerRow === undefined || gate !== "brief") return;
    const key = `${state.runId}|${sheet}|${headerRow}`;
    if (shownKey.current === key) return;
    shownKey.current = key;
    void (async () => {
      try {
        if (await selectSheet(run, sheet)) await selectHeaderRow(run, sheet, headerRow);
      } catch (e) {
        if (alive.current) setSelectionNote(`Could not highlight the sheet: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [run, state.runId, sheet, headerRow, gate]);

  async function showColumn(column: string) {
    if (!sheet || headerRow === undefined) return;
    try {
      if (!(await selectColumn(run, sheet, headerRow, column)) && alive.current) {
        setSelectionNote(`Could not find a single "${column}" header in row ${headerRow}.`);
      }
    } catch (e) {
      if (alive.current) setSelectionNote(`Could not highlight the column: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Only stages the selected header in the card; the change is posted by its explicit "Apply change" click.
  async function useSelected(): Promise<string | null> {
    if (!sheet || headerRow === undefined) return null;
    const picked = await readSelectedColumn(run, sheet, headerRow);
    if (!alive.current) return null;
    if (!picked.ok) {
      setSelectionNote(picked.message);
      return null;
    }
    setSelectionNote(null);
    return picked.header;
  }

  // Each jump is isolated: a missing Review sheet must not stop the source jump, and nothing throws.
  async function jumpTo(f: Finding): Promise<string | null> {
    if (f.source_row === null) return null;
    const problems: string[] = [];
    if (f.row !== null) {
      try {
        if (!(await selectReviewRow(run, f.row))) problems.push(`Row ${f.row} is not on the '${REVIEW_SHEET}' sheet.`);
      } catch (e) {
        problems.push(`Could not select the row on the '${REVIEW_SHEET}' sheet: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      if (sheet && !(await selectSourceCell(run, sheet, f.source_row))) problems.push(`Could not find sheet "${sheet}" in this workbook.`);
      else if (!sheet) problems.push("The source sheet is not known yet.");
    } catch (e) {
      problems.push(`Could not select the source row: ${e instanceof Error ? e.message : String(e)}`);
    }
    return problems.length ? problems.join(" ") : null;
  }

  async function onDownload(name: string): Promise<DownloadResult> {
    if (!state.runId) return { kind: "error", message: "No active run." };
    try {
      return { kind: await downloadArtifact(client, state.runId, name, download ?? officeDownloadDeps(), apiBase) };
    } catch (e) {
      return { kind: "error", ...toError(e) };
    }
  }

  async function onOpenBrowser(name: string): Promise<DownloadResult> {
    if (!state.runId) return { kind: "error", message: "No active run." };
    try {
      await (download ?? officeDownloadDeps()).openBrowser(artifactUrl(apiBase, state.runId, name));
      return { kind: "browser" };
    } catch (e) {
      return { kind: "error", ...toError(e) };
    }
  }

  const artifacts = mergeArtifacts(state.snap?.pending?.artifacts, state.snap?.artifacts);
  const running = state.runId !== null;
  return (
    <main class="pane">
      <header class="pane-header">
        <h1>Onboarding workbench</h1>
        <div class="pane-toggles">
          {running ? (
            <button ref={chatToggle} type="button" class="secondary" data-testid="chat-toggle" aria-expanded={chatOpen} aria-controls="chat-panel" onClick={toggleChat}>
              Chat
            </button>
          ) : null}
          <button ref={copilotToggle} type="button" class="secondary" data-testid="copilot-toggle" aria-expanded={copilotOpen} aria-controls="copilot-panel" onClick={toggleCopilot}>
            Copilot
          </button>
        </div>
      </header>
      {localError ? <ErrorBanner message={localError.message} requestId={localError.requestId} /> : null}
      {warning ? (
        <div class="banner banner-warning" role="status" data-testid="warning-banner">
          <strong>Warning: </strong>
          <span>{warning}</span>
        </div>
      ) : null}
      {state.error ? <ErrorBanner message={state.error} /> : null}
      {state.notice ? (
        <p class="note" role="status" data-testid="store-notice">
          <span>{state.notice}</span>
          {state.notice === STALE_NOTICE ? (
            <button type="button" class="secondary" data-testid="store-refresh" onClick={() => void store.refresh()}>Refresh</button>
          ) : null}
        </p>
      ) : null}
      <SponsorPicker sponsors={sponsors} value={sponsorId} onChange={setSponsorId} />
      {sponsorsError ? (
        <div class="banner banner-error" role="alert" data-testid="sponsors-error">
          <strong>Error: </strong>
          <span>{`Could not load sponsors: ${sponsorsError.message}`}</span>
          {sponsorsError.requestId ? <span class="ref">{` (ref ${sponsorsError.requestId})`}</span> : null}
          <button type="button" data-testid="sponsors-retry" onClick={() => setSponsorsAttempt((n) => n + 1)}>Retry</button>
        </div>
      ) : null}
      {sponsorId ? (
        <p class="note" data-testid="consent-note">{`The whole workbook will be sent to ${hostOf(apiBase)} and filed under ${sponsorId}.`}</p>
      ) : null}
      <button type="button" data-testid="onboard-button" disabled={!sponsorId || uploading || applying} onClick={() => void onboard()}>
        {uploading ? "Uploading..." : running ? "Onboard again" : "Onboard this workbook"}
      </button>
      {running ? <Progress state={state} /> : null}
      {/* Mounted for the whole run (collapsing only hides it), so a pending reply and the transcript survive. */}
      {running ? <ChatPanel store={store} id="chat-panel" hidden={!chatOpen} timeoutMs={chatTimeoutMs} /> : null}
      {/* Mounted for the pane's life, with or without a run: one copilot session per pane (a new run gets a new one). */}
      <CopilotPanel client={client} run={run} store={store} id="copilot-panel" hidden={!copilotOpen} createSession={copilotSession} writer={copilotWriter} timeoutMs={chatTimeoutMs} />
      {running && state.snap?.brief && pendingGate(state.snap) === "brief" ? (
        <>
          <BriefCard
            brief={state.snap.brief}
            busy={state.busy}
            canApprove={canApprove(state.snap, state.busy)}
            blockedReasons={blockedReasons(state.snap)}
            headers={state.snap.resolution?.headers}
            onShowColumn={sheet && headerRow !== undefined ? (column) => void showColumn(column) : undefined}
            onUseSelected={sheet && headerRow !== undefined ? () => useSelected() : undefined}
            onApprove={() => void store.respond({ action: "approve" })}
            onAnswer={(question_id, option) => void store.respond({ action: "answer", question_id, option })}
            onColumn={(field, column) => void store.respond({ action: "change", changes: [{ kind: "set_column_binding", field, column }] })}
          />
          {selectionNote ? <p class="note" role="status" data-testid="selection-note">{selectionNote}</p> : null}
        </>
      ) : null}
      {running && state.snap && gate === "brief" ? <GateMessage message={gateMessage(state.snap)} /> : null}
      {running && state.snap && gate === "findings" ? (
        <>
          <FindingsGate snap={state.snap} busy={state.busy} onApprove={() => void store.respond({ action: "approve" })} />
          <GateMessage message={gateMessage(state.snap)} />
        </>
      ) : null}
      {running && state.snap?.result && state.snap.result.findings.length > 0 ? (
        <FindingsList
          findings={state.snap.result.findings}
          busy={state.busy}
          canChange={canChangeFindings(state.snap)}
          onAck={(f) => void store.respond({ action: "change", changes: [{ kind: "acknowledge_finding", code: f.code, row: f.row }] })}
          onExclude={(f, reason) => store.respond({ action: "change", changes: [{ kind: "exclude_row", row: f.row as number, reason }] })}
          onJump={jumpTo}
        />
      ) : null}
      {running && state.snap?.result && state.runId ? (
        <ReviewPanel client={client} runId={state.runId} store={store} rows={state.grid} total={state.snap.result.rows_emitted} run={run} onApplyingChange={onApplyingChange} excelOpTimeoutMs={excelOpTimeoutMs} />
      ) : null}
      {running && state.snap && (gate === "signoff" || artifacts.length > 0) ? (
        <SignOff
          snap={state.snap}
          busy={state.busy}
          artifacts={artifacts}
          onApprove={() => void store.respond({ action: "approve" })}
          onDownload={onDownload}
          onOpenBrowser={onOpenBrowser}
        />
      ) : null}
      {running && state.snap && gate === "signoff" ? <GateMessage message={gateMessage(state.snap)} /> : null}
    </main>
  );
}

function mergeArtifacts(...lists: (Artifact[] | undefined)[]): Artifact[] {
  const byName = new Map<string, Artifact>();
  for (const a of lists.flatMap((l) => l ?? [])) if (!byName.has(a.name)) byName.set(a.name, a);
  return [...byName.values()];
}

function toError(e: unknown): { message: string; requestId?: string } {
  if (e instanceof ApiError) return { message: e.message, requestId: e.requestId };
  return { message: e instanceof Error ? e.message : String(e) };
}

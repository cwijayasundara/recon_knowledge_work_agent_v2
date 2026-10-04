import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type Client } from "../api/client";
import { config } from "../config";
import { excelRun, readSelectedColumn, selectColumn, selectHeaderRow, selectSheet, selectSourceCell, type ExcelRun } from "../office/highlight";
import { artifactUrl, downloadArtifact, officeDownloadDeps, type DownloadDeps } from "../office/download";
import { REVIEW_SHEET, removeReviewSheet, selectReviewRow } from "../office/review";
import type { Artifact, Finding } from "../api/types";
import type { WorkbookFile } from "../office/workbook";
import { blockedReasons, canApprove, canChangeFindings, gateMessage, pendingGate } from "../state/gates";
import type { RunStore } from "../state/store";
import { BriefCard } from "./BriefCard";
import { FindingsGate } from "./FindingsGate";
import { FindingsList } from "./FindingsList";
import { GateMessage } from "./GateMessage";
import { QuestionCard } from "./QuestionCard";
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
  removeReview?: () => Promise<boolean>;
}

function hostOf(base: string): string {
  try { return new URL(base).hostname; } catch { return base; }
}

export function Pane({ client, store, readFile, apiBase = config.apiBase, run = excelRun, download, removeReview }: PaneProps) {
  const state = useStore(store);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [sponsorId, setSponsorId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState<{ message: string; requestId?: string } | null>(null);

  const [warning, setWarning] = useState<string | null>(null);
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
    client.sponsors().then(
      (list) => { if (live) setSponsors(list); },
      (e: unknown) => { if (live) setLocalError(toError(e)); },
    );
    return () => { live = false; };
  }, [client]);

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
        await (removeReview ?? (() => removeReviewSheet(run)))();
      } catch (e) {
        if (alive.current) setLocalError({ message: `Could not remove the '${REVIEW_SHEET}' sheet before upload (${toError(e).message}). Delete that sheet, then try again.` });
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

  async function useSelected(field: string) {
    if (!sheet || headerRow === undefined) return;
    const picked = await readSelectedColumn(run, sheet, headerRow);
    if (!alive.current) return;
    if (!picked.ok) {
      setSelectionNote(picked.message);
      return;
    }
    setSelectionNote(null);
    void store.respond({ action: "change", changes: [{ kind: "set_column_binding", field, column: picked.header }] });
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
      <h1>Onboarding workbench</h1>
      {localError ? <ErrorBanner message={localError.message} requestId={localError.requestId} /> : null}
      {warning ? (
        <div class="banner banner-warning" role="status" data-testid="warning-banner">
          <strong>Warning: </strong>
          <span>{warning}</span>
        </div>
      ) : null}
      {state.error ? <ErrorBanner message={state.error} /> : null}
      <SponsorPicker sponsors={sponsors} value={sponsorId} onChange={setSponsorId} />
      {sponsorId ? (
        <p class="note" data-testid="consent-note">{`The whole workbook will be sent to ${hostOf(apiBase)} and filed under ${sponsorId}.`}</p>
      ) : null}
      <button type="button" data-testid="onboard-button" disabled={!sponsorId || uploading || applying} onClick={() => void onboard()}>
        {uploading ? "Uploading..." : running ? "Onboard again" : "Onboard this workbook"}
      </button>
      {running ? <Progress state={state} /> : null}
      {running && state.snap?.brief && pendingGate(state.snap) === "brief" ? (
        <>
          <BriefCard
            brief={state.snap.brief}
            busy={state.busy}
            canApprove={canApprove(state.snap, state.busy)}
            blockedReasons={blockedReasons(state.snap)}
            headers={state.snap.resolution?.headers}
            onShowColumn={sheet && headerRow !== undefined ? (column) => void showColumn(column) : undefined}
            onUseSelected={sheet && headerRow !== undefined ? (field) => void useSelected(field) : undefined}
            onApprove={() => void store.respond({ action: "approve" })}
            onColumn={(field, column) => void store.respond({ action: "change", changes: [{ kind: "set_column_binding", field, column }] })}
          />
          {selectionNote ? <p class="note" role="status" data-testid="selection-note">{selectionNote}</p> : null}
          {state.snap.brief.questions.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              busy={state.busy}
              onAnswer={(option) => void store.respond({ action: "answer", question_id: q.id, option })}
            />
          ))}
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
        <ReviewPanel client={client} runId={state.runId} store={store} rows={state.grid} total={state.snap.result.rows_emitted} run={run} onApplyingChange={onApplyingChange} />
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

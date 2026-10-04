import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type Client } from "../api/client";
import type { GridRow, Impact } from "../api/types";
import { excelRun, type ExcelRun } from "../office/highlight";
import { REVIEW_SHEET, renderReview, watchReview } from "../office/review";
import { canChangeFindings } from "../state/gates";
import type { RunStore } from "../state/store";
import { APPLY_HOLD_MAX_MS, markApply, verdictFrom, VERDICT_TIMEOUT_MS, type ApplyMark } from "../state/verdict";
import { ErrorBanner } from "./ErrorBanner";
import { useStore } from "./useStore";

export interface ReviewPanelProps {
  client: Client;
  runId: string;
  store: RunStore;
  rows: GridRow[];
  /** Rows on the server; larger than rows.length when the grid is paged. */
  total?: number;
  run?: ExcelRun;
  /** Told when an Apply starts and ends, so the Pane holds uploads (which delete the Review sheet) meanwhile. */
  onApplyingChange?: (applying: boolean) => void;
  /** How long an accepted Apply waits for its verdict; VERDICT_TIMEOUT_MS unless a test shortens it. */
  verdictTimeoutMs?: number;
  /** How long an Apply may hold uploads before the hold is released anyway; APPLY_HOLD_MAX_MS unless a test shortens it. */
  applyHoldMaxMs?: number;
}

interface Pending { row: number; value: string }
/** An accepted Apply waiting for the run's verdict; `mark` is what the store had seen before the post. */
interface Awaiting { edit: Pending; mark: ApplyMark; timer: ReturnType<typeof setTimeout> }

const SLOW_APPLY = "Apply is taking long; you can start a new upload.";

const asError = (e: unknown): { message: string; requestId?: string } =>
  e instanceof ApiError ? { message: e.message, requestId: e.requestId } : { message: e instanceof Error ? e.message : String(e) };

export function ReviewPanel({ client, runId, store, rows, total, run = excelRun, onApplyingChange, verdictTimeoutMs = VERDICT_TIMEOUT_MS, applyHoldMaxMs = APPLY_HOLD_MAX_MS }: ReviewPanelProps) {
  const state = useStore(store);
  const [pending, setPending] = useState<Pending | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ edit: Pending; message: string } | null>(null);
  const [unknown, setUnknown] = useState<Pending | null>(null);
  const [slow, setSlow] = useState<string | null>(null);
  /** Releases the running Apply's upload hold (at most once). */
  const releaseHold = useRef<(() => void) | null>(null);
  const awaiting = useRef<Awaiting | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Nothing renders once unmounted, so the hold has no purpose: a hung Excel call must not keep it.
      releaseHold.current?.();
      if (awaiting.current) clearTimeout(awaiting.current.timer);
      awaiting.current = null;
    };
  }, []);

  // "Onboard again" stops the store (runId null) before this panel unmounts, then deletes the Review sheet: a render
  // queued after that would recreate the sheet and could be uploaded, so nothing renders once the run is not ours.
  const ours = () => alive.current && store.get().runId === runId;

  // The server grid is the truth: re-render on every change, which also recreates a deleted sheet.
  useEffect(() => {
    renderReview(run, rows).catch((e: unknown) => { if (alive.current) setError(asError(e)); });
  }, [run, rows]);

  // Later request wins: a response for an older edit is ignored.
  function preview(edit: Pending) {
    const mine = ++seq.current;
    pendingRef.current = edit;
    setPending(edit);
    setImpact(null);
    setError(null);
    clientRef.current.dryRun(runId, [{ kind: "override_item_id", row: edit.row, value: edit.value }]).then(
      (result) => { if (alive.current && mine === seq.current) setImpact(result); },
      (e: unknown) => { if (alive.current && mine === seq.current) setError(asError(e)); },
    );
  }
  const previewRef = useRef(preview);
  previewRef.current = preview;

  useEffect(() => {
    let unregister: (() => Promise<void>) | null = null;
    let cancelled = false;
    watchReview(run, (edit, batch) => {
      // A multi-cell paste reports several edits at once; only the first is previewed, the rest were reverted.
      if (batch.index > 0) return;
      setRefusal(null);
      setUnknown(null);
      setNotice(batch.count > 1 ? `${batch.count - 1} other ITEM_ID edit${batch.count > 2 ? "s were" : " was"} reverted; apply one change at a time.` : null);
      previewRef.current(edit);
    }, (message) => { if (alive.current) setWarning(message); }).then(
      (off) => { if (cancelled) void off(); else unregister = off; },
      (e: unknown) => { if (alive.current) setError(asError(e)); },
    );
    return () => { cancelled = true; if (unregister) void unregister(); };
  }, [run, runId]);

  const clear = () => {
    seq.current++;
    pendingRef.current = null;
    setRefusal(null);
    setUnknown(null);
    setNotice(null);
    setPending(null);
    setImpact(null);
    setError(null);
  };

  const canChange = canChangeFindings(state.snap);
  const violated = (impact?.violations.length ?? 0) > 0;
  const busy = applying || state.busy;
  const canApply = pending !== null && impact !== null && !violated && !busy && canChange;

  // No verdict (timed out, or another action's decision followed ours): say so and show the server's grid again.
  function verdictUnknown(edit: Pending) {
    if (!ours()) return;
    setUnknown(edit);
    store.refresh().then(
      () => (ours() ? renderReview(run, store.get().grid) : undefined),
      () => undefined, // the store reports refresh failures itself
    ).catch((e: unknown) => { if (alive.current) setError(asError(e)); });
  }
  const unknownRef = useRef(verdictUnknown);
  unknownRef.current = verdictUnknown;

  // POST /gate answers 202 before the run checks the change, so acceptance is not success: see applyVerdict.
  useEffect(() => {
    const w = awaiting.current;
    if (!w) return;
    const verdict = verdictFrom(state, w.edit, w.mark);
    if (verdict.kind === "pending") return;
    clearTimeout(w.timer);
    awaiting.current = null;
    if (verdict.kind === "unknown") { verdictUnknown(w.edit); return; }
    if (verdict.kind === "applied") return;
    setRefusal({ edit: w.edit, message: verdict.message });
    // Restored for another try, behind a fresh dry run against the current grid; a newer edit takes precedence.
    if (pendingRef.current === null) previewRef.current(w.edit);
  }, [state]);

  async function apply() {
    if (!pending || !canApply) return;
    const applied = pending;
    const { row, value } = applied;
    // Noted before the post: the job may finish (and its idle event arrive) before the 202 does.
    const mark = markApply(store.get());
    setApplying(true);
    setSlow(null);
    // Released exactly once, by the bound or by the end of this Apply: a late end must not release a newer hold.
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      clearTimeout(holdTimer);
      if (releaseHold.current === release) releaseHold.current = null;
      onApplyingChange?.(false);
    };
    const holdTimer = setTimeout(() => {
      if (!held) return;
      release();
      if (alive.current) setSlow(SLOW_APPLY);
    }, applyHoldMaxMs);
    releaseHold.current = release;
    onApplyingChange?.(true);
    try {
      const accepted = await store.respond({ action: "change", changes: [{ kind: "override_item_id", row, value }] });
      // Not accepted: the Pane shows store.error; the edit and its impact stay for a retry.
      if (!accepted || !ours()) return;
      if (awaiting.current) clearTimeout(awaiting.current.timer);
      const w: Awaiting = {
        edit: applied,
        mark,
        timer: setTimeout(() => {
          if (awaiting.current !== w) return;
          awaiting.current = null;
          unknownRef.current(applied);
        }, verdictTimeoutMs),
      };
      awaiting.current = w;
      setUnknown(null);
      // Cleared before anything else can fail, so the same change cannot be posted twice.
      if (pendingRef.current === applied) clear();
      await store.refresh();
      if (!ours()) return;
      await renderReview(run, store.get().grid);
      if (!ours()) return;
      const survivor = pendingRef.current;
      if (survivor) previewRef.current(survivor); // an edit made during Apply was checked against the old grid
    } catch (e) {
      if (alive.current) setError(asError(e));
    } finally {
      if (alive.current) { setApplying(false); setSlow(null); }
      release();
    }
  }

  return (
    <section class="review" data-testid="review-panel">
      <h2>Review sheet</h2>
      {total !== undefined && total > rows.length ? (
        <p class="note" data-testid="review-paged">{`Showing first ${rows.length} of ${total} rows`}</p>
      ) : null}
      <p class="note">{`Edit an ITEM_ID cell in the '${REVIEW_SHEET}' sheet to preview its impact. Other cells cannot be changed. The add-in removes that sheet before each upload.`}</p>
      {warning ? (
        <div class="banner banner-warning" role="status" data-testid="review-warning">
          <strong>Warning: </strong>
          <span>{warning}</span>
        </div>
      ) : null}
      {notice ? <p class="note" role="status" data-testid="review-notice">{notice}</p> : null}
      {slow ? <p class="note" role="status" data-testid="review-slow">{slow}</p> : null}
      {error ? <ErrorBanner message={error.message} requestId={error.requestId} /> : null}
      {unknown ? (
        <p class="note" role="status" data-testid="review-unknown">{`Verdict unknown — check the findings gate. Row ${unknown.row}: ITEM_ID to ${unknown.value} may not have been applied.`}</p>
      ) : null}
      {refusal ? (
        <p class="note" role="status" data-testid="review-refused">{`Row ${refusal.edit.row}: ITEM_ID to ${refusal.edit.value} was not applied. ${refusal.message}`}</p>
      ) : null}
      {pending ? (
        <div data-testid="review-pending">
          <p>{`Row ${pending.row}: ITEM_ID to ${pending.value}`}</p>
          {impact === null && error === null ? <p class="note">Checking...</p> : null}
          {impact ? (
            <>
              <p data-testid="review-rows-changed">{`Rows changed: ${impact.rows_changed.join(", ") || "none"}`}</p>
              {impact.violations.length > 0 ? (
                <ul data-testid="review-violations">
                  {impact.violations.map((v, i) => <li key={i}>{v.message}</li>)}
                </ul>
              ) : null}
            </>
          ) : null}
          {canChange ? null : <p class="note" data-testid="review-change-hint">Apply is available at the findings gate.</p>}
          <button type="button" data-testid="review-apply" disabled={!canApply} onClick={() => void apply()}>Apply</button>
          <button type="button" data-testid="review-discard" disabled={applying} onClick={clear}>Discard</button>
        </div>
      ) : null}
    </section>
  );
}

import { useEffect, useRef, useState } from "preact/hooks";
import type { Client } from "../api/client";
import type { TypedChange } from "../api/types";
import { CopilotDisabled, createCopilotSession, type CopilotSession, type CopilotSessionDeps, type ReadLogEntry } from "../copilot/session";
import type { CopilotChange, CopilotLimits, WriteProposal } from "../copilot/types";
import { SCRATCH_SHEET, WRITE_MESSAGES, applyWrite, previewWrite, type ApplyOptions, type WritePreview } from "../copilot/write";
import type { ExcelRun } from "../office/highlight";
import { ACK_NOT_FROM_CHAT, RESCOPE_NOTE, UNKNOWN_OUTCOME, acknowledges, changeOutcome, describeChange, markPost, outcomeText, rescopes, type PostMark } from "../state/chat";
import {
  COPILOT_MAX_CHARS, DISABLED_TEXT, EMPTY_MESSAGE, FINISHING_TEXT, FORMULAS_RUN, HIDDEN_MESSAGE, INVALID_PROPOSAL, MAX_RENDERED_ENTRIES,
  MAX_WRITE_CARDS, NOT_LATEST, NOT_SENT, NO_ANSWER, NO_LIMITS, NO_RUN_TO_APPLY, OTHER_RUN, PRIVACY_NOTICE, RESTARTED_SEPARATOR,
  RUN_CHANGED_SEPARATOR, STALE_ANSWER, STOPPED_RUN_CHANGED, STOPPED_TEXT, checkMessage, displayGrid, failureLine, hiddenEntries, moreWrites,
  quoteSheet, readLine, tooLongMessage, writeResultLine, writeShape, type DisplayGrid,
} from "../state/copilot";
import { canChangeFindings } from "../state/gates";
import type { RunState, RunStore } from "../state/store";
import { VERDICT_TIMEOUT_MS } from "../state/verdict";
import { useStore } from "./useStore";

export type CopilotClient = Pick<Client, "copilotStart" | "copilotStep" | "copilotClose">;
export interface CopilotWriter { preview: typeof previewWrite; apply: typeof applyWrite }
const REAL_WRITER: CopilotWriter = { preview: previewWrite, apply: applyWrite };

interface UserEntry { id: number; role: "user"; text: string; notSent: boolean }
interface AnswerEntry {
  id: number;
  role: "answer";
  text: string;
  notes: string[];
  read: ReadLogEntry[];
  changes: CopilotChange[];
  /** The run the turn ran for: its typed changes apply only while that run is active. */
  runId: string | null;
  /** The newest run decision seen when the message was sent: any later decision makes the changes stale. */
  sinceSeq: number;
  outcome: string | null;
  writes: WriteProposal[];
  limits: CopilotLimits | undefined;
}
interface LineEntry { id: number; role: "error" | "status" | "separator"; text: string }
type Entry = UserEntry | AnswerEntry | LineEntry;

/** The turn in flight: `gen` tells its late rejection (after a Stop) apart from a newer turn's. */
interface Turn { gen: number; runId: string | null; sinceSeq: number }
/** A typed-change Apply waiting for the run's verdict (the stage-1 hold/verdict rule). */
interface AwaitApply { mark: PostMark; changes: TypedChange[]; entryId: number; timer: ReturnType<typeof setTimeout> }
type Availability = "unchecked" | "checking" | "ready" | "disabled";

export interface CopilotPanelProps {
  client: CopilotClient;
  run: ExcelRun;
  store: RunStore;
  id: string;
  hidden: boolean;
  createSession?: (deps: CopilotSessionDeps) => CopilotSession;
  writer?: CopilotWriter;
  /** How long a typed-change Apply's verdict is awaited; VERDICT_TIMEOUT_MS unless a test shortens it. */
  timeoutMs?: number;
}

const noop = () => undefined;
/** Focus was dropped (to the body) or is still inside `within`: moving it does not steal it from elsewhere. */
const focusLost = (within: HTMLElement | null): boolean => {
  const at = document.activeElement;
  return !at || at === document.body || !!within?.contains(at);
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The Copilot: questions about the open workbook, answered by the server's model with read-only workbook tools run
 * here. One server session per mounted pane, bound to the active run. Its proposals are applied only by explicit
 * clicks: typed changes through the stage-1 gate post, writes through write.ts (scratch, or a confirmed range).
 */
export function CopilotPanel({ client, run, store, id, hidden, createSession = createCopilotSession, writer = REAL_WRITER, timeoutMs = VERDICT_TIMEOUT_MS }: CopilotPanelProps) {
  const state = useStore(store);
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [avail, setAvail] = useState<Availability>("unchecked");
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkingNow, setCheckingNow] = useState(false);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [writeBusy, setWriteBusy] = useState(false);
  const [, setTick] = useState(0);

  const alive = useRef(true);
  /** Aborted on unmount; made in the mount effect (so a re-run effect, e.g. a hot reload, gets a fresh one). */
  const life = useRef<AbortController | null>(null);
  const sessionRef = useRef<CopilotSession | null>(null);
  const nextId = useRef(0);
  const genRef = useRef(0);
  const turnRef = useRef<Turn | null>(null);
  /** Turns ended by Stop (or a run change): their late rejection adds nothing. */
  const stopped = useRef(new Set<number>());
  /** Step requests in flight, by the turn that sent them: an older turn's means the server is still finishing it. */
  const pendingSteps = useRef(new Map<number, number>());
  const stepToken = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  /** The run the current conversation belongs to; a separator marks a change. */
  const convRun = useRef<string | null>(store.get().runId);
  /** A run-change separator was shown since the last answer: a restarted session is already announced. */
  const announced = useRef(false);
  const checking = useRef(false);
  const posting = useRef(false);
  const awaitApply = useRef<AwaitApply | null>(null);
  const writeLock = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const checkAgainRef = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** Where focus goes after the next render (a control that was clicked became disabled or went away). */
  const focusNext = useRef<"input" | null>(null);
  useEffect(() => {
    if (focusNext.current !== "input") return;
    focusNext.current = null;
    if (focusLost(sectionRef.current)) inputRef.current?.focus();
  });
  const focusComposer = () => {
    focusNext.current = "input";
    setTick((n) => n + 1);
  };

  const dropApplyWait = () => {
    if (awaitApply.current) clearTimeout(awaitApply.current.timer);
    awaitApply.current = null;
  };

  useEffect(() => {
    alive.current = true;
    const lifeCtl = new AbortController();
    life.current = lifeCtl;
    return () => {
      alive.current = false;
      dropApplyWait();
      lifeCtl.abort();
      life.current = null;
      sessionRef.current?.close().catch(noop);
      sessionRef.current = null;
    };
  }, []);

  function session(): CopilotSession {
    if (sessionRef.current) return sessionRef.current;
    const tracked: CopilotClient = {
      copilotStart: (runId) => client.copilotStart(runId),
      copilotClose: (sessionId) => client.copilotClose(sessionId),
      copilotStep: (sessionId, body) => {
        const p = client.copilotStep(sessionId, body);
        const token = stepToken.current++;
        pendingSteps.current.set(token, genRef.current);
        const done = () => {
          pendingSteps.current.delete(token);
          if (alive.current) setTick((n) => n + 1);
        };
        p.then(done, done);
        return p;
      },
    };
    sessionRef.current = createSession({ client: tracked, run, runId: () => store.get().runId ?? undefined });
    return sessionRef.current;
  }

  const add = (e: Omit<LineEntry, "id"> | Omit<UserEntry, "id"> | Omit<AnswerEntry, "id">): number => {
    const entryId = nextId.current++;
    setEntries((es) => [...es, { ...e, id: entryId } as Entry]);
    return entryId;
  };
  /** A separator, unless the transcript is empty or already ends with one. */
  const separate = (label: string) =>
    setEntries((es) => (es.length === 0 || es[es.length - 1]!.role === "separator" ? es : [...es, { id: nextId.current++, role: "separator", text: label }]));

  function stopTurn(label: string) {
    const t = turnRef.current;
    if (!t) return;
    sessionRef.current?.stop(); // synchronous: Send is usable again at once
    stopped.current.add(t.gen);
    turnRef.current = null;
    setRunning(false);
    add({ role: "status", text: label });
  }

  // A changed active run ends the turn for the old one and starts a new conversation (the transcript stays).
  const runId = state.runId;
  const seenRun = useRef(runId);
  useEffect(() => {
    if (seenRun.current === runId) return;
    seenRun.current = runId;
    dropApplyWait();
    setApplyingId(null);
    const t = turnRef.current;
    if (t && t.runId !== runId) stopTurn(STOPPED_RUN_CHANGED);
    if (runId !== null && runId !== convRun.current) {
      convRun.current = runId;
      announced.current = true;
      separate(RUN_CHANGED_SEPARATOR);
    }
  }, [runId]);

  async function checkAvailability() {
    if (checking.current) return;
    checking.current = true;
    setCheckingNow(true);
    setAvail((a) => (a === "disabled" ? a : "checking"));
    setCheckError(null);
    try {
      await session().ensureSession(life.current?.signal);
      if (!alive.current) return;
      // "Check again" goes away once the copilot is on: focus moves to the composer.
      if (document.activeElement === checkAgainRef.current) focusNext.current = "input";
      setAvail("ready");
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof CopilotDisabled) setAvail("disabled");
      else {
        setAvail("ready"); // a send tries again; only "turned off" disables the composer
        setCheckError(failureLine(e).text);
      }
    } finally {
      checking.current = false;
      if (alive.current) setCheckingNow(false);
    }
  }

  // The first open checks once that the server has the copilot on; later opens do not (no retry spam).
  const opened = useRef(false);
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (!hidden && !opened.current) {
      opened.current = true;
      void checkAvailability();
    }
    if (wasHidden.current && !hidden) (avail === "disabled" ? checkAgainRef.current : inputRef.current)?.focus();
    wasHidden.current = hidden;
  }, [hidden]);

  // Turned off while focus was in the composer (now disabled): focus goes to "Check again".
  useEffect(() => {
    if (avail !== "disabled" || hidden) return;
    const at = document.activeElement;
    if (!at || at === document.body || sectionRef.current?.contains(at)) checkAgainRef.current?.focus();
  }, [avail, hidden]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries]);

  const patchAnswer = (entryId: number, patch: Partial<AnswerEntry>) =>
    setEntries((es) => es.map((e) => (e.id === entryId && e.role === "answer" ? { ...e, ...patch } : e)));

  function checkApply(s: RunState) {
    const a = awaitApply.current;
    if (!a) return;
    const outcome = changeOutcome(s, a.changes, a.mark);
    if (outcome.kind === "pending") return;
    clearTimeout(a.timer);
    awaitApply.current = null;
    setApplyingId(null);
    patchAnswer(a.entryId, { outcome: outcomeText(outcome) });
  }
  const checkRef = useRef(checkApply);
  checkRef.current = checkApply;
  useEffect(() => { checkRef.current(state); }, [state]);

  const message = checkMessage(text);
  const canSend = message.ok && !running && avail !== "disabled";

  async function send() {
    const raw = textRef.current;
    const m = checkMessage(raw);
    if (!m.ok || turnRef.current || avail === "disabled") return;
    const s = session();
    const gen = ++genRef.current;
    const turnRun = store.get().runId;
    if (turnRun !== convRun.current) {
      convRun.current = turnRun;
      announced.current = true;
      separate(RUN_CHANGED_SEPARATOR);
    }
    const fresh = announced.current;
    const userId = add({ role: "user", text: m.text, notSent: false });
    turnRef.current = { gen, runId: turnRun, sinceSeq: markPost(store.get()).sinceSeq };
    // Send becomes disabled: a click on it leaves focus in the composer (which stays usable for a draft).
    if (document.activeElement === sendRef.current) inputRef.current?.focus();
    setRunning(true);
    try {
      const sinceSeq = turnRef.current.sinceSeq;
      const r = await s.send(m.text, { signal: life.current?.signal });
      if (!alive.current || stopped.current.delete(gen)) return;
      if (turnRef.current?.gen === gen) {
        turnRef.current = null;
        setRunning(false);
      }
      announced.current = false;
      if (r.restarted && !fresh) separate(RESTARTED_SEPARATOR);
      add({
        role: "answer", text: r.text, notes: r.notes, read: r.read, changes: r.proposedChanges, runId: turnRun, sinceSeq, outcome: null,
        writes: r.proposedWrites, limits: s.limits,
      });
      // The composer is cleared only when it still holds what was sent (a draft typed meanwhile is kept).
      if (textRef.current === raw) setText("");
    } catch (e) {
      if (!alive.current || stopped.current.delete(gen)) return;
      if (turnRef.current?.gen === gen) {
        turnRef.current = null;
        setRunning(false);
      }
      const f = failureLine(e);
      if (f.kind === "disabled") setAvail("disabled");
      if (NOT_SENT.has(f.kind)) setEntries((es) => es.map((x) => (x.id === userId && x.role === "user" ? { ...x, notSent: true } : x)));
      add({ role: f.kind === "aborted" ? "status" : "error", text: f.text });
    }
  }

  const latestAnswer = [...entries].reverse().find((e): e is AnswerEntry => e.role === "answer")?.id ?? null;
  /** Typed changes are offered for Apply when they hold no acknowledgement and the turn ran for a run. */
  const offered = (e: AnswerEntry): boolean => e.changes.length > 0 && !acknowledges({ changes: e.changes }) && e.runId !== null;
  /** A decision recorded after the message was sent (an applied change, an approval, a re-scope) makes the answer stale. */
  const stale = (e: AnswerEntry, s: RunState): boolean => markPost(s).sinceSeq > e.sinceSeq;
  const canApply = (e: AnswerEntry, s: RunState): boolean =>
    offered(e) && e.id === latestAnswer && e.outcome === null && s.runId === e.runId && !stale(e, s) && canChangeFindings(s.snap) && !s.busy
    && applyingId === null && !posting.current && turnRef.current === null;

  async function apply(e: AnswerEntry) {
    if (!canApply(e, store.get())) return;
    posting.current = true;
    const changes: TypedChange[] = e.changes;
    const mark = markPost(store.get());
    setApplyingId(e.id);
    let accepted = false;
    try {
      accepted = await store.respond({ action: "change", changes });
    } catch {
      accepted = false; // the store reports its own errors; the card stays for another try
    } finally {
      posting.current = false;
    }
    if (!alive.current) return;
    // Not accepted: the Pane shows store.error and the card stays for another try.
    if (!accepted || store.get().runId !== mark.runId) {
      setApplyingId(null);
      return;
    }
    const a: AwaitApply = {
      mark, changes, entryId: e.id,
      timer: setTimeout(() => {
        if (awaitApply.current !== a || !alive.current) return;
        awaitApply.current = null;
        setApplyingId(null);
        patchAnswer(e.id, { outcome: UNKNOWN_OUTCOME });
      }, timeoutMs),
    };
    awaitApply.current = a;
    checkApply(store.get());
  }

  const lock = {
    acquire: (): boolean => {
      if (writeLock.current) return false;
      writeLock.current = true;
      setWriteBusy(true);
      return true;
    },
    release: () => {
      writeLock.current = false;
      if (alive.current) setWriteBusy(false);
    },
  };

  const finishing = running && [...pendingSteps.current.values()].some((g) => g < genRef.current);
  const inputId = `${id}-input`;
  return (
    <section ref={sectionRef} id={id} class="chat copilot" data-testid="copilot-panel" hidden={hidden} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Copilot</h2>
      <p class="note" data-testid="copilot-privacy">{PRIVACY_NOTICE}</p>
      {avail === "disabled" ? (
        <div class="copilot-off" data-testid="copilot-disabled">
          <p role="status"><strong>Unavailable: </strong>{DISABLED_TEXT}</p>
          <button ref={checkAgainRef} type="button" class="secondary" data-testid="copilot-check-again" aria-disabled={checkingNow} onClick={() => void checkAvailability()}>Check again</button>
        </div>
      ) : null}
      {checkError && avail !== "disabled" ? <p class="note copilot-text" role="status" data-testid="copilot-check-error"><strong>Error: </strong>{checkError}</p> : null}
      <div ref={logRef} class="chat-log" role="log" aria-live="polite" aria-label="Copilot conversation" data-testid="copilot-log">
        {entries.length > MAX_RENDERED_ENTRIES ? <p class="note" data-testid="copilot-hidden-entries">{hiddenEntries(entries.length - MAX_RENDERED_ENTRIES)}</p> : null}
        {entries.slice(-MAX_RENDERED_ENTRIES).map((e) => {
          switch (e.role) {
            case "user":
              return (
                <div key={e.id} class="chat-msg chat-user" data-testid="copilot-user">
                  <strong>You: </strong>
                  <span class="copilot-text">{e.text}</span>
                  {e.notSent ? <span class="chat-flag"> — Not sent</span> : null}
                </div>
              );
            case "separator":
              return <p key={e.id} class="copilot-separator" data-testid="copilot-separator">{e.text}</p>;
            case "status":
              return <p key={e.id} class="chat-msg copilot-text" data-testid="copilot-status-line">{e.text}</p>;
            case "error":
              return <p key={e.id} class="chat-msg copilot-error copilot-text" data-testid="copilot-error"><strong>Error: </strong>{e.text}</p>;
            case "answer":
              return (
                <div key={e.id} class="chat-msg chat-agent" data-testid="copilot-answer">
                  <strong>Copilot: </strong>
                  <span class="chat-line copilot-text" data-testid="copilot-answer-text">{e.text || NO_ANSWER}</span>
                  {e.notes.map((n, i) => <span key={i} class="chat-line copilot-text note" data-testid="copilot-note">{n}</span>)}
                  <ReadLog read={e.read} />
                  {e.changes.length > 0 ? (
                    <ChangesCard
                      entry={e}
                      activeRun={state.runId}
                      latest={e.id === latestAnswer}
                      offered={offered(e)}
                      stale={stale(e, state)}
                      canApply={canApply(e, state)}
                      onApply={() => void apply(e)}
                    />
                  ) : null}
                  {e.writes.slice(0, MAX_WRITE_CARDS).map((w, i) => (
                    <WriteCard key={i} proposal={w} limits={e.limits} run={run} writer={writer} locked={writeBusy} lock={lock} life={life} alive={alive} onDone={focusComposer} />
                  ))}
                  {e.writes.length > MAX_WRITE_CARDS ? <p class="note" data-testid="copilot-more-writes">{moreWrites(e.writes.length - MAX_WRITE_CARDS)}</p> : null}
                </div>
              );
          }
        })}
      </div>
      {running ? (
        <div class="copilot-working">
          <p class="note" role="status" data-testid="copilot-working"><span class="spinner" aria-hidden="true" />{finishing ? FINISHING_TEXT : "Working…"}</p>
          <button type="button" class="secondary" data-testid="copilot-stop" onClick={() => { stopTurn(STOPPED_TEXT); inputRef.current?.focus(); }}>Stop</button>
        </div>
      ) : null}
      <label for={inputId}>Message for the copilot</label>
      <textarea
        id={inputId}
        ref={inputRef}
        data-testid="copilot-input"
        rows={3}
        value={text}
        disabled={avail === "disabled"}
        aria-describedby={`${id}-count`}
        onInput={(ev) => setText((ev.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(ev) => {
          // Ctrl/Cmd+Enter is an explicit send, under the same guards as the button; Enter alone is a newline.
          if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void send(); }
        }}
      />
      <p class="note" id={`${id}-count`} data-testid="copilot-count">{`${message.count}/${COPILOT_MAX_CHARS}`}</p>
      {!message.ok && text !== "" ? (
        <p class="note" role="status" data-testid="copilot-invalid">
          {message.reason === "empty" ? EMPTY_MESSAGE : message.reason === "too-long" ? tooLongMessage(message.count) : HIDDEN_MESSAGE}
        </p>
      ) : null}
      <button ref={sendRef} type="button" data-testid="copilot-send" disabled={!canSend} onClick={() => void send()}>Send</button>
    </section>
  );
}

function ReadLog({ read }: { read: ReadLogEntry[] }) {
  const cells = read.reduce((n, r) => n + r.cells, 0);
  return (
    <details class="copilot-read" data-testid="copilot-read">
      <summary>{`What the copilot read (${plural(read.length, "tool call")}, ${plural(cells, "cell")})`}</summary>
      {read.length ? <ul>{read.map((r, i) => <li key={i}>{readLine(r)}</li>)}</ul> : <p class="note">Nothing was read.</p>}
    </details>
  );
}

interface ChangesCardProps {
  entry: AnswerEntry; activeRun: string | null; latest: boolean; offered: boolean; stale: boolean; canApply: boolean; onApply: () => void;
}

/** Typed changes, as the stage-1 proposal card shows them; applied only by its own Apply click. */
function ChangesCard({ entry: e, activeRun, latest, offered, stale, canApply, onApply }: ChangesCardProps) {
  const note = e.runId === null || activeRun === null ? NO_RUN_TO_APPLY
    : e.runId !== activeRun ? OTHER_RUN
      : acknowledges({ changes: e.changes }) ? ACK_NOT_FROM_CHAT
        : e.outcome !== null ? null
          : stale ? STALE_ANSWER
            : !latest ? NOT_LATEST : null;
  const usable = offered && e.runId !== null && e.runId === activeRun;
  return (
    <div class="chat-proposal" data-testid="copilot-changes">
      <h3>Change proposal</h3>
      <ul>{e.changes.map((c, i) => <li key={i} class="copilot-text">{describeChange(c)}</li>)}</ul>
      {note ? <p class="note" data-testid="copilot-changes-note">{note}</p> : null}
      {usable && rescopes({ changes: e.changes }) ? <p class="note" data-testid="copilot-rescope-note">{RESCOPE_NOTE}</p> : null}
      {usable ? <button type="button" data-testid="copilot-apply-changes" disabled={!canApply} onClick={onApply}>Apply</button> : null}
      {/* Inside the transcript's live log: plain text (no nested live region). */}
      {e.outcome ? <p class="note" data-testid="copilot-changes-outcome">{e.outcome}</p> : null}
    </div>
  );
}

interface WriteLock { acquire: () => boolean; release: () => void }
interface WriteCardProps {
  proposal: WriteProposal;
  limits: CopilotLimits | undefined;
  run: ExcelRun;
  writer: CopilotWriter;
  /** Some write (any card) is in flight: one at a time. */
  locked: boolean;
  lock: WriteLock;
  /** The panel's lifetime controller (aborted on unmount); read at call time. */
  life: { current: AbortController | null };
  alive: { current: boolean };
  /** A write was applied (this card's buttons are now disabled): focus goes back to the composer. */
  onDone: () => void;
}

const STALE = new Set<string>([WRITE_MESSAGES.stale, WRITE_MESSAGES.mismatch]);

function Grid({ grid, before, caption }: { grid: DisplayGrid; before?: DisplayGrid; caption: string }) {
  return (
    // Kept out of the transcript's announcements; scrolls sideways inside the pane.
    <div class="copilot-grid-wrap" aria-live="off">
      <table class="copilot-grid" data-testid="copilot-grid">
        <caption>{caption}</caption>
        <tbody>
          {grid.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i}>
                  {before ? <span class="copilot-before">{`${before.rows[r]?.[i] || "(empty)"} → `}</span> : null}
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {grid.moreRows > 0 ? <p class="note">{`…${grid.moreRows} more rows`}</p> : null}
      {grid.moreCols > 0 ? <p class="note">{`…${grid.moreCols} more columns`}</p> : null}
    </div>
  );
}

type Confirming = { target: "scratch" | "range"; preview: WritePreview };

/**
 * A write proposal: its cells, then explicit clicks only. "Apply to Copilot Scratch" previews and writes on the
 * add-in's own sheet (formulas only after Confirm); "Apply to <range>…" previews the real before → after with warnings
 * and writes only after Confirm. Every field is untrusted: the sheet and range are shown only once validated, and
 * write.ts re-validates everything.
 */
function WriteCard({ proposal: p, limits, run, writer, locked, lock, life, alive, onDone }: WriteCardProps) {
  const [phase, setPhase] = useState<"idle" | "applied">("idle");
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [stale, setStale] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const scratchRef = useRef<HTMLButtonElement>(null);
  const rangeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** The control that gets focus after the next render, when the clicked one was disabled or removed meanwhile. */
  const focusNext = useRef<"scratch" | "range" | "cancel" | null>(null);
  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    if (focusLost(cardRef.current)) ({ scratch: scratchRef, range: rangeRef, cancel: cancelRef })[f].current?.focus();
  });

  const shape = writeShape(p);
  const formulas = p.formulas !== undefined && p.formulas !== null;
  const idle = !locked && phase === "idle" && confirming === null && limits !== undefined && shape !== null;

  const clearPreview = () => {
    setConfirming(null);
    setWarnings([]);
  };

  async function toScratch() {
    if (!idle || !limits || !lock.acquire()) return;
    try {
      setStatus(null);
      const pv = await writer.preview(run, p, limits, "scratch");
      if (!alive.current) return;
      if (!pv.ok) {
        focusNext.current = "scratch";
        return setStatus({ ok: false, text: `Error: ${pv.error}` });
      }
      setWarnings(pv.preview.warnings);
      if (pv.preview.kind === "formulas" || pv.preview.overwrites > 0) {
        // Formulas run in the workbook, and earlier scratch output would be lost: either needs Confirm first.
        setConfirming({ target: "scratch", preview: pv.preview });
        focusNext.current = "cancel";
        return;
      }
      await write({ target: "scratch", limits, signal: life.current?.signal, select: true });
    } finally {
      lock.release();
    }
  }

  async function previewRange() {
    if (!idle || !limits || !lock.acquire()) return;
    try {
      setStatus(null);
      const pv = await writer.preview(run, p, limits, "range");
      if (!alive.current) return;
      if (!pv.ok) {
        focusNext.current = "range";
        return setStatus({ ok: false, text: `Error: ${pv.error}` });
      }
      setStale(false);
      setWarnings(pv.preview.warnings);
      setConfirming({ target: "range", preview: pv.preview });
      focusNext.current = "cancel"; // the safe choice of the two
    } finally {
      lock.release();
    }
  }

  /** Runs the write and shows its outcome; a failure clears the preview (it may be stale now). */
  async function write(opts: ApplyOptions) {
    const r = await writer.apply(run, p, opts);
    if (!alive.current) return;
    setStatus(writeResultLine(r));
    if (r.ok) {
      setConfirming(null);
      setPhase("applied");
      onDone();
    } else {
      clearPreview();
      setStale(opts.target === "range" && STALE.has(r.error));
      focusNext.current = opts.target === "range" ? "range" : "scratch";
    }
  }

  async function confirm() {
    const c = confirming;
    if (locked || !c || !limits || !lock.acquire()) return;
    try {
      const signal = life.current?.signal;
      await write(c.target === "range"
        ? { target: "range", confirmed: true, preview: c.preview, limits, signal }
        : { target: "scratch", confirmed: true, limits, signal, select: true });
    } finally {
      lock.release();
    }
  }

  const pv = confirming?.preview;
  const shown = pv ? displayGrid(pv.after) : displayGrid(formulas ? p.formulas : p.values);
  const before = pv && confirming.target === "range" ? displayGrid(pv.before) : undefined;
  const confirmText = !pv ? ""
    : confirming.target === "range"
      ? `This overwrites ${pv.range} on ${quoteSheet(pv.sheet)}. Excel can't undo this.${pv.kind === "formulas" ? ` ${FORMULAS_RUN}` : ""} Apply?`
      : `${pv.overwrites > 0 ? `This overwrites ${plural(pv.overwrites, "existing cell")} on ${SCRATCH_SHEET}. ` : ""}${pv.kind === "formulas" ? `${FORMULAS_RUN} ` : ""}Apply?`;
  return (
    <div ref={cardRef} class="chat-proposal copilot-write" data-testid="copilot-write">
      <h3>Write proposal</h3>
      <p class="note copilot-text" data-testid="copilot-write-summary">
        {shape ? `${shape.where} · ${formulas ? "formulas" : "values"} · ${plural(shape.cells, "cell")}` : INVALID_PROPOSAL}
      </p>
      {str(p.note) ? <p class="copilot-text" data-testid="copilot-write-note">{str(p.note)}</p> : null}
      {shape ? <Grid grid={shown} before={before} caption={pv ? `${before ? "Before → after" : "Proposed cells"} on ${pv.sheet}!${pv.range}` : "Proposed cells"} /> : null}
      {warnings.length ? (
        <ul class="copilot-warnings" data-testid="copilot-write-warnings">
          {warnings.map((w, i) => <li key={i}><strong>Warning: </strong>{w}</li>)}
        </ul>
      ) : null}
      {limits === undefined ? <p class="note" data-testid="copilot-write-nolimits">{NO_LIMITS}</p> : null}
      {phase === "applied" ? <p class="note" data-testid="copilot-write-applied">Applied</p> : null}
      {status ? <p class={status.ok ? "note copilot-text" : "copilot-error copilot-text"} data-testid="copilot-write-status">{status.text}</p> : null}
      {confirming ? (
        <div class="copilot-confirm" data-testid="copilot-write-confirm">
          <p class="copilot-text">{confirmText}</p>
          <div class="copilot-actions">
            <button type="button" data-testid="copilot-write-confirm-yes" disabled={locked} onClick={() => void confirm()}>Confirm</button>
            <button ref={cancelRef} type="button" class="secondary" data-testid="copilot-write-confirm-no" disabled={locked}
              onClick={() => { focusNext.current = confirming.target === "range" ? "range" : "scratch"; clearPreview(); }}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div class="copilot-actions">
        <button ref={scratchRef} type="button" data-testid="copilot-write-scratch" disabled={!idle} onClick={() => void toScratch()}>Apply to Copilot Scratch</button>
        {stale ? (
          <button ref={rangeRef} type="button" class="secondary" data-testid="copilot-write-again" disabled={!idle} onClick={() => void previewRange()}>Preview again</button>
        ) : (
          <button ref={rangeRef} type="button" class="secondary copilot-text" data-testid="copilot-write-range" disabled={!idle} onClick={() => void previewRange()}>
            {shape ? `Apply to ${shape.where}…` : "Apply to range…"}
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "preact/hooks";
import type { TypedChange } from "../api/types";
import {
  ACK_NOT_FROM_CHAT, CHAT_MAX_CHARS, RESCOPE_NOTE, UNKNOWN_OUTCOME, acknowledges, canInstruct, changeOutcome, chatReplyFrom,
  describeChange, instructBody, markChat, markPost, outcomeText, proposalIsCurrent, rescopes, sendBlocked, type ChatMark,
  type PostMark, type Proposal,
} from "../state/chat";
import { canChangeFindings } from "../state/gates";
import type { RunState, RunStore } from "../state/store";
import { VERDICT_TIMEOUT_MS } from "../state/verdict";
import { useStore } from "./useStore";

export const CHAT_HINT = "Chat is available at the brief and findings gates.";
export const NO_REPLY_YET = "No reply yet — the agent may still be working; check the gate.";

interface UserEntry { id: number; role: "user"; text: string; status: "sending" | "sent" | "not-sent" }
interface AgentEntry { id: number; role: "agent"; lines: string[]; proposal: Proposal | null; outcome: string | null }
type Entry = UserEntry | AgentEntry;

/**
 * A sent instruction waiting for the run's reply. `expired` once the bound ran out; `noteId` is the "No reply yet" entry,
 * added only once the store's hold is gone too (while the job still runs the panel says "Working…").
 */
interface AwaitReply { mark: ChatMark; timer: ReturnType<typeof setTimeout> | null; expired: boolean; noteId: number | null }
/** A proposal's accepted Apply waiting for the run's verdict. */
interface AwaitApply { mark: PostMark; changes: TypedChange[]; entryId: number; timer: ReturnType<typeof setTimeout> }

export interface ChatPanelProps {
  store: RunStore;
  id: string;
  hidden: boolean;
  /** How long a reply or an Apply verdict is awaited before the panel says so; VERDICT_TIMEOUT_MS unless a test shortens it. */
  timeoutMs?: number;
}

/**
 * "Ask the agent": instructions go to the run as `instruct` gate posts, only from Send (or Ctrl/Cmd+Enter). The agent
 * cannot pass a gate from here: a proposal is applied only by its own Apply click, which posts its changes as they are.
 */
export function ChatPanel({ store, id, hidden, timeoutMs = VERDICT_TIMEOUT_MS }: ChatPanelProps) {
  const state = useStore(store);
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const nextId = useRef(0);
  const awaitReply = useRef<AwaitReply | null>(null);
  const awaitApply = useRef<AwaitApply | null>(null);
  const alive = useRef(true);
  /** Set synchronously by Send and Apply: a second invocation in the same task posts nothing. */
  const posting = useRef(false);
  /** Focus goes back to the composer once it is enabled again after a Send. */
  const refocus = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const dropWaits = () => {
    if (awaitReply.current?.timer) clearTimeout(awaitReply.current.timer);
    if (awaitApply.current) clearTimeout(awaitApply.current.timer);
    awaitReply.current = null;
    awaitApply.current = null;
  };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; dropWaits(); };
  }, []);

  // A transcript belongs to one run.
  const runId = state.runId;
  useEffect(() => {
    dropWaits();
    setEntries([]);
    setWaiting(false);
    setApplyingId(null);
  }, [runId]);

  const patchAgent = (entryId: number, patch: Partial<AgentEntry>) =>
    setEntries((es) => es.map((e) => (e.id === entryId && e.role === "agent" ? { ...e, ...patch } : e)));

  // The reply and an Apply's verdict come from the run once it has settled after the post (see chatReplyFrom). Also
  // checked when a wait is registered: the run can settle (and the store stop changing) before the 202 arrives.
  function check(s: RunState) {
    const r = awaitReply.current;
    if (r) {
      const reply = chatReplyFrom(s, r.mark);
      if (reply.kind === "reply") {
        if (r.timer) clearTimeout(r.timer);
        awaitReply.current = null;
        setWaiting(false);
        if (r.noteId !== null) patchAgent(r.noteId, { lines: reply.lines, proposal: reply.proposal });
        else setEntries((es) => [...es, { id: nextId.current++, role: "agent", lines: reply.lines, proposal: reply.proposal, outcome: null }]);
      } else if (r.expired && !s.busy && r.noteId === null) {
        // Still watched: a late reply replaces this note. Send is open again (the run is no longer held).
        const noteId = nextId.current++;
        r.noteId = noteId;
        setWaiting(false);
        setEntries((es) => [...es, { id: noteId, role: "agent", lines: [NO_REPLY_YET], proposal: null, outcome: null }]);
      }
    }
    const a = awaitApply.current;
    if (a) {
      const outcome = changeOutcome(s, a.changes, a.mark);
      if (outcome.kind !== "pending") {
        clearTimeout(a.timer);
        awaitApply.current = null;
        setApplyingId(null);
        patchAgent(a.entryId, { outcome: outcomeText(outcome) });
      }
    }
  }
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => { checkRef.current(state); }, [state]);

  // Opening the panel moves focus to the composer (when it can be used).
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (wasHidden.current && !hidden) inputRef.current?.focus();
    wasHidden.current = hidden;
  }, [hidden]);

  // The newest entry stays in view; the log itself is not focusable.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries]);

  const allowed = canInstruct(state.snap);
  const blocked = sendBlocked(text);
  const idle = !state.busy && !sending && applyingId === null;
  const canSend = allowed && blocked === null && idle && !waiting;
  const inputDisabled = !allowed || !idle || waiting;

  useEffect(() => {
    if (!inputDisabled && refocus.current && !hidden) {
      refocus.current = false;
      // Only if focus was not moved elsewhere meanwhile (a disabled composer drops it to the body).
      const at = document.activeElement;
      if (!at || at === document.body || inputRef.current?.closest("section")?.contains(at)) inputRef.current?.focus();
    }
  }, [inputDisabled, hidden]);

  async function send() {
    if (!canSend || posting.current) return;
    posting.current = true;
    refocus.current = true;
    const mark = markChat(store.get(), text);
    const entryId = nextId.current++;
    setEntries((es) => [...es, { id: entryId, role: "user", text: mark.text, status: "sending" }]);
    setSending(true);
    const accepted = await store.respond(instructBody(mark.text));
    posting.current = false;
    if (!alive.current) return;
    setSending(false);
    if (store.get().runId !== mark.runId) return;
    setEntries((es) => es.map((e) => (e.id === entryId && e.role === "user" ? { ...e, status: accepted ? "sent" : "not-sent" } : e)));
    // Not accepted: the Pane shows store.error; the text stays in the composer for another try.
    if (!accepted) return;
    setText("");
    if (awaitReply.current?.timer) clearTimeout(awaitReply.current.timer);
    const w: AwaitReply = { mark, noteId: null, timer: null, expired: false };
    w.timer = setTimeout(() => {
      w.timer = null;
      if (awaitReply.current !== w || !alive.current) return;
      w.expired = true;
      checkRef.current(store.get());
    }, timeoutMs);
    awaitReply.current = w;
    setWaiting(true);
    check(store.get());
  }

  const latestAgent = [...entries].reverse().find((e): e is AgentEntry => e.role === "agent")?.id ?? null;
  /** Offered for Apply at all: the agent marked it applicable, it has changes and no violations, and no acknowledgement. */
  const applicable = (e: AgentEntry): e is AgentEntry & { proposal: Proposal } =>
    !!e.proposal && e.proposal.applicable && e.proposal.changes.length > 0 && (e.proposal.impact?.violations.length ?? 0) === 0
    && !acknowledges(e.proposal);
  const canApply = (e: AgentEntry): boolean =>
    applicable(e) && e.id === latestAgent && e.outcome === null && idle && !waiting
    && canChangeFindings(state.snap) && proposalIsCurrent(state.snap, e.proposal);

  async function apply(e: AgentEntry) {
    if (!canApply(e) || !e.proposal || posting.current) return;
    posting.current = true;
    const changes = e.proposal.changes;
    const mark = markPost(store.get());
    setApplyingId(e.id);
    const accepted = await store.respond({ action: "change", changes });
    posting.current = false;
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
        patchAgent(e.id, { outcome: UNKNOWN_OUTCOME });
      }, timeoutMs),
    };
    awaitApply.current = a;
    check(store.get());
  }

  const working = state.busy && (sending || waiting || applyingId !== null);
  const inputId = `${id}-input`;
  return (
    <section id={id} class="chat" data-testid="chat-panel" hidden={hidden} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Ask the agent</h2>
      <p class="note">The agent reads the uploaded copy of the workbook, not the open sheet. It can propose changes for you to apply; it never approves a gate.</p>
      <div ref={logRef} class="chat-log" role="log" aria-live="polite" aria-label="Conversation" data-testid="chat-log">
        {entries.map((e) => (e.role === "user" ? (
          <div key={e.id} class="chat-msg chat-user" data-testid="chat-user">
            <strong>You: </strong>
            <span>{e.text}</span>
            {e.status === "not-sent" ? <span class="chat-flag"> — Not sent</span> : null}
          </div>
        ) : (
          <div key={e.id} class="chat-msg chat-agent" data-testid="chat-agent">
            <strong>Agent: </strong>
            {e.lines.map((l, i) => <span key={i} class="chat-line">{l}</span>)}
            {e.proposal ? (
              <div class="chat-proposal" data-testid="chat-proposal">
                <h3>Change proposal</h3>
                <p class="note">{e.proposal.applicable && e.proposal.changes.length > 0 ? `${e.proposal.changes.length} change${e.proposal.changes.length === 1 ? "" : "s"}` : "Nothing to apply"}</p>
                {e.proposal.changes.length > 0 ? (
                  <ul>{e.proposal.changes.map((c, i) => <li key={i}>{describeChange(c)}</li>)}</ul>
                ) : null}
                {e.proposal.impact ? (
                  <p class="note" data-testid="chat-impact">{`Rows changed: ${e.proposal.impact.rows_changed.join(", ") || "none"} · Flags removed: ${e.proposal.impact.findings_removed.length} · Flags added: ${e.proposal.impact.findings_added.length}`}</p>
                ) : null}
                {e.proposal.impact && e.proposal.impact.violations.length > 0 ? (
                  <ul class="blocked" data-testid="chat-violations">{e.proposal.impact.violations.map((v, i) => <li key={i}>{v.message}</li>)}</ul>
                ) : null}
                {e.proposal.applicable && acknowledges(e.proposal) ? (
                  <p class="note" data-testid="chat-ack-note">{ACK_NOT_FROM_CHAT}</p>
                ) : null}
                {applicable(e) && rescopes(e.proposal) ? <p class="note" data-testid="chat-rescope-note">{RESCOPE_NOTE}</p> : null}
                {applicable(e) ? (
                  <button type="button" data-testid="chat-apply" disabled={!canApply(e)} onClick={() => void apply(e)}>Apply</button>
                ) : null}
                {e.outcome ? <p class="note" role="status" data-testid="chat-outcome">{e.outcome}</p> : null}
              </div>
            ) : null}
          </div>
        )))}
      </div>
      {working ? <p class="note" role="status" data-testid="chat-working"><span class="spinner" aria-hidden="true" />Working…</p> : null}
      <label for={inputId}>Instruction for the agent</label>
      <textarea
        id={inputId}
        ref={inputRef}
        data-testid="chat-input"
        rows={3}
        value={text}
        disabled={inputDisabled}
        aria-describedby={`${id}-count`}
        onInput={(ev) => setText((ev.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(ev) => {
          // Ctrl/Cmd+Enter is an explicit send, under the same guards as the button; Enter alone is a newline.
          if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void send(); }
        }}
      />
      <p class="note" id={`${id}-count`} data-testid="chat-count">{`${text.trim().length}/${CHAT_MAX_CHARS}`}</p>
      {blocked === "too-long" ? <p class="note" role="status" data-testid="chat-too-long">{`Too long: at most ${CHAT_MAX_CHARS} characters.`}</p> : null}
      {allowed ? null : <p class="note" data-testid="chat-hint">{CHAT_HINT}</p>}
      <button type="button" data-testid="chat-send" disabled={!canSend} onClick={() => void send()}>Send</button>
    </section>
  );
}

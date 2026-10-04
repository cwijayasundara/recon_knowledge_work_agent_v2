// "Ask the agent": the chat panel on the real store with a fake client. An instruction is posted only from Send; the
// reply is read from a snapshot fetched after the instruct's own decision and the idle that followed it.
// Fake timers throughout: every wait (debounced refreshes, the reply bound, the store's settle bound) is advanced
// explicitly, so no assertion depends on wall-clock timing.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, RequestTimeout, type Client } from "../../src/api/client";
import type { Brief, Decision, GateBody, Pending, Snapshot, TypedChange } from "../../src/api/types";
import type { ExcelRun } from "../../src/office/highlight";
import { ACK_NOT_FROM_CHAT, CHAT_MAX_CHARS, RESCOPE_NOTE, RESCOPE_SENT } from "../../src/state/chat";
import { GATE_SETTLE_TIMEOUT_MS, createRunStore, type RunStore } from "../../src/state/store";
import { Pane } from "../../src/ui/Pane";
import { fakeSnapshot } from "../support/fakes";
import { createFakeReview } from "../support/review-fake";

const stores: RunStore[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  stores.splice(0).forEach((s) => s.stop());
  vi.useRealTimers();
});

const brief = (summary: string): Brief => ({
  source: { file: "a.xlsx", sheet: "S1", header_row: 1, rows_read: 1, rows_emitted: 1, rows_dropped: 0, drop_reasons: [] },
  bindings: [{ field: "affiliate_id", column: "ID", route: "exact", confidence: 1, evidence: "" }],
  id_strategy: "source_id", item_type: "Inventory", recipe: { kind: "builtin", id: null }, expected_findings: [], questions: [], confidence: 1, summary,
});
const pending = (gate: Pending["gate"], over: Partial<Pending> = {}): Pending => ({
  gate, message: null, blocked_reasons: [], allowed_actions: gate === "signoff" ? ["approve", "reject"] : ["approve", "change", "instruct", "reject"], ...over,
});
const at = (gate: Pending["gate"], over: Partial<Snapshot> = {}): Snapshot => fakeSnapshot({ brief: brief("One affiliate."), pending: pending(gate), ...over });
const decision = (seq: number, kind: string, payload: Record<string, unknown>): Decision => ({ run_id: "r1", seq, kind, payload, actor: "analyst", at: "t" });
const exclude: TypedChange = { kind: "exclude_row", row: 2, reason: "exclude row 2" };
const impact = { violations: [], requires_rebuild: true, rows_changed: [2], findings_added: [] as [string, number | null][], findings_removed: [["W1", 2]] as [string, number | null][], preview: [], publishable_before: false, publishable_after: true };
const proposal = { restated: "Exclude row 2 from the import.", applicable: true, changes: [exclude], impact };
const instructed = (text: string, seq = 1, gate = "findings") => decision(seq, `${gate}.instruct`, { action: "instruct", text, actor: "analyst", changes: [] });
const changedWith = (seq: number, changes: TypedChange[]) => decision(seq, "findings.change", { action: "change", actor: "analyst", changes });
const changed = (seq: number) => changedWith(seq, [exclude]);

function harness(first: Snapshot) {
  const run = vi.fn<(id: string) => Promise<Snapshot>>(async () => first);
  const client = {
    sponsors: vi.fn(async () => [{ id: "sponsor-a", name: "Sponsor A" }]),
    run,
    grid: vi.fn(async () => ({ total: 0, rows: [], item_id_limit: 40 })),
    gate: vi.fn<(id: string, b: GateBody) => Promise<{ accepted: boolean }>>(async () => ({ accepted: true })),
    dryRun: vi.fn(),
  };
  let push: (event: string, data?: unknown) => void = () => {};
  const streamer = async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; signal: AbortSignal }) => {
    push = (event, data = {}) => o.onMessage({ id: "1", event, data: JSON.stringify(data) });
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  };
  const store = createRunStore(client as unknown as Client, { debounceMs: 5, streamer: streamer as never });
  stores.push(store);
  return { client, run, store, push: (e: string, d?: unknown) => act(() => { push(e, d); }) };
}

/** Runs due timers (debounced refreshes) and the promise chains they start. */
const flush = (ms = 20) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function mount(first: Snapshot, opts: { chatTimeoutMs?: number; open?: boolean } = {}) {
  const h = harness(first);
  const excel = createFakeReview();
  render(<Pane client={h.client as unknown as Client} store={h.store} readFile={vi.fn()} run={excel.run as ExcelRun} apiBase="https://api.example.test" chatTimeoutMs={opts.chatTimeoutMs} />);
  act(() => { h.store.start("r1"); });
  await flush();
  expect(h.store.get().snap).not.toBeNull();
  if (opts.open ?? true) fireEvent.click(screen.getByTestId("chat-toggle"));
  await flush(0);
  return h;
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => screen.getByTestId(id) as T;
const send = () => el<HTMLButtonElement>("chat-send");
const box = () => el<HTMLTextAreaElement>("chat-input");
const applyButtons = () => screen.queryAllByTestId("chat-apply") as HTMLButtonElement[];
const type = (text: string) => fireEvent.input(box(), { target: { value: text } });
const agentReplies = () => screen.queryAllByTestId("chat-agent").map((e) => e.textContent);

type H = Awaited<ReturnType<typeof mount>>;
/** Sends `text` and lets the run settle with `snap` (its decisions must include this instruct's). */
async function exchange(h: H, text: string, snap: Snapshot, d: Decision) {
  type(text);
  fireEvent.click(send());
  await flush();
  h.run.mockResolvedValue(snap);
  h.push("decision", { entry: d });
  h.push("idle");
  await flush();
}
/** A findings gate whose last reply offered `proposal`. */
async function withProposal(chatTimeoutMs?: number) {
  const h = await mount(at("findings"), { chatTimeoutMs });
  await exchange(h, "exclude row 2", at("findings", { proposal, decisions: [instructed("exclude row 2")] }), instructed("exclude row 2"));
  expect(applyButtons()).toHaveLength(1);
  expect(applyButtons()[0]!.disabled).toBe(false);
  return h;
}

test("the Chat button toggles the panel with aria-expanded and moves focus; nothing is posted on render, toggle or typing", async () => {
  const { client } = await mount(at("findings"), { open: false });
  const toggle = el<HTMLButtonElement>("chat-toggle");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe("chat-panel");
  expect(el("chat-panel").hidden).toBe(true);
  fireEvent.click(toggle);
  await flush(0);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(el("chat-panel").hidden).toBe(false);
  expect(document.activeElement).toBe(box()); // opening moves focus into the composer
  type("exclude row 2");
  fireEvent.keyDown(box(), { key: "Enter" }); // Enter alone is a newline, not a send
  await flush();
  expect(client.gate).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await flush(0);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(el("chat-panel").hidden).toBe(true);
  expect(document.activeElement).toBe(toggle); // closing returns focus to the toggle
  expect(box().value).toBe("exclude row 2"); // collapsing keeps the panel (and its draft)
});

test("Send is disabled for empty or over-length text; it posts exactly the trimmed instruct on click", async () => {
  const { client } = await mount(at("findings"));
  expect(send().disabled).toBe(true);
  type("   \n  ");
  expect(send().disabled).toBe(true);
  type("x".repeat(CHAT_MAX_CHARS + 1));
  expect(send().disabled).toBe(true);
  expect(el("chat-count").textContent).toBe(`${CHAT_MAX_CHARS + 1}/${CHAT_MAX_CHARS}`);
  expect(el("chat-too-long").textContent).toBe(`Too long: at most ${CHAT_MAX_CHARS} characters.`);
  type("  exclude row 2  ");
  expect(send().disabled).toBe(false);
  fireEvent.click(send());
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(1);
  expect(client.gate).toHaveBeenCalledWith("r1", { action: "instruct", text: "exclude row 2" });
  expect(box().value).toBe(""); // cleared once accepted
  expect(screen.getByTestId("chat-user").textContent).toBe("You: exclude row 2");
});

test("two Send invocations in one task post once and add one line", async () => {
  const { client } = await mount(at("findings"));
  type("exclude row 2");
  act(() => {
    fireEvent.click(send());
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    fireEvent.click(send());
  });
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(1);
  expect(screen.queryAllByTestId("chat-user")).toHaveLength(1);
});

test("Ctrl/Cmd+Enter sends like a click, with the same guards", async () => {
  const { client } = await mount(at("findings"));
  fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true }); // empty: nothing
  await flush();
  expect(client.gate).not.toHaveBeenCalled();
  type("hello");
  fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
  await flush();
  expect(client.gate).toHaveBeenCalledWith("r1", { action: "instruct", text: "hello" });
});

test("the composer is disabled with a hint when the gate does not take instructions", async () => {
  const { client } = await mount(at("signoff"));
  expect(box().disabled).toBe(true);
  expect(send().disabled).toBe(true);
  expect(el("chat-hint").textContent).toBe("Chat is available at the brief and findings gates.");
  fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
  await flush();
  expect(client.gate).not.toHaveBeenCalled();
});

test("the reply renders only from a snapshot read after the instruct's decision and idle (a stale snapshot does not count)", async () => {
  const { client, run, push } = await mount(at("findings"));
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(1);
  expect(el("chat-working").textContent).toBe("Working…");
  expect(box().disabled).toBe(true); // a reply is pending: one gate action at a time
  // The job ended mid-read: the proposal and the decision are there, but no idle yet.
  run.mockResolvedValue(at("findings", { proposal, decisions: [instructed("exclude row 2")] }));
  push("decision", { entry: instructed("exclude row 2") });
  push("change_impact");
  await flush();
  expect(agentReplies()).toEqual([]);
  expect(screen.queryByTestId("chat-proposal")).toBeNull();
  push("idle");
  await flush();
  expect(agentReplies()).toHaveLength(1);
  expect(screen.queryByTestId("chat-working")).toBeNull();
  expect(agentReplies()[0]).toMatch(/^Agent: Exclude row 2 from the import\.Change proposal1 change/);
  expect(el("chat-proposal").textContent).toContain("Exclude row 2 (DONOTIMPORT '#')");
  expect(el("chat-impact").textContent).toBe("Rows changed: 2 · Flags removed: 1 · Flags added: 0");
  await flush(1000);
  expect(client.gate).toHaveBeenCalledTimes(1); // a proposal is never applied on its own
  expect(box().disabled).toBe(false);
  expect(document.activeElement).toBe(box()); // focus is back in the composer once it is enabled again
});

test("the same text sent twice: each reply belongs to its own message, never to the earlier decision", async () => {
  const h = await mount(at("findings"));
  const declined = (n: number) => ({ restated: `reply ${n}`, applicable: false, changes: [], impact: null });
  await exchange(h, "hello", at("findings", { proposal: declined(1), decisions: [instructed("hello")] }), instructed("hello"));
  expect(agentReplies()).toEqual(["Agent: reply 1Change proposalNothing to apply"]);
  type("hello");
  fireEvent.click(send());
  await flush();
  // A refresh before the second decision still shows the first exchange: no reply for the second message yet.
  h.push("gate");
  await flush();
  h.push("idle"); // an idle that is not ours (no decision of the second post yet)
  await flush();
  expect(agentReplies()).toHaveLength(1);
  h.run.mockResolvedValue(at("findings", { proposal: declined(2), decisions: [instructed("hello"), instructed("hello", 2)] }));
  h.push("decision", { entry: instructed("hello", 2) });
  h.push("idle");
  await flush();
  expect(agentReplies()).toEqual(["Agent: reply 1Change proposalNothing to apply", "Agent: reply 2Change proposalNothing to apply"]);
  expect(screen.getAllByTestId("chat-user").map((e) => e.textContent)).toEqual(["You: hello", "You: hello"]);
});

test("Apply posts exactly the proposal's changes once; an applied change says so and the card cannot be applied again", async () => {
  const { client, run, push } = await withProposal();
  const apply = applyButtons()[0]!;
  act(() => { fireEvent.click(apply); fireEvent.click(apply); }); // two clicks in one task: one post
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(2);
  expect(client.gate.mock.calls[1]).toEqual(["r1", { action: "change", changes: proposal.changes }]);
  expect(apply.disabled).toBe(true);
  // Applied: the run clears the proposal and the gate message.
  run.mockResolvedValue(at("findings", { proposal: null, options: { ...fakeSnapshot().options, excluded_rows: { "2": "exclude row 2" } }, decisions: [instructed("exclude row 2"), changed(2)] }));
  push("decision", { entry: changed(2) });
  push("idle");
  await flush();
  expect(el("chat-outcome").textContent).toBe("Applied.");
  fireEvent.click(applyButtons()[0]!);
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(2);
  expect(applyButtons()[0]!.disabled).toBe(true);
});

test("Apply is disabled once the run no longer offers the proposal (cleared or replaced)", async () => {
  const { run, push } = await withProposal();
  run.mockResolvedValue(at("findings", { proposal: null, decisions: [instructed("exclude row 2")] }));
  push("gate");
  await flush();
  expect(applyButtons()[0]!.disabled).toBe(true);
  run.mockResolvedValue(at("findings", { proposal: { ...proposal, changes: [{ ...exclude, row: 3 }] }, decisions: [instructed("exclude row 2")] }));
  push("gate");
  await flush();
  expect(applyButtons()[0]!.disabled).toBe(true);
  run.mockResolvedValue(at("findings", { proposal, decisions: [instructed("exclude row 2")] }));
  push("gate");
  await flush();
  expect(applyButtons()[0]!.disabled).toBe(false); // the same proposal again: offered again
});

test("Apply is disabled when the gate leaves findings or no longer allows change", async () => {
  const { run, push } = await withProposal();
  run.mockResolvedValue(at("brief", { proposal, decisions: [instructed("exclude row 2")] }));
  push("gate");
  await flush();
  expect(applyButtons()[0]!.disabled).toBe(true);
  run.mockResolvedValue(at("findings", { proposal, pending: pending("findings", { allowed_actions: ["approve", "instruct"] }), decisions: [instructed("exclude row 2")] }));
  push("gate");
  await flush();
  expect(applyButtons()[0]!.disabled).toBe(true);
});

test("only the latest reply's proposal can be applied", async () => {
  const h = await withProposal();
  await exchange(h, "exclude row 2", at("findings", { proposal, decisions: [instructed("exclude row 2"), instructed("exclude row 2", 2)] }), instructed("exclude row 2", 2));
  const [older, newer] = applyButtons();
  expect(older!.disabled).toBe(true);
  expect(newer!.disabled).toBe(false);
});

test("a proposal that acknowledges warnings lists its changes but offers no Apply", async () => {
  const h = await mount(at("findings"));
  const ack = { restated: "Acknowledge W1 and exclude row 2.", applicable: true, changes: [{ kind: "acknowledge_finding", code: "W1", row: 2 } as TypedChange, exclude], impact };
  await exchange(h, "ack it", at("findings", { proposal: ack, decisions: [instructed("ack it")] }), instructed("ack it"));
  expect(applyButtons()).toHaveLength(0);
  expect(el("chat-ack-note").textContent).toBe(ACK_NOT_FROM_CHAT);
  expect(el("chat-proposal").textContent).toContain("Acknowledge W1 on row 2");
  expect(el("chat-proposal").textContent).toContain("Exclude row 2 (DONOTIMPORT '#')");
});

test("a re-scoping proposal says so, and its Apply never claims 'Applied.'", async () => {
  const h = await mount(at("findings"));
  const bind: TypedChange = { kind: "set_column_binding", field: "affiliate_name", column: "Name" };
  const p = { restated: "Use the Name column.", applicable: true, changes: [bind], impact: { ...impact, requires_rebuild: true } };
  await exchange(h, "names are in Name", at("findings", { proposal: p, decisions: [instructed("names are in Name")] }), instructed("names are in Name"));
  expect(el("chat-rescope-note").textContent).toBe(RESCOPE_NOTE);
  fireEvent.click(applyButtons()[0]!);
  await flush();
  expect(h.client.gate.mock.calls[1]).toEqual(["r1", { action: "change", changes: [bind] }]);
  h.run.mockResolvedValue(at("brief", { proposal: null, decisions: [instructed("names are in Name"), changedWith(2, [bind])] }));
  h.push("decision", { entry: changedWith(2, [bind]) });
  h.push("idle");
  await flush();
  expect(el("chat-outcome").textContent).toBe(RESCOPE_SENT);
});

test("a refused Apply shows the server's gate message verbatim", async () => {
  const { client, run, push } = await withProposal();
  fireEvent.click(applyButtons()[0]!);
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(2);
  run.mockResolvedValue(at("findings", { proposal, pending: pending("findings", { message: "Changes refused: row 2 is gone" }), decisions: [instructed("exclude row 2"), changed(2)] }));
  push("decision", { entry: changed(2) });
  push("idle");
  await flush();
  expect(el("chat-outcome").textContent).toBe("Not applied: Changes refused: row 2 is gone");
  // The run still offers the proposal, but this card has its verdict: no second post of the same refused changes.
  expect(applyButtons()[0]!.disabled).toBe(true);
  fireEvent.click(applyButtons()[0]!);
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(2);
});

test("an agent that declines shows its message and no Apply", async () => {
  const h = await mount(at("findings"));
  const declined = { restated: "'hello' does not map to any Affiliate change.", applicable: false, changes: [], impact: null };
  await exchange(h, "hello", at("findings", { proposal: declined, decisions: [instructed("hello")] }), instructed("hello"));
  expect(agentReplies()[0]).toContain("'hello' does not map to any Affiliate change.");
  expect(el("chat-proposal").textContent).toContain("Nothing to apply");
  expect(applyButtons()).toHaveLength(0);
});

test("at the brief gate an instruction re-scopes: the new brief summary is the reply", async () => {
  const h = await mount(at("brief"));
  const d = instructed("the names are in column B", 1, "brief");
  await exchange(h, "the names are in column B", at("brief", { brief: brief("Names from column B."), decisions: [d] }), d);
  expect(h.client.gate).toHaveBeenCalledWith("r1", { action: "instruct", text: "the names are in column B" });
  expect(agentReplies()).toEqual(["Agent: Updated the brief: Names from column B."]);
});

test("'No reply yet' appears only after the bound AND once the store's hold is gone; a later reply replaces it", async () => {
  const { client, run, push } = await mount(at("findings"), { chatTimeoutMs: 60 });
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(1);
  await flush(100); // past the chat bound, but the post is still held
  expect(agentReplies()).toEqual([]);
  expect(el("chat-working").textContent).toBe("Working…");
  expect(send().disabled).toBe(true);
  await flush(GATE_SETTLE_TIMEOUT_MS); // the stream is not connected: the store releases the hold
  expect(agentReplies()).toEqual(["Agent: No reply yet — the agent may still be working; check the gate."]);
  expect(screen.queryByTestId("chat-working")).toBeNull();
  run.mockResolvedValue(at("findings", { proposal, decisions: [instructed("exclude row 2")] }));
  push("decision", { entry: instructed("exclude row 2") });
  push("idle");
  await flush();
  expect(agentReplies()[0]).toContain("Exclude row 2 from the import.");
  expect(agentReplies()).toHaveLength(1);
});

test("a failed send is marked 'Not sent', keeps the text and shows the error banner", async () => {
  const { client } = await mount(at("findings"));
  client.gate.mockRejectedValueOnce(new ApiError("the run is already working", 409, "rid"));
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  expect(el("chat-user").textContent).toBe("You: exclude row 2 — Not sent");
  expect(box().value).toBe("exclude row 2");
  expect(screen.getByTestId("error-banner").textContent).toContain("the run is already working");
  expect(screen.queryByTestId("chat-working")).toBeNull();
  expect(send().disabled).toBe(false); // free to try again
});

test("the transcript resets when the run changes", async () => {
  const { client, store, run } = await mount(at("findings"));
  client.gate.mockRejectedValueOnce(new ApiError("nope", 409, "rid"));
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  expect(screen.queryAllByTestId("chat-user")).toHaveLength(1);
  run.mockResolvedValue(at("findings", { run_id: "r2" }));
  act(() => { store.start("r2"); });
  await flush();
  expect(store.get().snap?.run_id).toBe("r2");
  expect(screen.queryAllByTestId("chat-user")).toHaveLength(0);
});

test("unmount clears the reply timer: its callback never runs afterwards", async () => {
  const { client } = await mount(at("findings"), { chatTimeoutMs: 1_000 });
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBeGreaterThan(0); // the reply bound (and the store's settle wait) are pending
  cleanup(); // unmounts the Pane, which stops the store
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(vi.getTimerCount()).toBe(0);
});

test("chat is disabled while another gate action is held, and comes back once it settles", async () => {
  const { client, run, push } = await mount(at("findings"));
  type("exclude row 2");
  expect(send().disabled).toBe(false);
  fireEvent.click(el<HTMLButtonElement>("findings-approve"));
  await flush();
  expect(client.gate).toHaveBeenCalledWith("r1", { action: "approve" });
  expect(send().disabled).toBe(true);
  expect(box().disabled).toBe(true);
  fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
  expect(screen.queryByTestId("chat-working")).toBeNull(); // the hold is not the chat's
  const d = decision(1, "findings.approve", { action: "approve", actor: "analyst" });
  run.mockResolvedValue(at("findings", { decisions: [d], pending: pending("findings", { message: "Cannot pass the gate: x" }) }));
  push("decision", { entry: d });
  push("idle");
  await flush();
  expect(send().disabled).toBe(false);
  expect(client.gate).toHaveBeenCalledTimes(1);
});

/** Makes the next client.gate call wait until the returned function settles it. */
function deferGate(client: ReturnType<typeof harness>["client"]) {
  let settle: (fail?: unknown) => void = () => {};
  client.gate.mockImplementationOnce(() => new Promise((resolve, reject) => { settle = (fail) => (fail ? reject(fail) : resolve({ accepted: true })); }));
  return (fail?: unknown) => act(async () => { settle(fail); await vi.advanceTimersByTimeAsync(0); });
}

test("a reply that settles before the 202 arrives is still shown, with no further event", async () => {
  const { client, run, store, push } = await mount(at("findings"));
  const resolveGate = deferGate(client);
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(1);
  run.mockResolvedValue(at("findings", { proposal, decisions: [instructed("exclude row 2")] }));
  push("decision", { entry: instructed("exclude row 2") });
  push("idle");
  await flush();
  expect(store.get().busy).toBe(false);
  await resolveGate();
  expect(agentReplies()[0]).toContain("Exclude row 2 from the import.");
  expect(screen.getByTestId("chat-user").textContent).toBe("You: exclude row 2");
});

test("a timed-out instruct the run already settled is shown as received, with its reply", async () => {
  const { client, run, store, push } = await mount(at("findings"));
  const resolveGate = deferGate(client);
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  run.mockResolvedValue(at("findings", { proposal, decisions: [instructed("exclude row 2")] }));
  push("decision", { entry: instructed("exclude row 2") });
  push("idle");
  await flush();
  expect(store.get().busy).toBe(false);
  await resolveGate(new RequestTimeout(30, "rid"));
  expect(agentReplies()[0]).toContain("Exclude row 2 from the import.");
  expect(screen.getByTestId("chat-user").textContent).toBe("You: exclude row 2");
  expect(store.get().error).toBeNull();
});

test("an Apply whose verdict settles before the 202 arrives still shows it", async () => {
  const { client, run, store, push } = await withProposal();
  const resolveGate = deferGate(client);
  fireEvent.click(applyButtons()[0]!);
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(2);
  run.mockResolvedValue(at("findings", { proposal: null, decisions: [instructed("exclude row 2"), changed(2)] }));
  push("decision", { entry: changed(2) });
  push("idle");
  await flush();
  expect(store.get().busy).toBe(false);
  await resolveGate();
  expect(el("chat-outcome").textContent).toBe("Applied.");
});

test("Send stays blocked while a reply is pending, even after the store's hold is gone, until the bound runs out", async () => {
  const { client, store } = await mount(at("findings"), { chatTimeoutMs: 2 * GATE_SETTLE_TIMEOUT_MS });
  type("exclude row 2");
  fireEvent.click(send());
  await flush();
  await flush(GATE_SETTLE_TIMEOUT_MS); // the hold is released (stream not connected), the reply bound has not run out
  expect(store.get().busy).toBe(false);
  type("another instruction");
  expect(send().disabled).toBe(true);
  fireEvent.click(send());
  fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
  await flush();
  expect(client.gate).toHaveBeenCalledTimes(1);
  await flush(GATE_SETTLE_TIMEOUT_MS);
  expect(agentReplies()).toEqual(["Agent: No reply yet — the agent may still be working; check the gate."]);
  expect(send().disabled).toBe(false);
});

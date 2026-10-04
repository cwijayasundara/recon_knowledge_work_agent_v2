import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Brief, Question } from "../../src/api/types";
import type { Client } from "../../src/api/client";
import type { RunState, RunStore } from "../../src/state/store";
import { BriefCard, UNAPPLIED_HINT } from "../../src/ui/BriefCard";
import { Pane } from "../../src/ui/Pane";
import { Progress } from "../../src/ui/Progress";
import { QuestionCard } from "../../src/ui/QuestionCard";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const question: Question = { id: "q1", text: "Which column is the ID?", options: ["Col A", "Col B"], evidence: "ev", target: "affiliate_id" };
const brief: Brief = {
  source: { file: "f.xlsx", sheet: "S1", header_row: 2, rows_read: 10, rows_emitted: 9, rows_dropped: 1, drop_reasons: [] },
  bindings: [
    { field: "affiliate_id", column: "Col A", route: "exact", confidence: 0.93, evidence: "e" },
    { field: "affiliate_name", column: null, route: null, confidence: null, evidence: "" },
  ],
  id_strategy: "source_id",
  item_type: "Affiliate",
  recipe: { kind: "builtin", id: null },
  expected_findings: ["DUPLICATE_ID"],
  questions: [question],
  confidence: 0.9,
  summary: "Looks like an affiliate list.",
};

test("brief card shows summary, readable mapping lines and expected findings", () => {
  render(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} />);
  const t = screen.getByTestId("brief-card").textContent ?? "";
  expect(t).toContain("Looks like an affiliate list.");
  expect(t).toContain("DUPLICATE_ID");
  expect(screen.getByTestId("binding-affiliate_id").textContent).toBe('Affiliate ID ← column "Col A" · 93%');
  // Confidence only when present; never "(n/a)".
  expect(screen.getByTestId("binding-affiliate_name").textContent).toBe("Affiliate Name ← no column");
  expect(t).not.toContain("n/a");
  expect(screen.getByTestId("brief-layout").textContent).toBe("S1, header row 2: 10 rows read, 9 emitted");
  expect(screen.getByTestId("brief-dropped").textContent).toBe("1 dropped");
});

test("an unknown field falls back to its raw name; drop reasons are listed", () => {
  const odd = { ...brief, source: { ...brief.source, drop_reasons: ["blank id", "total row"] }, bindings: [{ field: "fund_code" as never, column: "F", route: null, confidence: null, evidence: "" }] };
  render(<BriefCard brief={odd} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} />);
  expect(screen.getByTestId("binding-fund_code").textContent).toBe('fund_code ← column "F"');
  expect(screen.getByTestId("brief-dropped").textContent).toBe("1 dropped: blank id; total row");
});

test("Approve is the card's first control and its only primary button; overrides are secondary", () => {
  render(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} onShowColumn={() => {}} onUseSelected={async () => null} headers={["Col A", "Col B"]} />);
  const card = screen.getByTestId("brief-card");
  const controls = Array.from(card.querySelectorAll("button, select, summary"));
  expect(controls[0]).toBe(screen.getByTestId("approve-brief"));
  expect(Array.from(card.querySelectorAll("button.primary"))).toEqual([screen.getByTestId("approve-brief")]);
  for (const name of ["Show in sheet", "Use selected column", "Apply change"]) {
    for (const b of screen.getAllByRole("button", { name })) expect(b.classList.contains("secondary")).toBe(true);
  }
});

test("questions sit above the mapping under 'Needs your input' and post their answer", () => {
  const onAnswer = vi.fn();
  render(<BriefCard brief={brief} busy={false} canApprove={false} onApprove={() => {}} onAnswer={onAnswer} onColumn={() => {}} />);
  const needs = screen.getByTestId("needs-input");
  expect(needs.textContent).toContain("Needs your input");
  expect(needs.compareDocumentPosition(screen.getByTestId("bindings")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Col B" }));
  expect(onAnswer).toHaveBeenCalledWith("q1", "Col B");
  cleanup();
  render(<BriefCard brief={{ ...brief, questions: [] }} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} />);
  expect(screen.queryByTestId("needs-input")).toBeNull();
});

test("Change mapping is collapsed by default and holds the overrides", () => {
  render(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} onShowColumn={() => {}} onUseSelected={async () => null} headers={["Col A", "Col B"]} />);
  const details = screen.getByTestId("change-mapping") as HTMLDetailsElement;
  expect(details.tagName).toBe("DETAILS");
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe("Change mapping");
  for (const el of [...screen.getAllByRole("combobox"), ...screen.getAllByRole("button", { name: /Show in sheet|Use selected column|Apply change/ })]) {
    expect(details.contains(el)).toBe(true);
  }
});

test("a select change only stages; Apply change posts exactly one binding and is disabled until it differs", () => {
  const onColumn = vi.fn();
  render(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={onColumn} headers={["Col A", "Col B"]} />);
  const sel = screen.getByLabelText("Column for Affiliate ID") as HTMLSelectElement;
  const apply = screen.getByTestId("apply-affiliate_id") as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.change(sel, { target: { value: "Col B" } });
  expect(onColumn).not.toHaveBeenCalled();
  expect(sel.value).toBe("Col B");
  expect(apply.disabled).toBe(false);
  fireEvent.change(sel, { target: { value: "Col A" } }); // back to the server's binding: nothing to apply
  expect(apply.disabled).toBe(true);
  fireEvent.click(apply);
  expect(onColumn).not.toHaveBeenCalled();
  fireEvent.change(sel, { target: { value: "Col B" } });
  fireEvent.click(apply);
  expect(onColumn).toHaveBeenCalledTimes(1);
  expect(onColumn).toHaveBeenCalledWith("affiliate_id", "Col B");
  // Picking "(none)" for an unbound field is no change.
  const none = screen.getByTestId("apply-affiliate_name") as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText("Column for Affiliate Name"), { target: { value: "" } });
  expect(none.disabled).toBe(true);
});

test("a staged choice resets when the server's binding changes", () => {
  const props = { busy: false, canApprove: true, onApprove: () => {}, onColumn: () => {}, headers: ["Col A", "Col B", "Col C"] };
  const { rerender } = render(<BriefCard brief={brief} {...props} />);
  fireEvent.change(screen.getByLabelText("Column for Affiliate ID"), { target: { value: "Col C" } });
  expect((screen.getByTestId("apply-affiliate_id") as HTMLButtonElement).disabled).toBe(false);
  const moved = { ...brief, bindings: [{ ...brief.bindings[0]!, column: "Col B" }, brief.bindings[1]!] };
  rerender(<BriefCard brief={moved} {...props} />);
  expect((screen.getByLabelText("Column for Affiliate ID") as HTMLSelectElement).value).toBe("Col B");
  expect((screen.getByTestId("apply-affiliate_id") as HTMLButtonElement).disabled).toBe(true);
});

test("a staged pick disables Approve, shows the hint and opens Change mapping; Discard clears it without posting", () => {
  const onApprove = vi.fn();
  const onColumn = vi.fn();
  render(<BriefCard brief={brief} busy={false} canApprove onApprove={onApprove} onColumn={onColumn} headers={["Col A", "Col B"]} />);
  const approve = screen.getByTestId("approve-brief") as HTMLButtonElement;
  const details = screen.getByTestId("change-mapping") as HTMLDetailsElement;
  expect(approve.disabled).toBe(false);
  expect(screen.queryByTestId("unapplied-hint")).toBeNull();
  fireEvent.change(screen.getByLabelText("Column for Affiliate ID"), { target: { value: "Col B" } });
  expect(approve.disabled).toBe(true);
  expect(screen.getByTestId("unapplied-hint").textContent).toContain(UNAPPLIED_HINT);
  expect(details.open).toBe(true);
  // The hint sits right under Approve.
  expect(approve.nextElementSibling).toBe(screen.getByTestId("unapplied-hint"));
  fireEvent.click(approve);
  expect(onApprove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard change" }));
  expect(screen.queryByTestId("unapplied-hint")).toBeNull();
  expect((screen.getByLabelText("Column for Affiliate ID") as HTMLSelectElement).value).toBe("Col A");
  expect(approve.disabled).toBe(false);
  expect(onColumn).not.toHaveBeenCalled();
  fireEvent.click(approve);
  expect(onApprove).toHaveBeenCalledTimes(1);
});

test("the unapplied rule does not override the server: blocked or busy stays disabled; Discard is disabled while busy", () => {
  const props = { brief, onApprove: () => {}, onColumn: () => {}, headers: ["Col A", "Col B"] };
  const { rerender } = render(<BriefCard {...props} busy={false} canApprove={false} />);
  fireEvent.change(screen.getByLabelText("Column for Affiliate ID"), { target: { value: "Col B" } });
  fireEvent.click(screen.getByTestId("discard-change"));
  expect((screen.getByTestId("approve-brief") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Column for Affiliate ID"), { target: { value: "Col B" } });
  rerender(<BriefCard {...props} busy canApprove />);
  fireEvent.click(screen.getByTestId("discard-change"));
  expect((screen.getByTestId("discard-change") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("unapplied-hint")).toBeTruthy();
});

test("Apply change, then the server's new binding, then Approve works", () => {
  const onApprove = vi.fn();
  const onColumn = vi.fn();
  const props = { busy: false, canApprove: true, onApprove, onColumn, headers: ["Col A", "Col B"] };
  const { rerender } = render(<BriefCard brief={brief} {...props} />);
  fireEvent.change(screen.getByLabelText("Column for Affiliate ID"), { target: { value: "Col B" } });
  fireEvent.click(screen.getByTestId("apply-affiliate_id"));
  expect(onColumn).toHaveBeenCalledExactlyOnceWith("affiliate_id", "Col B");
  // Still pending until the server reports the new binding (a refused change keeps it staged).
  expect((screen.getByTestId("approve-brief") as HTMLButtonElement).disabled).toBe(true);
  rerender(<BriefCard brief={{ ...brief, bindings: [{ ...brief.bindings[0]!, column: "Col B" }, brief.bindings[1]!] }} {...props} />);
  expect(screen.queryByTestId("unapplied-hint")).toBeNull();
  fireEvent.click(screen.getByTestId("approve-brief"));
  expect(onApprove).toHaveBeenCalledTimes(1);
});

test("Use selected column stages the header it reads; only Apply change posts it", async () => {
  const onColumn = vi.fn();
  const onUseSelected = vi.fn(async () => "Col Z");
  render(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={onColumn} onUseSelected={onUseSelected} headers={["Col A", "Col B"]} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Use selected column" })[0]!);
  const sel = screen.getByLabelText("Column for Affiliate ID") as HTMLSelectElement;
  await waitFor(() => expect(sel.value).toBe("Col Z"));
  expect(onUseSelected).toHaveBeenCalledWith("affiliate_id");
  expect(onColumn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("apply-affiliate_id"));
  expect(onColumn).toHaveBeenCalledExactlyOnceWith("affiliate_id", "Col Z");
});

test("approve disabled when blocked or busy, enabled otherwise", () => {
  const onApprove = vi.fn();
  const { rerender } = render(<BriefCard brief={brief} busy={false} canApprove={false} onApprove={onApprove} onColumn={() => {}} />);
  expect((screen.getByTestId("approve-brief") as HTMLButtonElement).disabled).toBe(true);
  rerender(<BriefCard brief={brief} busy canApprove onApprove={onApprove} onColumn={() => {}} />);
  expect((screen.getByTestId("approve-brief") as HTMLButtonElement).disabled).toBe(true);
  rerender(<BriefCard brief={brief} busy={false} canApprove onApprove={onApprove} onColumn={() => {}} />);
  fireEvent.click(screen.getByTestId("approve-brief"));
  expect(onApprove).toHaveBeenCalledTimes(1);
});

test("question click posts; disabled while busy; re-enabled after a failure so it can retry", () => {
  const onAnswer = vi.fn();
  const { rerender } = render(<QuestionCard question={question} busy={false} onAnswer={onAnswer} />);
  expect(screen.getByTestId("question-card").textContent).toContain("Which column is the ID?");
  fireEvent.click(screen.getByRole("button", { name: "Col B" }));
  expect(onAnswer).toHaveBeenCalledWith("Col B");
  rerender(<QuestionCard question={question} busy onAnswer={onAnswer} />);
  for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  rerender(<QuestionCard question={question} busy={false} onAnswer={onAnswer} />);
  const b = screen.getByRole("button", { name: "Col B" }) as HTMLButtonElement;
  expect(b.disabled).toBe(false);
  fireEvent.click(b);
  expect(onAnswer).toHaveBeenCalledTimes(2);
});

test("column select keeps an unlisted current column and is omitted without headers", () => {
  const { rerender } = render(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} headers={["X", "Y"]} />);
  const sel = screen.getByLabelText("Column for Affiliate ID") as HTMLSelectElement;
  expect(sel.value).toBe("Col A");
  expect(Array.from(sel.options).map((o) => o.value)).toContain("Col A");
  rerender(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} headers={[]} />);
  expect(screen.queryByLabelText("Column for Affiliate ID")).toBeNull();
});

test("question buttons disabled while busy", () => {
  render(<QuestionCard question={question} busy onAnswer={() => {}} />);
  for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
});

function paneWith(state: Partial<RunState>) {
  const full: RunState = { runId: "r1", snap: null, grid: [], activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null, ...state };
  const store: RunStore = {
    get: () => full, subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), respond: vi.fn(async () => true),
  };
  const client = { sponsors: vi.fn(async () => []) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} />);
  return store;
}

const gated = (over: Partial<NonNullable<ReturnType<typeof fakeSnapshot>["pending"]>> = {}) =>
  fakeSnapshot({ brief, pending: { gate: "brief", message: null, blocked_reasons: [], allowed_actions: ["approve", "answer"], ...over } });

test("pane mounts cards at the brief gate and posts nothing on render", () => {
  const store = paneWith({ snap: gated() });
  expect(screen.getByTestId("brief-card")).toBeTruthy();
  expect(screen.getAllByTestId("question-card")).toHaveLength(1);
  expect(store.respond).not.toHaveBeenCalled();
});

test("pane: a column select change posts nothing; Apply change posts one set_column_binding", () => {
  const store = paneWith({ snap: fakeSnapshot({ brief, resolution: { headers: ["Col A", "Col B"] } as unknown as ReturnType<typeof fakeSnapshot>["resolution"], pending: { gate: "brief", message: null, blocked_reasons: [], allowed_actions: ["approve", "answer", "change"] } }) });
  fireEvent.change(screen.getByLabelText("Column for Affiliate ID"), { target: { value: "Col B" } });
  fireEvent.change(screen.getByLabelText("Column for Affiliate ID"), { target: { value: "" } });
  expect(store.respond).not.toHaveBeenCalled();
  expect((screen.getByTestId("approve-brief") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId("approve-brief"));
  expect(store.respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("apply-affiliate_id"));
  expect(store.respond).toHaveBeenCalledTimes(1);
  expect(store.respond).toHaveBeenCalledWith({ action: "change", changes: [{ kind: "set_column_binding", field: "affiliate_id", column: null }] });
});

test("pane posts answer and approve bodies from clicks", () => {
  const store = paneWith({ snap: gated() });
  fireEvent.click(screen.getByRole("button", { name: "Col B" }));
  expect(store.respond).toHaveBeenCalledWith({ action: "answer", question_id: "q1", option: "Col B" });
  fireEvent.click(screen.getByTestId("approve-brief"));
  expect(store.respond).toHaveBeenCalledWith({ action: "approve" });
});

test("pane shows blocked reasons verbatim and disables approve", () => {
  paneWith({ snap: gated({ blocked_reasons: ["Answer all questions first"], allowed_actions: ["answer"] }) });
  expect(screen.getByTestId("brief-card").textContent).toContain("Answer all questions first");
  expect((screen.getByTestId("approve-brief") as HTMLButtonElement).disabled).toBe(true);
});

test("pane hides cards at other gates and when busy disables buttons", () => {
  paneWith({ snap: fakeSnapshot({ brief, pending: { gate: "findings", message: null, blocked_reasons: [], allowed_actions: [] } }) });
  expect(screen.queryByTestId("brief-card")).toBeNull();
  cleanup();
  paneWith({ snap: gated(), busy: true });
  for (const b of screen.getAllByRole("button", { name: /Col|Approve/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
});

test("while busy, no card control posts even if a click or change gets through (jsdom dispatches to disabled controls)", () => {
  const onApprove = vi.fn();
  const onColumn = vi.fn();
  const onUseSelected = vi.fn();
  const onAnswer = vi.fn();
  render(<BriefCard brief={brief} busy canApprove onApprove={onApprove} onColumn={onColumn} onUseSelected={onUseSelected} headers={["X", "Y"]} />);
  fireEvent.click(screen.getByTestId("approve-brief"));
  fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "Y" } });
  for (const b of screen.getAllByText("Use selected column")) fireEvent.click(b);
  for (const b of screen.getAllByText("Apply change")) fireEvent.click(b);
  render(<QuestionCard question={question} busy onAnswer={onAnswer} />);
  for (const b of screen.getAllByRole("button", { name: question.options[0] })) fireEvent.click(b);
  expect([onApprove, onColumn, onUseSelected, onAnswer].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0]);
});

test("activity lines sit in a collapsed Activity disclosure; phase and status stay visible", () => {
  const state: RunState = { runId: "r1", snap: fakeSnapshot({ phase: "p2", status: "awaiting_brief" }), grid: [], activity: ["Agent: scope mode", "analyst: brief.change"], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null };
  render(<Progress state={state} />);
  const details = screen.getByTestId("activity") as HTMLDetailsElement;
  expect(details.tagName).toBe("DETAILS");
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe("Activity");
  expect(details.textContent).toContain("Agent: scope mode");
  const progress = screen.getByTestId("progress");
  expect(progress.textContent).toContain("Status: awaiting_brief");
  expect(details.textContent).not.toContain("Status:");
});

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Brief, Question } from "../../src/api/types";
import type { Client } from "../../src/api/client";
import type { RunState, RunStore } from "../../src/state/store";
import { BriefCard } from "../../src/ui/BriefCard";
import { Pane } from "../../src/ui/Pane";
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

test("brief card shows summary, bindings and expected findings", () => {
  render(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} />);
  const t = screen.getByTestId("brief-card").textContent ?? "";
  expect(t).toContain("Looks like an affiliate list.");
  expect(t).toContain("affiliate_id");
  expect(t).toContain("Col A");
  expect(t).toContain("93%");
  expect(t).toContain("DUPLICATE_ID");
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
  const sel = screen.getByLabelText("Column for affiliate_id") as HTMLSelectElement;
  expect(sel.value).toBe("Col A");
  expect(Array.from(sel.options).map((o) => o.value)).toContain("Col A");
  rerender(<BriefCard brief={brief} busy={false} canApprove onApprove={() => {}} onColumn={() => {}} headers={[]} />);
  expect(screen.queryByLabelText("Column for affiliate_id")).toBeNull();
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
  render(<QuestionCard question={question} busy onAnswer={onAnswer} />);
  for (const b of screen.getAllByRole("button", { name: question.options[0] })) fireEvent.click(b);
  expect([onApprove, onColumn, onUseSelected, onAnswer].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0]);
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "../../src/api/client";
import type { Artifact, Brief, Finding, Pending, Snapshot } from "../../src/api/types";
import { CopilotDisabled, CopilotError, type CopilotSession, type TurnResult } from "../../src/copilot/session";
import type { RunState, RunStore } from "../../src/state/store";
import { Pane } from "../../src/ui/Pane";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const brief: Brief = {
  source: { file: "f.xlsx", sheet: "S1", header_row: 3, rows_read: 2, rows_emitted: 2, rows_dropped: 0, drop_reasons: [] },
  bindings: [
    { field: "affiliate_id", column: "Affiliate ID", route: "exact", confidence: 0.9, evidence: "e" },
    { field: "affiliate_name", column: null, route: null, confidence: null, evidence: "" },
  ],
  id_strategy: "source_id", item_type: "Affiliate", recipe: { kind: "builtin", id: null },
  expected_findings: ["DUPLICATE_ID"],
  questions: [{ id: "q1", text: "Which column is the ID?", options: ["Col A", "Col B"], evidence: "ev", target: "affiliate_id" }],
  confidence: 0.9, summary: "Looks like an affiliate list.",
};
const finding = (over: Partial<Finding>): Finding => ({ code: "W1", severity: "warning", scope: "row", row: 2, source_row: 5, message: "msg", requires_ack: true, acknowledged: false, ...over });
const result = {
  rows_emitted: 0, rows_dropped: 0, findings_by_code: {}, errors: 1, ack_required: 1, publishable: false,
  findings: [finding({ code: "E1", severity: "error", message: "bad id", row: 3, source_row: 6 }), finding({ message: "odd name" })],
};
const art = (name: string): Artifact => ({ name, key: `k/${name}`, sha256: "abcdef1234567890", kind: "csv", bytes: 120 });

function mount(snap: Snapshot, copilotSession?: () => CopilotSession) {
  const state: RunState = { runId: "r1", snap, grid: [], activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null };
  const store: RunStore = { get: () => state, subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), respond: vi.fn(async () => true) };
  const client = { sponsors: vi.fn(async () => [{ id: "sponsor-a", name: "Sponsor A" }]) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} download={{ saveBlob: vi.fn(), openBrowser: vi.fn() }} copilotSession={copilotSession} />);
}

const INTERACTIVE = "button, select, input, textarea, a, [role], [tabindex], [onclick]";
const NATIVE = new Set(["BUTTON", "SELECT", "INPUT", "TEXTAREA"]);
/** Live regions announce text; they are not controls (and must not be focusable). */
const LIVE = new Set(["log", "status", "alert"]);

function accessibleName(el: HTMLElement): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  const fromIds = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
  const labels = "labels" in el ? Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.textContent ?? "").join(" ") : "";
  return (el.getAttribute("aria-label") ?? fromIds ?? "").trim() || labels.trim() || (["SELECT", "INPUT", "TEXTAREA"].includes(el.tagName) ? "" : (el.textContent ?? "").trim());
}

function assertAccessible(): number {
  const all = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE));
  const live = all.filter((el) => LIVE.has(el.getAttribute("role") ?? "") && !NATIVE.has(el.tagName));
  for (const el of live) expect(el.hasAttribute("tabindex"), "a live region must not be focusable").toBe(false);
  const els = all.filter((el) => !live.includes(el));
  for (const el of els) {
    const where = `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.textContent?.slice(0, 20)}]`;
    expect(NATIVE.has(el.tagName), `${where} must be a native button/select/input`).toBe(true);
    expect(el.getAttribute("role"), `${where} must not override its role`).toBeNull();
    expect(accessibleName(el), `${where} needs an accessible name`).not.toBe("");
    expect(el.tabIndex, `${where} must be Tab-reachable`).toBeGreaterThanOrEqual(0);
    if (el.tagName === "BUTTON") expect(el.getAttribute("type"), `${where} needs type=button`).toBe("button");
  }
  return els.length;
}

test("brief gate: brief card, column selects and question buttons are native, named and reachable", () => {
  const pending: Pending = { gate: "brief", message: null, blocked_reasons: [], allowed_actions: ["approve"] };
  mount(fakeSnapshot({ brief, layout: { sheet: "S1", header_row: 3 }, pending, resolution: { headers: ["Affiliate ID", "Affiliate Name"] } as unknown as Snapshot["resolution"] }));
  expect(screen.getByTestId("brief-card")).toBeTruthy();
  expect(screen.getByTestId("question-card")).toBeTruthy();
  expect(document.querySelectorAll("select").length).toBeGreaterThanOrEqual(3);
  expect(assertAccessible()).toBeGreaterThan(6);
  // Disclosures are native details/summary with a visible name, reachable by keyboard.
  const summaries = Array.from(document.querySelectorAll("summary"));
  expect(summaries.map((el) => el.textContent)).toContain("Change mapping");
  for (const el of summaries) {
    expect(el.parentElement?.tagName).toBe("DETAILS");
    expect((el.textContent ?? "").trim()).not.toBe("");
  }
  // Each override group is named by its field.
  for (const legend of Array.from(document.querySelectorAll("fieldset > legend"))) expect(legend.textContent).not.toBe("");
});

test("sign-off gate: findings and artifact controls are native, named and reachable", () => {
  const pending: Pending = { gate: "signoff", message: null, blocked_reasons: [], allowed_actions: ["approve"], artifacts: [art("Affiliates.csv"), art("review.xlsx")] };
  mount(fakeSnapshot({ layout: { sheet: "S1", header_row: 3 }, result, pending, artifacts: [art("Affiliates.csv"), art("review.xlsx")] }));
  expect(screen.getByTestId("findings-list")).toBeTruthy();
  expect(screen.getByTestId("signoff-approve")).toBeTruthy();
  expect(assertAccessible()).toBeGreaterThan(6);
});

test("severity is never colour alone: findings and banners carry a text label", () => {
  const pending: Pending = { gate: "findings", message: null, blocked_reasons: [], allowed_actions: ["approve", "change"] };
  mount(fakeSnapshot({ layout: { sheet: "S1", header_row: 3 }, result, pending }));
  const items = screen.getAllByRole("listitem");
  expect(items[0]!.textContent).toMatch(/^Error\b/);
  expect(items[1]!.textContent).toMatch(/^Warning\b/);
});

test("chat: the toggle states aria-expanded and controls the panel; composer, Send and the log are named", () => {
  const pending: Pending = { gate: "findings", message: null, blocked_reasons: [], allowed_actions: ["approve", "change", "instruct"] };
  mount(fakeSnapshot({ layout: { sheet: "S1", header_row: 3 }, result, pending }));
  const toggle = screen.getByRole("button", { name: "Chat" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toBe(screen.getByTestId("chat-panel"));
  toggle.click();
  return Promise.resolve().then(() => {
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "Ask the agent" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Instruction for the agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(assertAccessible()).toBeGreaterThan(4);
  });
});

test("chat: the disabled hint is text, not colour alone", () => {
  const pending: Pending = { gate: "signoff", message: null, blocked_reasons: [], allowed_actions: ["approve"] };
  mount(fakeSnapshot({ layout: { sheet: "S1", header_row: 3 }, result, pending }));
  screen.getByRole("button", { name: "Chat" }).click();
  return Promise.resolve().then(() => {
    expect(screen.getByTestId("chat-hint").textContent).toBe("Chat is available at the brief and findings gates.");
    expect((screen.getByRole("textbox", { name: "Instruction for the agent" }) as HTMLTextAreaElement).disabled).toBe(true);
  });
});

/** A copilot session that answers each send with the next of `answers` (a TurnResult, or an error to reject with). */
function scriptedSession(answers: (TurnResult | Error)[], ensure: () => Promise<string> = async () => "sess_1"): () => CopilotSession {
  return () => ({
    sessionId: "sess_1",
    limits: { max_cells_per_call: 2000, max_cells_per_session: 20000, max_steps_per_turn: 8, max_write_cells: 2000, cell_char_limit: 500 },
    ensureSession: ensure,
    send: async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    },
    stop: () => undefined,
    close: async () => undefined,
  });
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

test("copilot: the toggle states aria-expanded and controls the panel; region, composer, Send, log and cards are named", async () => {
  const pending: Pending = { gate: "findings", message: null, blocked_reasons: [], allowed_actions: ["approve", "change", "instruct"] };
  const answer: TurnResult = {
    text: "Here.", notes: ["n"], restarted: false,
    read: [{ tool: "read_range", sheet: "Data", range: "A1:B2", cells: 4, ok: true }],
    proposedChanges: [{ kind: "exclude_row", row: 2, reason: "dup" }],
    proposedWrites: [{ sheet: "Data", range: "A1", values: [["x"]], note: "" }],
  };
  mount(fakeSnapshot({ layout: { sheet: "S1", header_row: 3 }, result, pending }), scriptedSession([answer, new CopilotError("busy", "req-1")]));
  const toggle = screen.getByRole("button", { name: "Copilot" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toBe(screen.getByTestId("copilot-panel"));
  fireEvent.click(toggle);
  await flush();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("region", { name: "Copilot" })).toBeTruthy();
  const box = screen.getByRole("textbox", { name: "Message for the copilot" });
  const log = screen.getByRole("log", { name: "Copilot conversation" });
  expect(log.getAttribute("aria-live")).toBe("polite");
  expect(log.hasAttribute("tabindex")).toBe(false);
  fireEvent.input(box, { target: { value: "what is here?" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Send" }).find((b) => b.getAttribute("data-testid") === "copilot-send")!);
  await flush();
  // Cards: read log disclosure, typed-change Apply, write buttons; all native, named, reachable.
  expect(screen.getByTestId("copilot-read").querySelector("summary")!.textContent).toMatch(/^What the copilot read/);
  expect(screen.getByTestId("copilot-apply-changes").textContent).toBe("Apply");
  expect(screen.getByRole("button", { name: "Apply to Copilot Scratch" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Apply to Data!A1…" })).toBeTruthy();
  expect(assertAccessible()).toBeGreaterThan(8);
  // An error is labelled in text, not colour alone.
  fireEvent.input(box, { target: { value: "again" } });
  fireEvent.click(screen.getByTestId("copilot-send"));
  await flush();
  expect(screen.getByTestId("copilot-error").textContent).toMatch(/^Error: /);
});

test("copilot: 'turned off' is stated in text with a named 'Check again' button", async () => {
  mount(fakeSnapshot({}), scriptedSession([], async () => { throw new CopilotDisabled(); }));
  fireEvent.click(screen.getByRole("button", { name: "Copilot" }));
  await flush();
  expect(screen.getByTestId("copilot-disabled").textContent).toMatch(/^Unavailable: Copilot is turned off on this server\./);
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Message for the copilot" }) as HTMLTextAreaElement).disabled).toBe(true);
  expect(assertAccessible()).toBeGreaterThan(2);
});

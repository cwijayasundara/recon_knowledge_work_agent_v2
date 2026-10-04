import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "../../src/api/client";
import type { Artifact, Brief, Finding, Pending, Snapshot } from "../../src/api/types";
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

function mount(snap: Snapshot) {
  const state: RunState = { runId: "r1", snap, grid: [], activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0 };
  const store: RunStore = { get: () => state, subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), respond: vi.fn(async () => true) };
  const client = { sponsors: vi.fn(async () => [{ id: "sponsor-a", name: "Sponsor A" }]) } as unknown as Client;
  render(<Pane client={client} store={store} readFile={vi.fn()} download={{ saveBlob: vi.fn(), openBrowser: vi.fn() }} />);
}

const INTERACTIVE = "button, select, input, textarea, a, [role], [tabindex], [onclick]";
const NATIVE = new Set(["BUTTON", "SELECT", "INPUT"]);

function accessibleName(el: HTMLElement): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  const fromIds = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
  const labels = "labels" in el ? Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.textContent ?? "").join(" ") : "";
  return (el.getAttribute("aria-label") ?? fromIds ?? "").trim() || labels.trim() || (el.tagName === "SELECT" || el.tagName === "INPUT" ? "" : (el.textContent ?? "").trim());
}

function assertAccessible(): number {
  const els = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE));
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

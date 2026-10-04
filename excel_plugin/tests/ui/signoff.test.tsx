import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "../../src/api/client";
import { ApiError } from "../../src/api/client";
import type { Artifact } from "../../src/api/types";
import type { RunState, RunStore } from "../../src/state/store";
import { Pane } from "../../src/ui/Pane";
import { SignOff } from "../../src/ui/SignOff";
import { fakeSnapshot } from "../support/fakes";

afterEach(cleanup);

const art = (name: string, over: Partial<Artifact> = {}): Artifact => ({ name, key: `k/${name}`, sha256: "abcdef1234567890", kind: "csv", bytes: 120, ...over });
const signoff = (blocked: string[] = [], allowed = ["approve", "reject"]) =>
  fakeSnapshot({ pending: { gate: "signoff", message: null, blocked_reasons: blocked, allowed_actions: allowed } });

test("approve is enabled only when the gate allows it, and posts approve", () => {
  const onApprove = vi.fn();
  render(<SignOff snap={signoff()} busy={false} onApprove={onApprove} artifacts={[]} onDownload={async () => ({ kind: "saved" })} onOpenBrowser={async () => ({ kind: "browser" })} />);
  const b = screen.getByTestId("signoff-approve") as HTMLButtonElement;
  expect(b.disabled).toBe(false);
  fireEvent.click(b);
  expect(onApprove).toHaveBeenCalledTimes(1);
});

test("approve is disabled when busy, blocked or not offered; reasons shown verbatim", () => {
  const { rerender } = render(<SignOff snap={signoff()} busy onApprove={() => {}} artifacts={[]} onDownload={async () => ({ kind: "saved" })} onOpenBrowser={async () => ({ kind: "browser" })} />);
  expect((screen.getByTestId("signoff-approve") as HTMLButtonElement).disabled).toBe(true);
  rerender(<SignOff snap={signoff(["2 errors remain"])} busy={false} onApprove={() => {}} artifacts={[]} onDownload={async () => ({ kind: "saved" })} onOpenBrowser={async () => ({ kind: "browser" })} />);
  expect((screen.getByTestId("signoff-approve") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId("blocked-reasons").textContent).toBe("2 errors remain");
  rerender(<SignOff snap={signoff([], ["reject"])} busy={false} onApprove={() => {}} artifacts={[]} onDownload={async () => ({ kind: "saved" })} onOpenBrowser={async () => ({ kind: "browser" })} />);
  expect((screen.getByTestId("signoff-approve") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/reject/i)).toBeNull();
});

test("lists artifacts with sha and size; download calls onDownload and shows errors with ref", async () => {
  const onDownload = vi.fn(async () => ({ kind: "error" as const, message: "no such artifact", requestId: "req-1" }));
  render(<SignOff snap={signoff()} busy={false} onApprove={() => {}} artifacts={[art("Affiliates.csv"), art("review.xlsx", { kind: "json" })]} onDownload={onDownload} onOpenBrowser={async () => ({ kind: "browser" })} />);
  expect(screen.getAllByText(/abcdef123456/)).toHaveLength(2);
  fireEvent.click(screen.getByTestId("download-review.xlsx"));
  expect(onDownload).toHaveBeenCalledWith("review.xlsx");
  await waitFor(() => expect(screen.getByTestId("error-banner").textContent).toContain("no such artifact"));
  expect(screen.getByTestId("error-banner").textContent).toContain("req-1");
});

const EMPTY: RunState = { runId: "r1", snap: null, grid: [], activity: [], error: null, busy: false, connection: "connected", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null };
function mount(snap: ReturnType<typeof fakeSnapshot>, client: Partial<Client>, download = { saveBlob: vi.fn(async () => {}), openBrowser: vi.fn(async () => {}) }) {
  const store = { get: () => ({ ...EMPTY, snap }), subscribe: () => () => {}, start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), respond: vi.fn(async () => true) } as unknown as RunStore;
  const full = { sponsors: async () => [], ...client } as unknown as Client;
  render(<Pane client={full} store={store} readFile={vi.fn()} download={download} />);
  return { store, download };
}

test("pane dedupes artifacts, approves only on click, and downloads through the client", async () => {
  const blob = new Blob(["x"]);
  const artifact = vi.fn(async () => blob);
  const snap = fakeSnapshot({
    pending: { gate: "signoff", message: null, blocked_reasons: [], allowed_actions: ["approve"], artifacts: [art("Affiliates.csv")] },
    artifacts: [art("Affiliates.csv"), art("review.xlsx", { kind: "xlsx" })],
  });
  const { store, download } = mount(snap, { artifact });
  expect(store.respond).not.toHaveBeenCalled();
  expect(screen.getAllByTestId("download-Affiliates.csv")).toHaveLength(1);
  fireEvent.click(screen.getByTestId("download-Affiliates.csv"));
  await waitFor(() => expect(download.saveBlob).toHaveBeenCalledWith(blob, "Affiliates.csv"));
  expect(artifact).toHaveBeenCalledWith("r1", "Affiliates.csv");
  fireEvent.click(screen.getByTestId("signoff-approve"));
  expect(store.respond).toHaveBeenCalledWith({ action: "approve" });
});

test("pane keeps downloads available after the run locks, without an approve button", () => {
  mount(fakeSnapshot({ pending: null, status: "completed", artifacts: [art("Affiliates.csv")] }), { artifact: vi.fn() });
  expect(screen.getByTestId("download-Affiliates.csv")).toBeTruthy();
  expect(screen.queryByTestId("signoff-approve")).toBeNull();
});

test("pane shows a failed download verbatim with its ref", async () => {
  const artifact = vi.fn(async () => { throw new ApiError("no such artifact", 404, "req-7"); });
  mount(fakeSnapshot({ artifacts: [art("Affiliates.csv")] }), { artifact });
  fireEvent.click(screen.getByTestId("download-Affiliates.csv"));
  await waitFor(() => expect(screen.getByTestId("error-banner").textContent).toContain("req-7"));
});

test("each artifact has an Open in browser button; copy never claims the file was saved", async () => {
  const onDownload = vi.fn(async () => ({ kind: "saved" as const }));
  const onOpenBrowser = vi.fn(async () => ({ kind: "browser" as const }));
  render(<SignOff snap={signoff()} busy={false} onApprove={() => {}} artifacts={[art("Affiliates.csv"), art("review.xlsx")]} onDownload={onDownload} onOpenBrowser={onOpenBrowser} />);
  fireEvent.click(screen.getByTestId("download-Affiliates.csv"));
  await waitFor(() => expect(screen.getByTestId("note-Affiliates.csv").textContent).toBe("Download started. If no file appeared, use Open in browser."));
  expect(screen.queryByTestId("note-review.xlsx")).toBeNull();
  fireEvent.click(screen.getByTestId("browser-review.xlsx"));
  expect(onOpenBrowser).toHaveBeenCalledWith("review.xlsx");
  await waitFor(() => expect(screen.getByTestId("note-review.xlsx").textContent).toContain("Opened in your browser"));
  expect(screen.getByTestId("note-Affiliates.csv")).toBeTruthy();
});

test("a double click on one artifact only fires once", async () => {
  let release: () => void = () => {};
  const onDownload = vi.fn(() => new Promise<{ kind: "saved" }>((r) => { release = () => r({ kind: "saved" }); }));
  render(<SignOff snap={signoff()} busy={false} onApprove={() => {}} artifacts={[art("Affiliates.csv")]} onDownload={onDownload} onOpenBrowser={async () => ({ kind: "browser" })} />);
  const b = screen.getByTestId("download-Affiliates.csv");
  fireEvent.click(b);
  fireEvent.click(b);
  expect(onDownload).toHaveBeenCalledTimes(1);
  release();
  await waitFor(() => expect(screen.getByTestId("note-Affiliates.csv")).toBeTruthy());
});

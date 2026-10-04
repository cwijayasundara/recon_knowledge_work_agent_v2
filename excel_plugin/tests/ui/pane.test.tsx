import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, type Client } from "../../src/api/client";
import type { ExcelRun } from "../../src/office/highlight";
import { OWNER_MARK, REVIEW_SHEET } from "../../src/office/review";
import { WorkbookError, type WorkbookFile } from "../../src/office/workbook";
import type { RunState, RunStore } from "../../src/state/store";
import { Pane } from "../../src/ui/Pane";
import { fakeSnapshot } from "../support/fakes";
import { createFakeReview } from "../support/review-fake";

afterEach(cleanup);

const file: WorkbookFile = { blob: new Blob(["x"]), name: "affiliates.xlsx", sha256: "abc", bytes: 1 };
const EMPTY: RunState = { runId: null, snap: null, grid: [], activity: [], error: null, busy: false, connection: "idle", idleSeq: 0, snapIdleSeq: 0, postIdleSeq: 0, decisionLog: [], notice: null };

function setup(over: { readFile?: () => Promise<WorkbookFile>; startRun?: Client["startRun"]; snapSha?: string | undefined; order?: string[]; removeReview?: (signal: AbortSignal) => Promise<boolean>; initial?: RunState; sponsors?: Client["sponsors"]; excelOpTimeoutMs?: number; run?: ExcelRun } = {}) {
  const excel = createFakeReview();
  let state: RunState = over.initial ?? EMPTY;
  const listeners = new Set<() => void>();
  const store: RunStore = {
    get: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start: vi.fn((runId: string) => {
      over.order?.push("start"); state = { ...EMPTY, runId }; listeners.forEach((l) => l()); }),
    stop: vi.fn(() => { over.order?.push("stop"); state = EMPTY; listeners.forEach((l) => l()); }),
    refresh: vi.fn(async () => {
      state = { ...state, snap: fakeSnapshot({ upload: { key: "k", name: "n", sha256: "snapSha" in over ? over.snapSha : "abc" } }) };
      listeners.forEach((l) => l());
    }),
    respond: vi.fn(async () => true),
  };
  const startRun = over.startRun ?? vi.fn(async () => { over.order?.push("startRun"); return { run_id: "r1" }; });
  const run = vi.fn(async () => fakeSnapshot({ upload: { key: "k", name: "n", sha256: "snapSha" in over ? over.snapSha : "abc" } }));
  const sponsors = vi.fn(over.sponsors ?? (async () => [{ id: "sponsor-a", name: "Sponsor A" }]));
  const client = { sponsors, startRun, run } as unknown as Client;
  const readFile = over.readFile ?? vi.fn(async () => { over.order?.push("read"); return file; });
  const removeReview = over.removeReview ? vi.fn(over.removeReview) : undefined;
  const view = render(<Pane client={client} store={store} readFile={readFile} apiBase="https://api.example.test:8443" run={over.run ?? (excel.run as ExcelRun)} removeReview={removeReview} excelOpTimeoutMs={over.excelOpTimeoutMs} />);
  return { store, client, startRun, readFile, view, excel, sponsors };
}

async function choose() {
  await screen.findByRole("option", { name: "Sponsor A" });
  fireEvent.change(screen.getByTestId("sponsor-select"), { target: { value: "sponsor-a" } });
}

test("onboard is disabled until a sponsor is chosen", async () => {
  setup();
  await screen.findByRole("option", { name: "Sponsor A" });
  expect((screen.getByTestId("onboard-button") as HTMLButtonElement).disabled).toBe(true);
  await choose();
  expect((screen.getByTestId("onboard-button") as HTMLButtonElement).disabled).toBe(false);
});

test("consent note names host and sponsor", async () => {
  setup();
  await choose();
  expect(screen.getByTestId("consent-note").textContent).toBe("The whole workbook will be sent to api.example.test and filed under sponsor-a.");
});

test("onboard reads, uploads, then starts the store", async () => {
  const order: string[] = [];
  const { readFile, startRun, store } = setup({ order });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  await waitFor(() => expect(store.start).toHaveBeenCalledWith("r1"));
  expect(order).toEqual(["stop", "read", "startRun", "start"]);
  expect(readFile).toHaveBeenCalled();
  expect(startRun).toHaveBeenCalledWith("sponsor-a", file.blob, "affiliates.xlsx");
  expect(await screen.findByTestId("progress")).toBeTruthy();
});

test("sha mismatch shows verification failure and stops", async () => {
  const { store } = setup({ snapSha: "different" });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toContain("Upload verification failed");
  expect(store.stop).toHaveBeenCalledTimes(2); // before the upload, and again on the mismatch
  expect(store.start).not.toHaveBeenCalled();
  expect(screen.queryByTestId("progress")).toBeNull();
});

test("missing server sha skips the check", async () => {
  const { store } = setup({ snapSha: undefined });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  await screen.findByTestId("progress");
  expect(store.stop).toHaveBeenCalledTimes(1); // only the pre-upload stop
  expect(screen.queryByTestId("error-banner")).toBeNull();
});

test("unsaved workbook shows its message and does not upload", async () => {
  const { startRun, store } = setup({ readFile: async () => { throw new WorkbookError("unsaved", "Save the workbook first so it has a file name"); } });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toContain("Save the workbook first so it has a file name");
  expect(startRun).not.toHaveBeenCalled();
  expect(store.start).not.toHaveBeenCalled();
});

test("422 from startRun shows the server message verbatim", async () => {
  const { store } = setup({ startRun: vi.fn(async () => { throw new ApiError("Header row not found", 422, "req-9"); }) as unknown as Client["startRun"] });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toContain("Header row not found");
  expect(store.start).not.toHaveBeenCalled();
});

test("two synchronous clicks upload once", async () => {
  const { readFile, startRun, store } = setup();
  await choose();
  const btn = screen.getByTestId("onboard-button");
  fireEvent.click(btn);
  fireEvent.click(btn);
  await waitFor(() => expect(store.start).toHaveBeenCalledTimes(1));
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(startRun).toHaveBeenCalledTimes(1);
});

test("unmount before upload resolves does not start the store and stops it", async () => {
  let release!: (f: WorkbookFile) => void;
  const readFile = vi.fn(() => new Promise<WorkbookFile>((r) => { release = r; }));
  const { store, view, startRun } = setup({ readFile });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  await waitFor(() => expect(readFile).toHaveBeenCalled());
  view.unmount();
  expect(store.stop).toHaveBeenCalled();
  release(file);
  await new Promise((r) => setTimeout(r, 10));
  expect(store.start).not.toHaveBeenCalled();
  expect(startRun).toHaveBeenCalledTimes(1);
});

test("sha is verified even when the store has no snapshot", async () => {
  const { store } = setup({ snapSha: "other" });
  vi.mocked(store.refresh).mockImplementation(async () => undefined);
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toContain("Upload verification failed");
});

test("verification fetch failure still monitors the run and warns", async () => {
  const { store, client, startRun } = setup();
  vi.mocked(client.run).mockRejectedValue(new Error("network down"));
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  const warn = await screen.findByTestId("warning-banner");
  expect(warn.textContent).toContain("Warning:");
  expect(warn.textContent).toBe("Warning: Uploaded as run r1, but its integrity could not be verified (network down).");
  expect(store.start).toHaveBeenCalledWith("r1");
  expect(startRun).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("error-banner")).toBeNull();
  expect((screen.getByTestId("onboard-button") as HTMLButtonElement).disabled).toBe(false);
});

test("Onboard removes the add-in's own Review sheet before reading the workbook", async () => {
  const order: string[] = [];
  const { excel } = setup({ order, readFile: async () => { order.push(`read:${excel.sheetNames().join("|")}`); return file; } });
  excel.addSheet(REVIEW_SHEET, [OWNER_MARK]);
  excel.addSheet("Data");
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  await waitFor(() => expect(order).toContain("start"));
  expect(order.slice(0, 2)).toEqual(["stop", "read:Data"]);
});

test("a same-named sheet the add-in did not create is uploaded untouched", async () => {
  const order: string[] = [];
  const { excel } = setup({ order, readFile: async () => { order.push(`read:${excel.sheetNames().join("|")}`); return file; } });
  excel.addSheet(REVIEW_SHEET);
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  await waitFor(() => expect(order).toContain("start"));
  expect(order).toContain(`read:${REVIEW_SHEET}`);
});

test("when the Review sheet cannot be removed the upload is blocked with a message", async () => {
  const { readFile, startRun, store } = setup({ removeReview: async () => { throw new Error("sheet is locked"); } });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toBe(
    "Error: Could not remove the 'Onboarding Review' sheet before upload (sheet is locked). Delete that sheet, then try again.",
  );
  expect(readFile).not.toHaveBeenCalled();
  expect(startRun).not.toHaveBeenCalled();
  expect(store.start).not.toHaveBeenCalled();
  expect((screen.getByTestId("onboard-button") as HTMLButtonElement).disabled).toBe(false);
});

// A previous run on screen: "Onboard again" stops it, and a failure before the new run exists brings it back.
const PREVIOUS: RunState = { ...EMPTY, runId: "r0", snap: fakeSnapshot({ run_id: "r0" }) };
const failures: [string, Parameters<typeof setup>[0], string][] = [
  ["the Review sheet cannot be removed", { removeReview: async () => { throw new Error("sheet is locked"); } }, "Could not remove the 'Onboarding Review' sheet"],
  ["the workbook is unsaved", { readFile: async () => { throw new WorkbookError("unsaved", "Save the workbook first so it has a file name"); } }, "Save the workbook first"],
  ["the workbook is too large", { readFile: async () => { throw new WorkbookError("too_large", "This workbook is larger than the 25 MB limit"); } }, "larger than the 25 MB limit"],
  ["the workbook cannot be read", { readFile: async () => { throw new WorkbookError("read_failed", "Could not open the workbook file"); } }, "Could not open the workbook file"],
  ["startRun fails", { startRun: vi.fn(async () => { throw new ApiError("Header row not found", 422, "req-9"); }) as unknown as Client["startRun"] }, "Header row not found"],
  ["the server copy does not match", { snapSha: "different" }, "Upload verification failed"],
];
test.each(failures)("when %s, the previous run is restored and the error shown", async (_label, over, message) => {
  const { store } = setup({ ...over, initial: PREVIOUS });
  await choose();
  expect(screen.getByTestId("onboard-button").textContent).toBe("Onboard again");
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toContain(message);
  await waitFor(() => expect(store.start).toHaveBeenCalledWith("r0"));
  expect(store.start).toHaveBeenCalledTimes(1); // the rejected new run, if any, is never monitored
  expect(store.get().runId).toBe("r0");
  expect(await screen.findByTestId("progress")).toBeTruthy();
});

test("a successful upload replaces the previous run, which is not restored", async () => {
  const { store } = setup({ initial: PREVIOUS });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  await waitFor(() => expect(store.start).toHaveBeenCalledWith("r1"));
  expect(store.start).toHaveBeenCalledTimes(1);
  expect(store.get().runId).toBe("r1");
  expect(screen.queryByTestId("error-banner")).toBeNull();
});

test("a failure after an unmount restores nothing", async () => {
  let fail!: (e: Error) => void;
  const readFile = vi.fn(() => new Promise<WorkbookFile>((_r, j) => { fail = j; }));
  const { store, view } = setup({ initial: PREVIOUS, readFile });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  await waitFor(() => expect(readFile).toHaveBeenCalled());
  view.unmount();
  fail(new WorkbookError("read_failed", "gone"));
  await new Promise((r) => setTimeout(r, 10));
  expect(store.start).not.toHaveBeenCalled();
});

const BRIEF_GATE = { gate: "brief" as const, message: "The agent did not submit a brief. Instruct it to retry, or reject the run.", blocked_reasons: [], allowed_actions: ["approve", "answer", "change", "instruct", "reject"] };
test("a brief-gate message shows even when there is no brief (scoping failed)", async () => {
  setup({ initial: { ...EMPTY, runId: "r1", snap: fakeSnapshot({ brief: null, pending: BRIEF_GATE, gate_message: BRIEF_GATE.message }) } });
  expect((await screen.findAllByTestId("gate-message")).map((e) => e.textContent)).toEqual([BRIEF_GATE.message]);
});

test("sponsors that fail to load show a Retry that fetches them again; the success path is unchanged", async () => {
  const sponsors = vi.fn<Client["sponsors"]>()
    .mockRejectedValueOnce(new Error("Sign-in did not complete. Reopen the pane or retry."))
    .mockResolvedValueOnce([{ id: "sponsor-a", name: "Sponsor A" }]);
  setup({ sponsors });
  const banner = await screen.findByTestId("sponsors-error");
  expect(banner.textContent).toBe("Error: Could not load sponsors: Sign-in did not complete. Reopen the pane or retry.Retry");
  expect(screen.queryByRole("option", { name: "Sponsor A" })).toBeNull();
  fireEvent.click(screen.getByTestId("sponsors-retry"));
  await screen.findByRole("option", { name: "Sponsor A" });
  expect(sponsors).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId("sponsors-error")).toBeNull();
  await choose();
  expect((screen.getByTestId("onboard-button") as HTMLButtonElement).disabled).toBe(false);
});

test("a sponsors failure with a request id shows it; a retry leaves an upload error alone", async () => {
  const sponsors = vi.fn<Client["sponsors"]>()
    .mockResolvedValueOnce([{ id: "sponsor-a", name: "Sponsor A" }])
    .mockRejectedValueOnce(new ApiError("Request timed out after 30 s", 0, "rq-7"));
  const { view, store } = setup({ sponsors, readFile: async () => { throw new WorkbookError("unsaved", "Save the workbook first so it has a file name"); } });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toContain("Save the workbook first");
  // A new client (as after a pane reload) refetches; this one fails and offers Retry.
  view.rerender(<Pane client={{ sponsors, startRun: vi.fn(), run: vi.fn() } as unknown as Client} store={store} readFile={vi.fn()} apiBase="https://api.example.test:8443" />);
  expect((await screen.findByTestId("sponsors-error")).textContent).toContain("(ref rq-7)");
  expect(screen.getByTestId("error-banner").textContent).toContain("Save the workbook first");
});

test("a removal Excel defers past the bound blocks the upload with 'Excel is busy', restores the previous run, and a late completion changes nothing", async () => {
  let finish!: (v: boolean) => void;
  const removeReview = vi.fn<(signal: AbortSignal) => Promise<boolean>>(() => new Promise<boolean>((r) => { finish = r; }));
  const { store, startRun, readFile } = setup({ initial: PREVIOUS, removeReview, excelOpTimeoutMs: 30 });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect(screen.getByTestId("onboard-button").textContent).toBe("Uploading...");
  expect((await screen.findByTestId("error-banner")).textContent).toBe("Error: Excel is busy (finish editing the cell), then try again.");
  await waitFor(() => expect(store.start).toHaveBeenCalledWith("r0"));
  expect((screen.getByTestId("onboard-button") as HTMLButtonElement).disabled).toBe(false);
  const signal = removeReview.mock.calls[0]![0];
  expect(signal.aborted).toBe(true); // a removal that has not started yet skips its work
  finish(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(readFile).not.toHaveBeenCalled();
  expect(startRun).not.toHaveBeenCalled();
  expect(store.start).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("error-banner").textContent).toBe("Error: Excel is busy (finish editing the cell), then try again.");
});

test("the real removal, deferred by Excel past the bound, does not delete the sheet the restored run renders", async () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const fake = createFakeReview();
  fake.addSheet(REVIEW_SHEET).names.add(OWNER_MARK);
  // Excel.run that waits (cell-edit mode) before it runs the batch.
  const deferred: ExcelRun = async (cb) => { await opened; return (fake.run as ExcelRun)(cb); };
  const { store, startRun } = setup({ initial: PREVIOUS, run: deferred, excelOpTimeoutMs: 30 });
  await choose();
  fireEvent.click(screen.getByTestId("onboard-button"));
  expect((await screen.findByTestId("error-banner")).textContent).toContain("Excel is busy");
  await waitFor(() => expect(store.start).toHaveBeenCalledWith("r0"));
  open();
  await new Promise((r) => setTimeout(r, 20));
  expect(fake.sheetNames()).toContain(REVIEW_SHEET);
  expect(startRun).not.toHaveBeenCalled();
});

import { afterEach, expect, test, vi } from "vitest";
import { ApiError, type Client } from "../../src/api/client";
import { artifactUrl, browserSave, downloadArtifact, officeDownloadDeps, openBrowser, safeFileName } from "../../src/office/download";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const blob = new Blob(["a,b"]);
const client = (impl: () => Promise<Blob> = async () => blob) => ({ artifact: vi.fn(impl) }) as unknown as Client & { artifact: ReturnType<typeof vi.fn> };
const BASE = "https://api.example.test/";

test("safeFileName keeps the basename and strips illegal characters", () => {
  expect(safeFileName("Affiliates.csv")).toBe("Affiliates.csv");
  expect(safeFileName("../../etc/passwd")).toBe("passwd");
  expect(safeFileName("a\\b\\c.csv")).toBe("c.csv");
  expect(safeFileName('we"ird:name?.csv')).toBe("we_ird_name_.csv");
  expect(safeFileName("a\u007fb.csv")).toBe("a_b.csv");
  expect(safeFileName("a‮b⁦c.csv")).toBe("a_b_c.csv");
});

test("safeFileName falls back for empty, dot-only and trailing-dot names", () => {
  for (const n of ["", "..", ".", "...", "  ", "a/"]) expect(safeFileName(n)).toBe("download");
  expect(safeFileName("report.csv. . ")).toBe("report.csv");
});

test("safeFileName neutralises Windows reserved names", () => {
  for (const n of ["CON", "prn.txt", "Aux", "NUL.csv", "COM1", "com9.json", "LPT1", "lpt9.x"]) {
    expect(safeFileName(n)).toBe(`_${n}`);
  }
  expect(safeFileName("console.csv")).toBe("console.csv");
});

test("artifactUrl carries no credentials and encodes the name", () => {
  expect(artifactUrl(BASE, "r1", "a b.csv")).toBe("https://api.example.test/runs/r1/artifacts/a%20b.csv");
});

test("anchor-first saves via saveBlob through the client", async () => {
  const c = client();
  const saveBlob = vi.fn(async () => {});
  const openBrowserDep = vi.fn(async () => {});
  expect(await downloadArtifact(c, "r1", "../x/Affiliates.csv", { saveBlob, openBrowser: openBrowserDep }, BASE)).toBe("saved");
  expect(c.artifact).toHaveBeenCalledWith("r1", "../x/Affiliates.csv");
  expect(saveBlob).toHaveBeenCalledWith(blob, "Affiliates.csv");
  expect(openBrowserDep).not.toHaveBeenCalled();
});

test("anchor-first falls back to the browser when saveBlob throws", async () => {
  const openBrowserDep = vi.fn(async () => {});
  const saveBlob = vi.fn(async () => { throw new Error("blocked"); });
  expect(await downloadArtifact(client(), "r1", "review.xlsx", { saveBlob, openBrowser: openBrowserDep }, BASE)).toBe("browser");
  expect(openBrowserDep).toHaveBeenCalledWith("https://api.example.test/runs/r1/artifacts/review.xlsx");
});

test("browser-first does not fetch the blob", async () => {
  const c = client();
  const saveBlob = vi.fn(async () => {});
  const openBrowserDep = vi.fn(async () => {});
  expect(await downloadArtifact(c, "r1", "Affiliates.csv", { saveBlob, openBrowser: openBrowserDep, browserFirst: true }, BASE)).toBe("browser");
  expect(c.artifact).not.toHaveBeenCalled();
  expect(saveBlob).not.toHaveBeenCalled();
});

test("browser-first falls back to the anchor when the browser route throws", async () => {
  const saveBlob = vi.fn(async () => {});
  const openBrowserDep = vi.fn(async () => { throw new Error("unsupported"); });
  expect(await downloadArtifact(client(), "r1", "Affiliates.csv", { saveBlob, openBrowser: openBrowserDep, browserFirst: true }, BASE)).toBe("saved");
  expect(saveBlob).toHaveBeenCalledWith(blob, "Affiliates.csv");
});

test("a failed fetch propagates the ApiError and does not try the other route", async () => {
  const err = new ApiError("no such artifact", 404, "req-9");
  const openBrowserDep = vi.fn(async () => {});
  await expect(downloadArtifact(client(async () => { throw err; }), "r1", "x", { saveBlob: vi.fn(), openBrowser: openBrowserDep }, BASE)).rejects.toBe(err);
  expect(openBrowserDep).not.toHaveBeenCalled();
});

test("both routes failing rejects with the last error", async () => {
  const deps = { saveBlob: vi.fn(async () => { throw new Error("a"); }), openBrowser: vi.fn(async () => { throw new Error("b"); }) };
  await expect(downloadArtifact(client(), "r1", "x", deps, BASE)).rejects.toThrow("b");
});

test("browserSave clicks an anchor and revokes the URL only after 60 s", async () => {
  vi.useFakeTimers();
  // jsdom lacks these; define them so spyOn can replace and restore them.
  Object.assign(URL, { createObjectURL: () => "", revokeObjectURL: () => {} });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe("a.csv");
    expect(this.href).toBe("blob:fake");
  });
  await browserSave(blob, "a.csv");
  expect(click).toHaveBeenCalled();
  vi.advanceTimersByTime(0);
  expect(revoke).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(revoke).toHaveBeenCalledWith("blob:fake");
});

function fakeOffice(platform: string, supported: boolean, open = vi.fn()) {
  vi.stubGlobal("Office", {
    PlatformType: { OfficeOnline: "OfficeOnline", PC: "PC", Mac: "Mac" },
    context: { platform, requirements: { isSetSupported: vi.fn(() => supported) }, ui: { openBrowserWindow: open } },
  });
  return open;
}

test("platform selection: web is anchor-first, desktop and unknown are browser-first", () => {
  fakeOffice("OfficeOnline", true);
  expect(officeDownloadDeps().browserFirst).toBe(false);
  fakeOffice("PC", true);
  expect(officeDownloadDeps().browserFirst).toBe(true);
  fakeOffice("Mac", true);
  expect(officeDownloadDeps().browserFirst).toBe(true);
  fakeOffice("something-new", true);
  expect(officeDownloadDeps().browserFirst).toBe(true);
});

test("openBrowser calls openBrowserWindow when the requirement set is supported", async () => {
  const open = fakeOffice("PC", true);
  await openBrowser("https://x/y");
  expect(open).toHaveBeenCalledWith("https://x/y");
});

test("unsupported requirement set rejects clearly, and desktop falls back to the anchor", async () => {
  const open = fakeOffice("PC", false);
  await expect(openBrowser("https://x/y")).rejects.toThrow(/OpenBrowserWindowApi/);
  expect(open).not.toHaveBeenCalled();
  const saveBlob = vi.fn(async () => {});
  const deps = { ...officeDownloadDeps(), saveBlob };
  expect(await downloadArtifact(client(), "r1", "Affiliates.csv", deps, BASE)).toBe("saved");
});

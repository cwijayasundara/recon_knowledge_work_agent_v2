/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostFromOffice, readWorkbook, WorkbookError } from "../../src/office/workbook";

const fakeHost = (bytes: Uint8Array, url = "https://x/y/a.xlsx", slice = 4) => {
  const file = {
    size: bytes.length,
    sliceCount: Math.ceil(bytes.length / slice),
    getSliceAsync: vi.fn(),
    closeAsync: vi.fn(),
  };
  const slices = Array.from({ length: file.sliceCount }, (_, i) => Array.from(bytes.slice(i * slice, (i + 1) * slice)));
  file.getSliceAsync.mockImplementation((i: number, c: (r: any) => void) => c({ status: "succeeded", value: { data: slices[i] } }));
  return { host: { url, getFileAsync: (_t: "compressed", _o: { sliceSize: number }, cb: (r: any) => void) => cb({ status: "succeeded", value: file }) }, file };
};

const blobBytes = (b: Blob) =>
  new Promise<Uint8Array>((res) => {
    const fr = new FileReader();
    fr.onload = () => res(new Uint8Array(fr.result as ArrayBuffer));
    fr.readAsArrayBuffer(b);
  });

const bytes = Uint8Array.from({ length: 11 }, (_, i) => i * 7);

describe("readWorkbook", () => {
  it("reassembles slices in order", async () => {
    const { host, file } = fakeHost(bytes);
    const r = await readWorkbook(host, { maxBytes: 1000 });
    expect(await blobBytes(r.blob)).toEqual(bytes);
    expect(r.bytes).toBe(11);
    expect(file.getSliceAsync.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    expect(file.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("computes sha256", async () => {
    const { host } = fakeHost(bytes);
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
    expect((await readWorkbook(host, { maxBytes: 1000 })).sha256).toBe(hex);
  });

  it("rejects an unsaved workbook", async () => {
    const { host } = fakeHost(bytes, "");
    await expect(readWorkbook(host, { maxBytes: 1000 })).rejects.toMatchObject({
      code: "unsaved",
      message: "Save the workbook first so it has a file name",
    });
  });

  it("rejects too large before reading slices, naming the limit, and closes", async () => {
    const { host, file } = fakeHost(bytes);
    const err = await readWorkbook(host, { maxBytes: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkbookError);
    expect(err.code).toBe("too_large");
    expect(err.message).toBe("This workbook is larger than the 1 KB limit");
    expect(file.getSliceAsync).not.toHaveBeenCalled();
    expect(file.closeAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    [25 * 1024 * 1024, "25 MB"],
    [1.5 * 1024 * 1024, "1.5 MB"],
    [400 * 1024, "400 KB"],
  ])("formats the limit %d as %s", async (max, text) => {
    const { host, file } = fakeHost(bytes);
    file.size = max + 1;
    await expect(readWorkbook(host, { maxBytes: max })).rejects.toThrow(`larger than the ${text} limit`);
  });

  it("fails a bad slice with read_failed and still closes once", async () => {
    const { host, file } = fakeHost(bytes);
    file.getSliceAsync.mockImplementation((_i: number, c: (r: any) => void) => c({ status: "failed", error: { message: "boom" } }));
    await expect(readWorkbook(host, { maxBytes: 1000 })).rejects.toMatchObject({ code: "read_failed", message: "boom" });
    expect(file.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("fails getFileAsync with read_failed", async () => {
    const host = { url: "https://x/a.xlsx", getFileAsync: (_t: "compressed", _o: { sliceSize: number }, cb: (r: any) => void) => cb({ status: "failed", error: { message: "nope" } }) };
    await expect(readWorkbook(host, { maxBytes: 1000 })).rejects.toMatchObject({ code: "read_failed", message: "nope" });
  });

  it("fails read_failed when reassembled length mismatches size", async () => {
    const { host, file } = fakeHost(bytes);
    file.size = 12;
    await expect(readWorkbook(host, { maxBytes: 1000 })).rejects.toMatchObject({ code: "read_failed" });
    expect(file.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("fails read_failed when reassembled data is longer than size", async () => {
    const { host, file } = fakeHost(bytes);
    file.size = 10;
    await expect(readWorkbook(host, { maxBytes: 1000 })).rejects.toMatchObject({ code: "read_failed" });
    expect(file.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("does not let a throwing closeAsync replace the result or the error", async () => {
    const ok = fakeHost(bytes);
    ok.file.closeAsync.mockImplementation(() => {
      throw new Error("close boom");
    });
    await expect(readWorkbook(ok.host, { maxBytes: 1000 })).resolves.toMatchObject({ bytes: 11 });
    const bad = fakeHost(bytes);
    bad.file.closeAsync.mockImplementation(() => {
      throw new Error("close boom");
    });
    await expect(readWorkbook(bad.host, { maxBytes: 5 })).rejects.toMatchObject({ code: "too_large" });
  });

  it.each([
    ["undefined value", undefined],
    ["non-array data", { data: "abc" }],
  ])("fails read_failed on a slice with %s", async (_n, value) => {
    const { host, file } = fakeHost(bytes);
    file.getSliceAsync.mockImplementation((_i: number, c: (r: any) => void) => c({ status: "succeeded", value }));
    await expect(readWorkbook(host, { maxBytes: 1000 })).rejects.toMatchObject({ code: "read_failed" });
    expect(file.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("fails read_failed when crypto.subtle is missing", async () => {
    const { host, file } = fakeHost(bytes);
    vi.stubGlobal("crypto", {});
    try {
      await expect(readWorkbook(host, { maxBytes: 1000 })).rejects.toMatchObject({ code: "read_failed" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(file.closeAsync).toHaveBeenCalledTimes(1);
  });

  it("reads url at call time", async () => {
    const { host } = fakeHost(bytes);
    let url = "";
    const live = { get url() { return url; }, getFileAsync: host.getFileAsync };
    await expect(readWorkbook(live, { maxBytes: 1000 })).rejects.toMatchObject({ code: "unsaved" });
    url = "https://x/y/a.xlsx";
    await expect(readWorkbook(live, { maxBytes: 1000 })).resolves.toMatchObject({ name: "a.xlsx" });
  });

  it.each([
    ["https://x/y/Sponsor%20A.xlsx", "Sponsor A.xlsx"],
    ["https://x/y/a.xlsx?v=1#f", "a.xlsx"],
    ["C:\\Reports\\Q#1.xlsx", "Q#1.xlsx"],
    ["/Users/a/b.xlsx", "b.xlsx"],
    ["https://x/y/", "workbook.xlsx"],
    ["https://x/?a", "workbook.xlsx"],
    ["C:\\Reports\\", "workbook.xlsx"],
    ["https://x/y/a%2Fb.xlsx", "a_b.xlsx"],
    ["https://x/y/a%5Cb.xlsx", "a_b.xlsx"],
    ["https://x/y/%E0%A4%A", "%E0%A4%A"],
  ])("derives file name from %s", async (url, name) => {
    const { host } = fakeHost(bytes, url);
    expect((await readWorkbook(host, { maxBytes: 1000 })).name).toBe(name);
  });

  it("uses a custom slice size", async () => {
    const { host } = fakeHost(bytes);
    const spy = vi.spyOn(host, "getFileAsync");
    await readWorkbook(host, { maxBytes: 1000, sliceSize: 4 });
    expect(spy.mock.calls[0]?.[1]).toEqual({ sliceSize: 4 });
  });
});

describe("hostFromOffice", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (getFileAsync: (t: unknown, o: unknown, cb: (r: unknown) => void) => void, url?: string) =>
    vi.stubGlobal("Office", { context: { document: { url, getFileAsync } }, FileType: { Compressed: "compressed" }, AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" } });

  it("maps a successful getFileAsync result and passes the slice size", () => {
    const file = { size: 1 };
    const getFileAsync = vi.fn((_t: unknown, _o: unknown, cb: (r: unknown) => void) => cb({ status: "succeeded", value: file }));
    stub(getFileAsync, "https://x/a.xlsx");
    const cb = vi.fn();
    const host = hostFromOffice();
    host.getFileAsync("compressed", { sliceSize: 8 }, cb);
    expect(getFileAsync.mock.calls[0]?.slice(0, 2)).toEqual(["compressed", { sliceSize: 8 }]);
    expect(cb).toHaveBeenCalledWith({ status: "succeeded", value: file, error: undefined });
    expect(host.url).toBe("https://x/a.xlsx");
  });

  it("maps failures with the error message and tolerates a missing url (unsaved workbook)", () => {
    stub((_t, _o, cb) => cb({ status: "failed", error: { message: "denied" } }));
    const cb = vi.fn();
    const host = hostFromOffice();
    host.getFileAsync("compressed", { sliceSize: 8 }, cb);
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ status: "failed", error: { message: "denied" } });
    expect(host.url).toBe("");
  });
});

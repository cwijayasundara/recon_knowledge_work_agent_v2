import type { AsyncResult, DocumentHost, FileLike } from "./office-types";

export interface WorkbookFile {
  blob: Blob;
  name: string;
  sha256: string;
  bytes: number;
}

export type WorkbookErrorCode = "unsaved" | "too_large" | "read_failed";

export class WorkbookError extends Error {
  constructor(
    readonly code: WorkbookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkbookError";
  }
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_SLICE = 4_194_304;

function call<T>(fn: (cb: (r: AsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      fn((r) => (r.status === "succeeded" ? resolve(r.value) : reject(new WorkbookError("read_failed", r.error?.message ?? "Could not read the workbook"))));
    } catch (e) {
      reject(new WorkbookError("read_failed", e instanceof Error ? e.message : String(e)));
    }
  });
}

const FALLBACK_NAME = "workbook.xlsx";

function fileName(url: string): string {
  let path = url;
  if (/^https?:\/\//i.test(url)) {
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.replace(/^https?:\/\/[^/]*/i, "").split(/[?#]/)[0] ?? "";
    }
  }
  const last = path.split(/[\\/]/).pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // malformed escape: keep the raw segment
  }
  name = name.replace(/[\\/]/g, "_").trim();
  return name === "" || name === "." || name === ".." ? FALLBACK_NAME : name;
}

function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Number(mb.toFixed(1))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    throw new WorkbookError("read_failed", `Could not hash the workbook: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function readWorkbook(host: DocumentHost, opts: { maxBytes: number; sliceSize?: number }): Promise<WorkbookFile> {
  const url = host.url;
  if (!url) throw new WorkbookError("unsaved", "Save the workbook first so it has a file name");
  const sliceSize = opts.sliceSize ?? DEFAULT_SLICE;
  const file: FileLike | undefined = await call((cb) => host.getFileAsync("compressed", { sliceSize }, cb));
  if (!file) throw new WorkbookError("read_failed", "Could not open the workbook file");
  try {
    if (file.size > opts.maxBytes) {
      throw new WorkbookError("too_large", `This workbook is larger than the ${formatLimit(opts.maxBytes)} limit`);
    }
    const bytes = new Uint8Array(new ArrayBuffer(file.size));
    let offset = 0;
    for (let i = 0; i < file.sliceCount; i++) {
      const slice = await call<{ data: number[] } | undefined>((cb) => file.getSliceAsync(i, cb));
      const data = slice?.data;
      if (!Array.isArray(data)) throw new WorkbookError("read_failed", `Workbook slice ${i} had no data`);
      if (offset + data.length > bytes.length) throw new WorkbookError("read_failed", "Workbook data was larger than its reported size");
      bytes.set(data, offset);
      offset += data.length;
    }
    if (offset !== file.size) throw new WorkbookError("read_failed", "Workbook data was shorter than its reported size");
    return { blob: new Blob([bytes], { type: XLSX_MIME }), name: fileName(url), sha256: await sha256Hex(bytes), bytes: bytes.length };
  } finally {
    try {
      file.closeAsync();
    } catch {
      // closing must not mask the real result or error
    }
  }
}

export function hostFromOffice(): DocumentHost {
  const doc = Office.context.document;
  return {
    get url() {
      return Office.context.document.url ?? "";
    },
    getFileAsync: (_type, o, cb) =>
      doc.getFileAsync(Office.FileType.Compressed, { sliceSize: o.sliceSize }, (r) =>
        cb({
          status: r.status === Office.AsyncResultStatus.Succeeded ? "succeeded" : "failed",
          value: r.value as unknown as FileLike,
          error: r.error ? { message: r.error.message } : undefined,
        }),
      ),
  };
}

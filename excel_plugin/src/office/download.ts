import { ApiError, type Client } from "../api/client";

export interface DownloadDeps {
  saveBlob(blob: Blob, name: string): Promise<void>;
  openBrowser(url: string): Promise<void>;
  /** Desktop hosts drop anchor downloads silently, so they try the system browser first. */
  browserFirst?: boolean;
}

const FALLBACK_NAME = "download";
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const REVOKE_DELAY_MS = 60_000;

/** Basename only; safe on Windows and macOS (no separators, reserved names, bidi controls, trailing dots). */
export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f"*:<>?|\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (base === "" || /^\.+$/.test(base)) return FALLBACK_NAME;
  if (RESERVED.test(base.split(".")[0] ?? "")) return `_${base}`;
  return base;
}

export const artifactUrl = (apiBase: string, runId: string, name: string): string =>
  `${apiBase.replace(/\/+$/, "")}/runs/${runId}/artifacts/${encodeURIComponent(name)}`;

/**
 * The browser route opens a plain URL with no credentials in it; it relies on the browser's Easy Auth
 * session (or an unauthenticated dev API). The anchor route fetches with bearer headers via the client.
 */
export async function downloadArtifact(
  client: Pick<Client, "artifact">,
  runId: string,
  name: string,
  deps: DownloadDeps,
  apiBase: string,
): Promise<"saved" | "browser"> {
  const save = async (): Promise<"saved"> => {
    const blob = await client.artifact(runId, name);
    await deps.saveBlob(blob, safeFileName(name));
    return "saved";
  };
  const browse = async (): Promise<"browser"> => {
    await deps.openBrowser(artifactUrl(apiBase, runId, name));
    return "browser";
  };
  const [first, second] = deps.browserFirst ? [browse, save] : [save, browse];
  try {
    return await first();
  } catch (e) {
    if (e instanceof ApiError) throw e; // a failed fetch is not a host problem
    return await second();
  }
}

export async function browserSave(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    a.click(); // never throws when the host drops the download
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!Office.context.requirements.isSetSupported("OpenBrowserWindowApi", "1.1")) {
      reject(new Error("This Office host cannot open a browser window (OpenBrowserWindowApi 1.1 is not supported)."));
      return;
    }
    try {
      Office.context.ui.openBrowserWindow(url);
      resolve();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Excel on the web: anchor first. Desktop (PC/Mac) and unknown hosts: system browser first. */
export function officeDownloadDeps(): DownloadDeps {
  let online = false;
  try {
    online = Office.context.platform === Office.PlatformType.OfficeOnline;
  } catch { /* Office not loaded */ }
  return { saveBlob: browserSave, openBrowser, browserFirst: !online };
}

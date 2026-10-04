import { useEffect, useMemo, useState } from "preact/hooks";
import { createClient, type Client } from "./api/client";
import { createAuth } from "./auth";
import { config, SUPPORTED_API_MAJOR } from "./config";
import { hostFromOffice, readWorkbook } from "./office/workbook";
import { createRunStore, type RunStore } from "./state/store";
import { ErrorBanner } from "./ui/ErrorBanner";
import { Pane } from "./ui/Pane";

interface Deps { client: Client; store: RunStore }

/** /health is advisory: a server that never answers it must not keep the pane from mounting. */
export const HEALTH_TIMEOUT_MS = 4000;

/** Returns a message when the API base cannot be used (an empty base would silently call the static host). */
export function apiBaseProblem(base: string): string | null {
  return /^https?:\/\/[^/\s]+/.test(base) ? null : "Configuration error: the API address (VITE_API_BASE) is missing or not an http(s) URL. Rebuild the add-in with VITE_API_BASE set.";
}

export function App({ apiBase = config.apiBase, healthTimeoutMs = HEALTH_TIMEOUT_MS }: { apiBase?: string; healthTimeoutMs?: number } = {}) {
  const configProblem = apiBaseProblem(apiBase);
  const [deps, setDeps] = useState<Deps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incompatible, setIncompatible] = useState<string | null>(null);

  useEffect(() => {
    if (configProblem) return;
    let live = true;
    (async () => {
      const auth = await createAuth();
      const client = createClient({ baseUrl: apiBase, auth });
      // Checked before the pane mounts: an incompatible API must never receive an upload or a gate.
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<{ version?: string }>((resolve) => { timer = setTimeout(() => resolve({}), healthTimeoutMs); });
        const { version } = await Promise.race([client.health(), late]).finally(() => clearTimeout(timer));
        const major = version ? Number.parseInt(version.split(".")[0] ?? "", 10) : NaN;
        if (version && major !== SUPPORTED_API_MAJOR) {
          if (live) setIncompatible(`This add-in supports API major version ${SUPPORTED_API_MAJOR}, but the server reports ${version}.`);
          return;
        }
      } catch {
        // health is advisory; real calls surface their own errors
      }
      if (!live) return;
      setDeps({ client, store: createRunStore(client) });
    })().catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [apiBase, configProblem, healthTimeoutMs]);

  const readFile = useMemo(() => () => readWorkbook(hostFromOffice(), { maxBytes: config.maxUploadBytes }), []);

  if (configProblem) return <main class="pane"><h1>Onboarding workbench</h1><ErrorBanner message={configProblem} /></main>;

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      {incompatible ? <ErrorBanner message={incompatible} /> : null}
      {deps ? <Pane client={deps.client} store={deps.store} readFile={readFile} /> : <main class="pane"><h1>Onboarding workbench</h1></main>}
    </>
  );
}

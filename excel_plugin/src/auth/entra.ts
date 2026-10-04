import type { Auth } from "./auth";

export interface SsoSource { getAccessToken(): Promise<string> }

export const SIGN_IN_FAILED = "Please sign in to Microsoft 365 in Excel, then reopen the pane.";
export const SIGN_IN_IN_PROGRESS = "Sign-in is already in progress in Excel; wait for the prompt or retry.";

/** Office's code for a getAccessToken call made while an earlier one is still in progress. */
const IN_PROGRESS = 13008;

/**
 * The API sits behind Easy Auth, which validates the bearer token and sets x-ms-client-principal-name.
 * Concurrent requests share one token request: Office rejects a second getAccessToken while the first is still showing
 * sign-in or consent (13008), which would fail every request but the first. A request the client gave up on (sign-in
 * timeout) is dropped by reset(), so a retry asks Office again instead of joining a request that may never settle.
 */
export function entraAuth(sso: SsoSource): Auth {
  let inFlight: Promise<string> | null = null;
  const token = (): Promise<string> => {
    if (inFlight) return inFlight;
    const p = sso.getAccessToken().finally(() => { if (inFlight === p) inFlight = null; });
    inFlight = p;
    return p;
  };
  return {
    label: "entra",
    async headers() {
      try {
        return { Authorization: `Bearer ${await token()}` };
      } catch (e) {
        const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
        throw new Error(code === IN_PROGRESS ? SIGN_IN_IN_PROGRESS : SIGN_IN_FAILED);
      }
    },
    reset() { inFlight = null; },
  };
}

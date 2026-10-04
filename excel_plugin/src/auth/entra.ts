import type { Auth } from "./auth";

export interface SsoSource { getAccessToken(): Promise<string> }

/** The API sits behind Easy Auth, which validates the bearer token and sets x-ms-client-principal-name. */
export function entraAuth(sso: SsoSource): Auth {
  return {
    label: "entra",
    async headers() {
      try {
        return { Authorization: `Bearer ${await sso.getAccessToken()}` };
      } catch {
        throw new Error("Please sign in to Microsoft 365 in Excel, then reopen the pane.");
      }
    },
  };
}

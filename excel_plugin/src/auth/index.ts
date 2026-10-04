import { config } from "../config";
import type { Auth } from "./auth";
import { entraAuth } from "./entra";

export async function createAuth(): Promise<Auth> {
  if (config.auth === "entra") return entraAuth({ getAccessToken: () => Office.auth.getAccessToken({ allowSignInPrompt: true }) });
  if (import.meta.env.PROD) throw new Error("dev auth in a production bundle");
  return (await import("./dev")).devAuth(config.devActor);
}

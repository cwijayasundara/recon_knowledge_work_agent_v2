import type { Auth } from "./auth";

export const devAuth = (actor: string): Auth => ({ label: `dev:${actor}`, headers: async () => ({ "X-Actor": actor }) });

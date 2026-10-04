export function httpsOrigin(raw: string | undefined, name: string): string;
export function deriveVersion(pkgVersion: string): string;
export function buildManifest(template: string, env: Record<string, string | undefined>): string;
export function buildSwaConfig(template: string, env: Record<string, string | undefined>): string;

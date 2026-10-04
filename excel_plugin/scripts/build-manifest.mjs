// Fills manifest.template.xml (default) or staticwebapp.config.template.json into dist/staticwebapp.config.json (--swa) from the environment.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FOUR_PART = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const SWA_PLACEHOLDER = "API_HOST_PLACEHOLDER";

/** Returns the origin of an https URL with no path, query or fragment; throws otherwise. */
export function httpsOrigin(raw, name) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    throw new Error(`${name} must be an https origin, got "${raw ?? ""}"`);
  }
  if (u.protocol !== "https:" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username) {
    throw new Error(`${name} must be an https origin without path or credentials, got "${raw}"`);
  }
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(u.hostname)) throw new Error(`${name} must not be localhost or a loopback address`);
  return u.origin;
}

/** package.json "0.<minor>.<patch>" becomes "1.<minor>.<patch>.0" (Office validators reject 0.x); "X.Y.Z" with X >= 1 becomes "X.Y.Z.0". */
export function deriveVersion(pkgVersion) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(pkgVersion ?? "");
  if (!m) throw new Error(`Cannot derive an add-in version from package version "${pkgVersion}"`);
  return `${m[1] === "0" ? "1" : m[1]}.${m[2]}.${m[3]}.0`;
}

export function buildManifest(template, env) {
  const host = httpsOrigin(env.ADDIN_HOST, "ADDIN_HOST");
  const id = env.ADDIN_ID ?? "";
  if (!GUID.test(id)) throw new Error(`ADDIN_ID must be a GUID, got "${id}"`);
  const version = env.ADDIN_VERSION ?? "";
  const v = FOUR_PART.exec(version);
  if (!v) throw new Error(`ADDIN_VERSION must have four numeric parts (e.g. 1.0.0.0), got "${version}"`);
  if (Number(v[1]) < 1) throw new Error(`ADDIN_VERSION must be >= 1.0.0.0, got "${version}"`);
  const clientId = env.ADDIN_CLIENT_ID ?? "";
  if (!GUID.test(clientId)) throw new Error(`ADDIN_CLIENT_ID must be the Entra application (client) GUID, got "${clientId}"`);
  const resource = env.ADDIN_API_RESOURCE ?? "";
  const expected = `api://${new URL(host).host}/${clientId}`;
  if (!resource.toLowerCase().startsWith(expected.toLowerCase())) throw new Error(`ADDIN_API_RESOURCE must start with ${expected}, got "${resource}"`);
  const out = template.replaceAll("{{HOST}}", host).replaceAll("{{CLIENT_ID}}", clientId).replaceAll("{{SSO_RESOURCE}}", resource).replaceAll("{{ID}}", id).replaceAll("{{VERSION}}", version);
  const left = out.match(/\{\{[A-Z]+\}\}/);
  if (left) throw new Error(`Unfilled placeholder ${left[0]}`);
  if (/localhost|127\.0\.0\.1/i.test(out)) throw new Error("Manifest must not reference localhost");
  return out;
}

export function buildSwaConfig(template, env) {
  const origin = httpsOrigin(env.API_ORIGIN, "API_ORIGIN");
  const out = template.replaceAll(`https://${SWA_PLACEHOLDER}`, origin);
  if (out.includes(SWA_PLACEHOLDER)) throw new Error(`${SWA_PLACEHOLDER} survived substitution`);
  JSON.parse(out);
  return out;
}

function main() {
  const root = new URL("../", import.meta.url);
  if (process.argv.includes("--swa")) {
    const out = buildSwaConfig(readFileSync(new URL("staticwebapp.config.template.json", root), "utf8"), process.env);
    mkdirSync(new URL("dist/", root), { recursive: true });
    writeFileSync(new URL("dist/staticwebapp.config.json", root), out);
    console.log("wrote dist/staticwebapp.config.json");
    return;
  }
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const env = { ...process.env, ADDIN_VERSION: process.env.ADDIN_VERSION ?? deriveVersion(pkg.version) };
  writeFileSync(new URL("manifest.prod.xml", root), buildManifest(readFileSync(new URL("manifest.template.xml", root), "utf8"), env));
  console.log(`wrote manifest.prod.xml (version ${env.ADDIN_VERSION})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

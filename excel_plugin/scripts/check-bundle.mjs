// Fails the build when dist/ carries dev-only code, source maps or an oversized script.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const FORBIDDEN = ["X-Actor", "devAuth", "localhost:"];
export const MAX_GZIP_BYTES = 250 * 1024;

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Returns a list of problems for the files under dir (empty when clean). */
export function checkBundle(dir) {
  const problems = [];
  for (const f of walk(dir)) {
    const name = relative(dir, f);
    const ext = extname(f);
    if (ext === ".map") problems.push(`${name}: source map must not be shipped`);
    if (/\.(png|ico|woff2?)$/.test(ext)) continue;
    const buf = readFileSync(f);
    const text = buf.toString("utf8");
    for (const s of FORBIDDEN) if (text.includes(s)) problems.push(`${name}: contains forbidden string "${s}"`);
    if (ext === ".js" || ext === ".mjs") {
      const gz = gzipSync(buf).length;
      if (gz > MAX_GZIP_BYTES) problems.push(`${name}: ${gz} bytes gzipped exceeds budget of ${MAX_GZIP_BYTES}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Optional argument: the build output to check (default dist/).
  const dist = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../dist", import.meta.url));
  let problems;
  try {
    problems = checkBundle(dist);
  } catch (e) {
    problems = [`cannot read ${dist}: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (problems.length) {
    console.error(`Bundle check failed:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("Bundle check passed.");
}

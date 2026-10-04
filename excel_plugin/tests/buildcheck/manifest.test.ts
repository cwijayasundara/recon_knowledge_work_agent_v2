import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, buildSwaConfig, deriveVersion } from "../../scripts/build-manifest.mjs";

const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");
const template = read("manifest.template.xml");
const ENV = { ADDIN_HOST: "https://addin.example.invalid", ADDIN_ID: "5f0c1c3e-8f6e-4a43-9c52-0a4a8f1d2b77", ADDIN_VERSION: "1.2.3.0",
  ADDIN_CLIENT_ID: "c6c1f32b-5e55-4997-881a-753cc1d563b7", ADDIN_API_RESOURCE: "api://addin.example.invalid/c6c1f32b-5e55-4997-881a-753cc1d563b7" };

describe("buildManifest", () => {
  it("fills host, id and version everywhere and leaves no localhost or placeholder", () => {
    const out = buildManifest(template, ENV);
    expect(out).toContain(`<Id>${ENV.ADDIN_ID}</Id>`);
    expect(out).toContain("<Version>1.2.3.0</Version>");
    expect(out).not.toMatch(/localhost|\{\{/);
    const urls = [...out.matchAll(/https?:\/\/[^"<\s]+/g)].map((m) => m[0]).filter((u) => !/schemas\.microsoft\.com|w3\.org/.test(u));
    expect(urls.length).toBe(9);
    for (const u of urls) expect(u!.startsWith(ENV.ADDIN_HOST)).toBe(true);
    expect(out).toContain(`<SourceLocation DefaultValue="${ENV.ADDIN_HOST}/index.html"/>`);
    expect(out).toContain(`<Id>${ENV.ADDIN_CLIENT_ID}</Id>\n      <Resource>${ENV.ADDIN_API_RESOURCE}</Resource>`);
    expect(out).toContain("<Scope>profile</Scope>");
    expect(out).toContain("<Scope>openid</Scope>");
    expect(out).toContain('<Set Name="ExcelApi" MinVersion="1.9"/>');
    // WebApplicationInfo is the last child of VersionOverrides, after Resources.
    expect(out.indexOf("</Resources>")).toBeLessThan(out.indexOf("<WebApplicationInfo>"));
    expect(out.indexOf("</WebApplicationInfo>")).toBeLessThan(out.indexOf("</VersionOverrides>"));
    expect(out.indexOf("</WebApplicationInfo>") + "</WebApplicationInfo>".length).toBe(out.indexOf("</VersionOverrides>") - "\n  ".length);
    expect(out).toContain(`<AppDomain>${ENV.ADDIN_HOST}</AppDomain>`);
    expect(out).toContain(`<bt:Image id="Icon.80" DefaultValue="${ENV.ADDIN_HOST}/assets/icon-80.png"/>`);
  });

  it("normalises a trailing slash on the host", () => {
    expect(buildManifest(template, { ...ENV, ADDIN_HOST: "https://addin.example.invalid/" })).toContain(`SourceLocation DefaultValue="https://addin.example.invalid/index.html"`);
  });

  it.each([
    ["http host", { ADDIN_HOST: "http://addin.example.invalid" }, /ADDIN_HOST/],
    ["missing host", { ADDIN_HOST: undefined }, /ADDIN_HOST/],
    ["host with path", { ADDIN_HOST: "https://addin.example.invalid/app" }, /ADDIN_HOST/],
    ["127.0.0.1 host", { ADDIN_HOST: "https://127.0.0.1:3100" }, /loopback/],
    ["[::1] host", { ADDIN_HOST: "https://[::1]:3100" }, /loopback/],
    ["missing client id", { ADDIN_CLIENT_ID: undefined }, /ADDIN_CLIENT_ID/],
    ["non-GUID client id", { ADDIN_CLIENT_ID: "nope" }, /ADDIN_CLIENT_ID/],
    ["missing resource", { ADDIN_API_RESOURCE: undefined }, /ADDIN_API_RESOURCE/],
    ["resource on another host", { ADDIN_API_RESOURCE: "api://other.example.invalid/c6c1f32b-5e55-4997-881a-753cc1d563b7" }, /ADDIN_API_RESOURCE/],
    ["resource with another client id", { ADDIN_API_RESOURCE: "api://addin.example.invalid/5f0c1c3e-8f6e-4a43-9c52-0a4a8f1d2b77" }, /ADDIN_API_RESOURCE/],
    ["localhost host", { ADDIN_HOST: "https://localhost:3100" }, /localhost/],
    ["non-GUID id", { ADDIN_ID: "not-a-guid" }, /ADDIN_ID/],
    ["missing id", { ADDIN_ID: undefined }, /ADDIN_ID/],
    ["three-part version", { ADDIN_VERSION: "1.0.0" }, /ADDIN_VERSION/],
    ["0.x version", { ADDIN_VERSION: "0.1.0.0" }, />= 1\.0\.0\.0/],
    ["missing version", { ADDIN_VERSION: undefined }, /ADDIN_VERSION/],
  ])("throws on %s", (_n, over, re) => {
    expect(() => buildManifest(template, { ...ENV, ...over })).toThrow(re);
  });
});

describe("deriveVersion", () => {
  it("maps package versions to four-part versions >= 1.0.0.0", () => {
    expect(deriveVersion("0.1.0")).toBe("1.1.0.0");
    expect(deriveVersion("0.4.7")).toBe("1.4.7.0");
    expect(deriveVersion("2.0.1")).toBe("2.0.1.0");
    expect(() => deriveVersion("x")).toThrow();
  });

  it("package.json's version derives a version the manifest builder accepts", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(() => buildManifest(template, { ...ENV, ADDIN_VERSION: deriveVersion(pkg.version) })).not.toThrow();
  });
});

describe("staticwebapp.config.json", () => {
  const swa = read("staticwebapp.config.template.json");

  it("substitutes the API origin and fails without one", () => {
    const out = buildSwaConfig(swa, { API_ORIGIN: "https://api.example.invalid" });
    expect(out).not.toContain("API_HOST_PLACEHOLDER");
    const csp = (JSON.parse(out) as { globalHeaders: Record<string, string> }).globalHeaders["Content-Security-Policy"]!;
    expect(csp).toContain("connect-src 'self' https://api.example.invalid;");
    expect(csp).toContain("script-src 'self' https://officeapis.public.onecdn.static.microsoft;");
      for (const o of ["https://*.sharepoint.com", "https://*.cloud.microsoft", "https://onedrive.live.com", "https://*.office.com", "https://*.office365.com", "https://*.officeapps.live.com"]) expect(csp).toContain(o);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(() => buildSwaConfig(swa, {})).toThrow(/API_ORIGIN/);
    expect(() => buildSwaConfig(swa, { API_ORIGIN: "http://api.example.invalid" })).toThrow(/API_ORIGIN/);
  });

  it("the repo file is a template, not deployable as is", () => {
    expect(swa).toContain("API_HOST_PLACEHOLDER");
  });

  it("fails if the placeholder survives", () => {
    expect(() => buildSwaConfig(swa.replace("https://API_HOST_PLACEHOLDER", "https://API_HOST_PLACEHOLDER/x API_HOST_PLACEHOLDER"), { API_ORIGIN: "https://api.example.invalid" })).toThrow(/survived/);
  });
});

describe("index.html scripts (SRI decision)", () => {
  // office.js is deliberately loaded without an integrity hash: Microsoft updates it in place and requires the CDN copy.
  // The compensating control is the CSP above (script-src 'self' + that one origin). See README "Security decisions".
  it("loads exactly one external script, office.js from Microsoft's CDN (new endpoint)", () => {
    const html = read("index.html");
    const external = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!).filter((s) => /^(https?:)?\/\//.test(s));
    expect(external).toEqual(["https://officeapis.public.onecdn.static.microsoft/1/office.js"]);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // no inline scripts (CSP)
    expect(html).not.toMatch(/<style|\sstyle=/);
  });
});

it("the dev manifest has no SSO block and no unfilled placeholder", () => {
  const dev = read("manifest.dev.xml");
  expect(dev).not.toMatch(/WebApplicationInfo|\{\{/);
  expect(dev).toContain('<Set Name="ExcelApi" MinVersion="1.9"/>');
});

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/app";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("app renders the heading and settles its async start-up before teardown", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
  render(<App />);
  expect(screen.getByRole("heading", { name: "Onboarding workbench" })).toBeTruthy();
  await screen.findByTestId("sponsor-select");
});

test("an empty or non-http API base shows a configuration error instead of the pane", () => {
  for (const base of ["", "api.example.invalid"]) {
    const { unmount } = render(<App apiBase={base} />);
    expect(screen.getByTestId("error-banner").textContent).toMatch(/VITE_API_BASE/);
    expect(screen.queryByTestId("onboard-button")).toBeNull();
    unmount();
  }
});

function stubApi(version: string | undefined) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const body = String(url).endsWith("/health") ? JSON.stringify(version === undefined ? { status: "ok" } : { status: "ok", version }) : "[]";
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }));
}

test("an API whose major version differs is refused: the incompatibility is shown and the pane never mounts", async () => {
  stubApi("1.2.0");
  render(<App apiBase="https://api.example.test" />);
  expect((await screen.findByTestId("error-banner")).textContent).toBe(
    "Error: This add-in supports API major version 0, but the server reports 1.2.0.",
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId("onboard-button")).toBeNull();
  expect(screen.queryByTestId("sponsor-select")).toBeNull();
});

test.each([["0.4.1"], [undefined]])("a compatible or unversioned /health (%s) mounts the pane", async (version) => {
  stubApi(version);
  render(<App apiBase="https://api.example.test" />);
  await screen.findByTestId("onboard-button");
  expect(screen.queryByTestId("error-banner")).toBeNull();
});

test("a /health that never answers does not keep the pane from mounting", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith("/health")
      ? new Promise<Response>(() => {})
      : new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
  render(<App apiBase="https://api.example.test" healthTimeoutMs={30} />);
  await screen.findByTestId("onboard-button");
  expect(screen.queryByTestId("error-banner")).toBeNull();
});

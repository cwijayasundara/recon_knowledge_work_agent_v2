import { expect, test, vi } from "vitest";
import { devAuth } from "../../src/auth/dev";
import { entraAuth } from "../../src/auth/entra";

test("dev auth sends X-Actor only", async () => {
  expect(await devAuth("ana").headers()).toEqual({ "X-Actor": "ana" });
});

test("entra auth sends a bearer token from Office SSO", async () => {
  const getAccessToken = vi.fn(async () => "tok");
  expect(await entraAuth({ getAccessToken }).headers()).toEqual({ Authorization: "Bearer tok" });
});

test("entra auth surfaces SSO failure as an actionable error", async () => {
  const getAccessToken = vi.fn(async () => { throw { code: 13001 }; });
  await expect(entraAuth({ getAccessToken }).headers()).rejects.toThrow(/sign in/i);
});

test("concurrent requests share one SSO token request (Office rejects a second one while sign-in shows)", async () => {
  let resolve: (t: string) => void = () => {};
  const getAccessToken = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
  const auth = entraAuth({ getAccessToken });
  const a = auth.headers();
  const b = auth.headers();
  expect(getAccessToken).toHaveBeenCalledTimes(1);
  resolve("tok");
  expect(await a).toEqual({ Authorization: "Bearer tok" });
  expect(await b).toEqual({ Authorization: "Bearer tok" });
  getAccessToken.mockImplementationOnce(async () => "tok2");
  expect(await auth.headers()).toEqual({ Authorization: "Bearer tok2" }); // settled: the next call asks again
  expect(getAccessToken).toHaveBeenCalledTimes(2);
});

test("reset drops a hung shared request: the next call asks Office again; a late answer of the old one changes nothing", async () => {
  let resolveOld: (t: string) => void = () => {};
  const getAccessToken = vi.fn()
    .mockImplementationOnce(() => new Promise<string>((r) => { resolveOld = r; }))
    .mockImplementationOnce(async () => "fresh");
  const auth = entraAuth({ getAccessToken });
  void auth.headers();
  auth.reset?.();
  expect(await auth.headers()).toEqual({ Authorization: "Bearer fresh" });
  expect(getAccessToken).toHaveBeenCalledTimes(2);
  resolveOld("old");
  await Promise.resolve();
  getAccessToken.mockImplementationOnce(async () => "third");
  expect(await auth.headers()).toEqual({ Authorization: "Bearer third" });
});

test("Office's 'already in progress' (13008) gets its own message", async () => {
  const auth = entraAuth({ getAccessToken: vi.fn(async () => { throw { code: 13008 }; }) });
  await expect(auth.headers()).rejects.toThrow("Sign-in is already in progress in Excel; wait for the prompt or retry.");
});

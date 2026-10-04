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

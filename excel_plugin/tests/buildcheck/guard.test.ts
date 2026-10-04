import { expect, test } from "vitest";
import { assertProdAuth, assertProdConfig } from "../../buildcheck/guard";

test("production build refuses dev auth", () => {
  expect(() => assertProdAuth("production", "dev")).toThrow(/dev auth/i);
  expect(() => assertProdAuth("production", "entra")).not.toThrow();
  expect(() => assertProdAuth("development", "dev")).not.toThrow();
});

test("production build requires an https VITE_API_BASE", () => {
  const ok = { VITE_AUTH: "entra", VITE_API_BASE: "https://api.example.invalid" };
  expect(() => assertProdConfig("production", ok)).not.toThrow();
  expect(() => assertProdConfig("production", { VITE_AUTH: "entra" })).toThrow(/VITE_API_BASE/);
  expect(() => assertProdConfig("production", { ...ok, VITE_API_BASE: "" })).toThrow(/VITE_API_BASE/);
  expect(() => assertProdConfig("production", { ...ok, VITE_API_BASE: "http://api.example.invalid" })).toThrow(/VITE_API_BASE/);
  expect(() => assertProdConfig("production", { ...ok, VITE_API_BASE: "https://api.example.invalid/v1" })).toThrow(/VITE_API_BASE/);
  expect(() => assertProdConfig("production", { VITE_API_BASE: ok.VITE_API_BASE })).toThrow(/dev auth/i);
  expect(() => assertProdConfig("development", {})).not.toThrow();
});

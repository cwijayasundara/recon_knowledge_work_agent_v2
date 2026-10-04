import { describe, expect, it } from "vitest";
import { parseMaxBytes } from "../src/config";

const DEFAULT = 25 * 1024 * 1024;

describe("parseMaxBytes", () => {
  it("accepts a positive number", () => expect(parseMaxBytes("1000")).toBe(1000));
  it.each([undefined, "", "abc", "0", "-5", "Infinity"])("falls back for %s", (v) => expect(parseMaxBytes(v)).toBe(DEFAULT));
});

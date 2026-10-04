import { ESLint } from "eslint";
import { expect, it } from "vitest";

// Workbook rows and snapshots must never be logged: console is banned in src, except one warn in main.tsx.
const lint = async (code: string, filePath: string) => (await new ESLint().lintText(code, { filePath })).flatMap((r) => r.messages).filter((m) => m.ruleId === "no-console");

it("bans console in src", { timeout: 30_000 }, async () => {
  expect(await lint("export const f = (grid: string[][]) => console.log(grid);", "src/ui/x.ts")).toHaveLength(1);
  expect(await lint("console.warn('x');", "src/ui/x.ts")).toHaveLength(1);
});

it("allows console.warn only in src/main.tsx", { timeout: 30_000 }, async () => {
  expect(await lint("console.warn('x');", "src/main.tsx")).toHaveLength(0);
  expect(await lint("console.log('x');", "src/main.tsx")).toHaveLength(1);
});

it("the current src tree has no console calls", { timeout: 30_000 }, async () => {
  const results = await new ESLint().lintFiles(["src"]);
  expect(results.flatMap((r) => r.messages).filter((m) => m.ruleId === "no-console")).toEqual([]);
});

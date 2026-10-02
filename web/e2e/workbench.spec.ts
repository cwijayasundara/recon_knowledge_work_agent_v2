import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../tests/fixtures/affiliate");

async function upload(page: Page, fixture: string, sponsor = "sponsor-a") {
  await page.goto("/");
  await page.getByLabel("Sponsor", { exact: true }).selectOption(sponsor);
  await page.getByTestId("upload").setInputFiles(path.join(FIXTURES, fixture));
  await page.waitForURL(/\/runs\/run-/);
}

async function waitIdle(page: Page) {
  await expect(page.locator(".spin")).toHaveCount(0, { timeout: 30_000 });
}

async function tab(page: Page, phase: number) {
  await page.getByTestId(`tab-p${phase}`).click();
  await expect(page.getByTestId(`tab-p${phase}`)).toHaveAttribute("aria-selected", "true");
}

async function confirmBrief(page: Page) {
  await expect(page.getByTestId("approve-brief")).toBeEnabled();
  await page.getByTestId("approve-brief").click();
  await expect(page.getByTestId("wf-gate-brief")).toContainText("Passed");
  // The tabs follow the run past the gate; the saved choices stay on the Phase 1 tab.
  await expect(page.getByTestId("tab-p1")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#ph-p1")).toContainText("Column choices saved");
}

async function passFindingsAndGenerate(page: Page) {
  await tab(page, 3);
  await expect(page.getByTestId("pass-findings")).toBeEnabled();
  await page.getByTestId("pass-findings").click();
  await expect(page.getByTestId("generate")).toBeEnabled();
  await expect(page.getByTestId("tab-p4")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("artifacts")).toContainText("Affiliates.csv");
  await expect(page.getByTestId("artifacts")).toContainText("manifest.json");
}

test("1 clean.csv: no questions, straight through", async ({ page }, info) => {
  await upload(page, "clean.csv");
  await expect(page.getByTestId("brief-card")).toContainText("Affiliate ID");
  await expect(page.getByTestId("question-card")).toHaveCount(0);
  await confirmBrief(page);
  await expect(page.getByTestId("dq-panel")).toContainText("No errors.");
  await passFindingsAndGenerate(page);
  await expect(page.getByTestId("template-preview")).toContainText("AFF_9001");
  await info.attach("clean", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("2 edge.csv: resolve every error in the grid, acknowledge warnings", async ({ page }, info) => {
  // A sponsor with no history, so the brief gate is not skipped by a replay of clean.csv's layout.
  await upload(page, "edge.csv", "sponsor-b");
  await confirmBrief(page);
  await expect(page.getByTestId("pass-findings")).toBeDisabled();

  // Row 1 is empty: exclude it.
  await tab(page, 3);
  await page.getByTestId("dq-panel").locator(".flag", { hasText: "Row 1 " }).getByRole("button", { name: "Exclude row" }).click();
  await expect(page.getByTestId("id-grid")).toContainText("ROW_EXCLUDED");
  await waitIdle(page);
  for (const [row, value] of [[2, "AFF_9999"], [4, "AFF_9011"], [6, "CASCADE_EMP_COINV_BETA"]] as const) {
    await tab(page, 2);
    await page.getByRole("button", { name: `Edit ITEM_ID for row ${row}` }).click();
    await page.locator(`#ov${row}`).fill(value);
    await expect(page.locator(`#h${row}`)).toContainText("valid");
    await page.getByRole("button", { name: "Apply ID" }).click();
    await expect(page.locator(`#ov${row}`)).toHaveCount(0);
    // Clearing the last collision moves the run (and the tabs) on to Phase 3, so check presence, not visibility.
    await expect(page.getByTestId("id-grid").locator("tr", { hasText: value }).locator(".meth.ovr")).toHaveCount(1);
    await waitIdle(page);
  }
  await expect(page.getByTestId("dq-panel")).toContainText("No errors.");
  await tab(page, 3);
  // Acknowledge each warning, one click per flag.
  const panel = page.getByTestId("dq-panel");
  for (let left = await panel.getByRole("button", { name: "Acknowledge" }).count(); left > 0; left--) {
    await panel.getByRole("button", { name: "Acknowledge" }).first().click();
    await expect(panel.getByRole("button", { name: "Acknowledge" })).toHaveCount(left - 1);
    await waitIdle(page);
  }
  await passFindingsAndGenerate(page);
  await expect(page.getByTestId("ledger")).toContainText("run.locked");
  await info.attach("edge", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("5 titled.xlsx: header found on row 4, total row dropped", async ({ page }, info) => {
  await upload(page, "titled.xlsx");
  await expect(page.getByTestId("brief-card")).toContainText("header row 4");
  await confirmBrief(page);
  await passFindingsAndGenerate(page);
  await expect(page.getByTestId("template-preview").locator("tbody tr")).toHaveCount(8);
  await info.attach("titled", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("9 returning_sponsor.xlsx: recalled from history, no brief gate", async ({ page }, info) => {
  await upload(page, "renamed.xlsx", "sponsor-a");
  await confirmBrief(page);
  await passFindingsAndGenerate(page);

  await upload(page, "returning_sponsor.xlsx", "sponsor-a");
  await expect(page.getByTestId("phase-state-p1")).toHaveText("Recalled from history");
  await expect(page.getByTestId("wf-gate-brief")).toContainText("Skipped · recalled");
  await tab(page, 1);
  await expect(page.getByText(/Recalled from sponsor-a history/)).toBeVisible();
  await passFindingsAndGenerate(page);
  await expect(page.getByTestId("template-preview")).toContainText("AFF_9101");
  await info.attach("returning", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("workflow diagram marks the stage and the tabs follow the run", async ({ page }, info) => {
  await upload(page, "clean.csv", "sponsor-c");
  await expect(page.getByTestId("wf-node-p1")).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("wf-gate-brief")).toContainText("Waiting for you");
  await expect(page.getByTestId("tab-p1")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#ph-p3")).toBeHidden();

  await confirmBrief(page);
  await expect(page.getByTestId("wf-node-p3")).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("wf-gate-findings")).toContainText("Waiting for you");
  await expect(page.getByTestId("tab-p3")).toHaveAttribute("aria-selected", "true");

  // Reviewing an earlier phase sticks until the analyst goes back to the run.
  await page.getByTestId("wf-node-p1").click();
  await expect(page.getByTestId("tab-p1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/Column choices saved/)).toBeVisible();
  await page.getByTestId("back-to-run").click();
  await expect(page.getByTestId("tab-p3")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("back-to-run")).toHaveCount(0);

  // Arrow keys move between tabs.
  await page.getByTestId("tab-p3").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tab-p4")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tab-p4")).toBeFocused();

  await passFindingsAndGenerate(page);
  await expect(page.getByTestId("wf-gate-signoff")).toContainText("Passed");
  await expect(page.getByLabel("Run locked")).toBeVisible();
  await info.attach("workflow", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

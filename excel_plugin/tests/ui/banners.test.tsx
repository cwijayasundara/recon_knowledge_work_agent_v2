import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import { ErrorBanner } from "../../src/ui/ErrorBanner";

afterEach(cleanup);

test("the error banner is announced and starts with the visible word Error", () => {
  render(<ErrorBanner message="boom" />);
  const el = screen.getByRole("alert");
  expect(el.textContent).toMatch(/^Error: boom/);
});

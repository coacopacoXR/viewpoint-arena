import { test, expect } from "@playwright/test";

test("app loads and shows the lobby heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText("Viewpoint Arena");
});

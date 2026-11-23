import { expect, test } from "@playwright/test";

/** Visual regression. Run with `npm run test:visual`; update baselines with `-- --update-snapshots`. */
test.describe("@visual", () => {
  test("@visual empty court", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot("court-empty.png");
  });

  test("@visual FAQ page", async ({ page }) => {
    await page.goto("/faq");
    await expect(page).toHaveScreenshot("faq.png", { fullPage: true });
  });
});

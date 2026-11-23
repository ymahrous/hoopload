import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { pdf } from "./helpers";

for (const path of ["/", "/how-it-works", "/faq"]) {
  test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  });
}

test("the court is playable with the keyboard alone", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  await page.locator('input[type="file"]').setInputFiles([pdf("keys.pdf", 1000)]);
  const ball = page.getByRole("button", { name: /^keys\.pdf\./ });
  await ball.focus();
  await expect(ball).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".upload-row", { hasText: "keys.pdf" })).toContainText("Uploaded", { timeout: 15_000 });

  // Locker: opens as a labelled region, closes with Escape.
  await page.getByRole("button", { name: /Locker/ }).click();
  await expect(page.getByRole("complementary", { name: "Uploaded files" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".locker")).toHaveAttribute("data-open", "false");
});

test("respects prefers-reduced-motion", async ({ browser }) => {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await page.goto("/faq");
  const duration = await page.locator(".cta-button").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.01);
});

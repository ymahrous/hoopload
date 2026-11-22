import { expect, test } from "@playwright/test";

test("home renders the court, hoop and navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Upload files" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Drop files here/ })).toHaveAccessibleDescription(/Opens a file picker/);
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "FAQ" })).toHaveAttribute("href", "/faq");
});

test("header pills are legible (regression: CTA class once turned the Locker label white-on-white)", async ({ page }) => {
  await page.goto("/");
  const locker = page.getByRole("button", { name: /Locker/ });
  await expect(locker).toHaveText(/Locker\s*\d+/);
  const [fg, bg] = await locker.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
  expect(fg).not.toBe(bg);
  expect(fg).not.toBe("rgb(255, 255, 255)");
});

test("health endpoint is shallow by default", async ({ request }) => {
  const body = await (await request.get("/api/health")).json();
  expect(body.ok).toBe(true);
  expect(body.db).toBeUndefined();
});

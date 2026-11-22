import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export const pdf = (name: string, size = 300_000) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(size)]),
});

export async function addToCourt(page: Page, files: ReturnType<typeof pdf>[]) {
  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.locator(".ball")).toHaveCount(files.length);
  // Let balls glide into their slots.
  await page.waitForTimeout(700);
}

/** Keyboard-triggered assisted shot (same as a tap). */
export async function assistedShot(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`) }).press("Enter");
}

export const row = (page: Page, name: string) => page.locator(".upload-row", { hasText: name });

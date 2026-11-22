import { expect, test } from "@playwright/test";
import { addToCourt, assistedShot, pdf, row } from "./helpers";

test.describe("uploading by playing", () => {
  test("assisted shot scores, uploads, and the file downloads byte-for-byte", async ({ page }) => {
    await page.goto("/");
    const file = pdf("scouting report.pdf", 5_500_000); // 2 chunks
    await addToCourt(page, [file]);

    await assistedShot(page, file.name);
    await expect(page.locator(".dropzone")).toHaveAttribute("data-hot", "true");
    await expect(row(page, file.name)).toContainText("Uploaded", { timeout: 20_000 });
    await expect(page.locator(".ball")).toHaveCount(0);
    await expect(page.getByText(/Uploaded\s*1/)).toBeVisible();

    await page.getByRole("button", { name: /Locker/ }).click();
    const link = page.getByRole("complementary", { name: "Uploaded files" }).getByRole("listitem").filter({ hasText: file.name }).getByRole("link", { name: "Download" });
    // page.request carries this browser's identity cookie; files are private to it.
    const res = await page.request.get((await link.getAttribute("href"))!);
    expect(res.status()).toBe(200);
    expect(Buffer.compare(await res.body(), file.buffer)).toBe(0);
  });

  test("slingshot: pulling back and releasing takes a shot", async ({ page }) => {
    await page.goto("/");
    await addToCourt(page, [pdf("pull.pdf", 1000)]);
    const box = (await page.locator(".ball").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y + 90, { steps: 10 });
    await expect(page.locator(".ball")).toHaveAttribute("data-mode", "aim");
    await page.mouse.up();
    await expect(page.getByText(/FG \d\/1/)).toBeVisible();
  });

  test("dropping files on the hoop dunks them", async ({ page }) => {
    await page.goto("/");
    const zone = page.locator(".dropzone");
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["%PDF-1.7 dunk"], "dunk.pdf", { type: "application/pdf" }));
      return d;
    });
    const box = (await zone.boundingBox())!;
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await zone.dispatchEvent("dragenter", { dataTransfer: dt, ...at });
    await zone.dispatchEvent("dragover", { dataTransfer: dt, ...at });
    await zone.dispatchEvent("drop", { dataTransfer: dt, ...at });
    await expect(row(page, "dunk.pdf")).toContainText("Uploaded", { timeout: 15_000 });
  });

  test("the same file twice is deduplicated", async ({ page }) => {
    await page.goto("/");
    const file = pdf("twice.pdf", 50_000);
    await addToCourt(page, [file]);
    await assistedShot(page, file.name);
    await expect(row(page, file.name)).toContainText("Uploaded", { timeout: 15_000 });

    await addToCourt(page, [file]);
    await assistedShot(page, file.name);
    await expect(row(page, file.name).first()).toContainText("already stored", { timeout: 15_000 });
  });

  test("an executable renamed to .pdf is rejected with a clear error", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[type="file"]').setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4000, 1)]) });
    await page.waitForTimeout(600);
    await assistedShot(page, "invoice.pdf");
    await expect(row(page, "invoice.pdf")).toContainText("Executable files are not accepted.", { timeout: 15_000 });
    await expect(row(page, "invoice.pdf").getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("Shoot all fires every waiting file", async ({ page }) => {
    await page.goto("/");
    await addToCourt(page, [pdf("one.pdf", 2000), pdf("two.pdf", 2000), pdf("three.pdf", 2000)]);
    await page.getByRole("button", { name: "Shoot all" }).click();
    for (const n of ["one.pdf", "two.pdf", "three.pdf"]) await expect(row(page, n)).toContainText("Uploaded", { timeout: 20_000 });
  });
});

test("live updates reach your other tabs — and never another browser", async ({ browser }) => {
  const mine = await browser.newContext();
  const watcher = await mine.newPage();
  const shooter = await mine.newPage(); // same browser profile = same identity
  const stranger = await (await browser.newContext()).newPage(); // different browser = different identity

  for (const p of [watcher, stranger]) {
    await p.goto("/");
    await p.getByRole("button", { name: /Locker/ }).click();
    await expect(p.getByText("Live", { exact: true })).toBeVisible();
  }

  await shooter.goto("/");
  const file = pdf("broadcast.pdf", 3000);
  await addToCourt(shooter, [file]);
  await assistedShot(shooter, file.name);

  await expect(watcher.getByRole("complementary", { name: "Uploaded files" }).getByText(file.name)).toBeVisible({ timeout: 15_000 });
  await stranger.waitForTimeout(1500);
  await expect(stranger.getByRole("complementary", { name: "Uploaded files" }).getByText(file.name)).toHaveCount(0);
  await expect(stranger.getByText("No files yet. Sink one.")).toBeVisible();
});

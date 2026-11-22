import { expect, test } from "@playwright/test";
import { addToCourt, assistedShot, pdf, row } from "./helpers";

test("pages ship a nonce CSP and the app runs under it with zero violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply|connect|create)/i.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto("/");
  const csp = res!.headers()["content-security-policy"];
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-eval");

  // Next's scripts carry the per-request nonce.
  const nonces = await page.locator("script[src]").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce));
  expect(nonces.length).toBeGreaterThan(0);
  expect(nonces.every((n) => n === nonce)).toBe(true);

  // A full upload (Web Worker hashing, XHR, SSE) works under the policy.
  const file = pdf("csp.pdf", 20_000);
  await addToCourt(page, [file]);
  await assistedShot(page, file.name);
  await expect(row(page, file.name)).toContainText("Uploaded", { timeout: 20_000 });
  expect(violations).toEqual([]);

  // A fresh nonce per request.
  const again = await page.request.get("/");
  expect(/'nonce-([^']+)'/.exec(again.headers()["content-security-policy"])?.[1]).not.toBe(nonce);
});

test("an XSS payload in injected markup cannot execute (inline handlers blocked)", async ({ page }) => {
  const blocked: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) blocked.push(m.text());
  });
  await page.goto("/faq");
  const ran = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const w = window as unknown as { __pwned?: boolean };
        w.__pwned = false;
        // What a stored/reflected XSS would inject: markup with inline event handlers.
        const host = document.createElement("div");
        host.innerHTML = '<img src="data:," onload="window.__pwned=true"><img src="x:" onerror="window.__pwned=true">';
        document.body.appendChild(host);
        setTimeout(() => resolve(Boolean(w.__pwned)), 300);
      }),
  );
  expect(ran).toBe(false);
  expect(blocked.length).toBeGreaterThan(0);
});

test("security headers on pages and API", async ({ request }) => {
  const page = await request.get("/faq");
  const h = page.headers();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["cross-origin-opener-policy"]).toBe("same-origin");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("camera=()");
  expect(h["strict-transport-security"]).toContain("max-age=63072000");
  expect(h["x-powered-by"]).toBeUndefined();

  const api = await request.get("/api/files");
  expect(api.headers()["cache-control"]).toBe("no-store");
  expect(api.headers()["access-control-allow-origin"]).toBeUndefined(); // no CORS
});

test("identity cookie is HttpOnly, SameSite=Lax and not readable from JavaScript", async ({ page, context }) => {
  await page.goto("/");
  await expect.poll(async () => (await context.cookies()).find((c) => c.name.endsWith("hl_owner"))).toBeTruthy();
  const cookie = (await context.cookies()).find((c) => c.name.endsWith("hl_owner"))!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("hl_owner");
});

test("another browser cannot download your file even with its exact URL", async ({ browser, page }) => {
  await page.goto("/");
  const file = pdf("mine-only.pdf", 2000);
  await addToCourt(page, [file]);
  await assistedShot(page, file.name);
  await expect(row(page, file.name)).toContainText("Uploaded", { timeout: 15_000 });
  await page.getByRole("button", { name: /Locker/ }).click();
  const href = await page.getByRole("complementary", { name: "Uploaded files" }).getByRole("listitem").filter({ hasText: file.name }).getByRole("link").getAttribute("href");

  expect((await page.request.get(href!)).status()).toBe(200);
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();
  await other.goto("/");
  await expect.poll(async () => (await otherCtx.cookies()).some((c) => c.name.endsWith("hl_owner"))).toBe(true);
  expect((await other.request.get(href!)).status()).toBe(404);
  expect((await other.request.delete(href!, { headers: { origin: "http://evil.example" } })).status()).toBe(403);
});

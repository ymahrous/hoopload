import { expect, test } from "@playwright/test";

/** Lab Core Web Vitals budgets (local production build). */
for (const path of ["/", "/faq"]) {
  test(`${path} meets LCP/CLS budgets and ships little JavaScript`, async ({ page }) => {
    let jsBytes = 0;
    page.on("response", async (r) => {
      if (r.request().resourceType() === "script") jsBytes += Number(r.headers()["content-length"] ?? (await r.body().catch(() => Buffer.alloc(0))).length);
    });
    // Not "networkidle": the live-update stream (SSE) stays open by design.
    await page.goto(path, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const vitals = await page.evaluate(
      () =>
        new Promise<{ lcp: number; cls: number }>((resolve) => {
          let lcp = 0;
          let cls = 0;
          new PerformanceObserver((l) => l.getEntries().forEach((e) => (lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
          new PerformanceObserver((l) =>
            l.getEntries().forEach((e) => {
              const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
              if (!s.hadRecentInput) cls += s.value;
            }),
          ).observe({ type: "layout-shift", buffered: true });
          setTimeout(() => resolve({ lcp, cls }), 1200);
        }),
    );
    expect(vitals.lcp).toBeLessThan(2500);
    expect(vitals.cls).toBeLessThan(0.1);
    expect(jsBytes).toBeLessThan(400 * 1024);
  });
}

import { expect, test } from "@playwright/test";

const PAGES = [
  { path: "/", types: ["WebSite", "WebApplication"] },
  { path: "/how-it-works", types: ["HowTo", "TechArticle", "BreadcrumbList"] },
  { path: "/faq", types: ["FAQPage", "BreadcrumbList"] },
];

for (const { path, types } of PAGES) {
  test(`${path}: complete head, one h1, valid JSON-LD`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    const title = await page.title();
    expect(title.length).toBeGreaterThan(10);
    expect(title.length).toBeLessThanOrEqual(70);
    const desc = await page.locator('meta[name="description"]').getAttribute("content");
    expect(desc!.length).toBeGreaterThan(70);
    expect(desc!.length).toBeLessThanOrEqual(320);

    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonical).toMatch(/^https?:\/\//);
    expect(new URL(canonical!).pathname).toBe(path);

    for (const prop of ["og:title", "og:description", "og:url", "og:image", "og:type", "og:site_name"]) {
      await expect(page.locator(`meta[property="${prop}"]`).first(), prop).toHaveAttribute("content", /.+/);
    }
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index, follow/);
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);

    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    const parsed = ld.flatMap((t) => JSON.parse(t)).map((x: Record<string, unknown>) => x["@type"]);
    expect(parsed).toEqual(types);

    // Every image has alt text or is decorative.
    expect(await page.locator("img:not([alt])").count()).toBe(0);
  });
}

test("robots.txt welcomes AI crawlers, hides the API, links the sitemap", async ({ request }) => {
  const body = await (await request.get("/robots.txt")).text();
  expect(body).toContain("Disallow: /api/");
  for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) expect(body).toContain(`User-Agent: ${bot}`);
  expect(body).toMatch(/Sitemap: https?:\/\/.+\/sitemap\.xml/);
});

test("sitemap.xml lists all public pages", async ({ request }) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml.match(/<loc>/g)).toHaveLength(3);
  expect(xml).toContain("/how-it-works</loc>");
  expect(xml).toContain("<lastmod>");
});

test("llms.txt and llms-full.txt are served as markdown", async ({ request }) => {
  for (const p of ["/llms.txt", "/llms-full.txt"]) {
    const res = await request.get(p);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/markdown");
    expect(await res.text()).toMatch(/^# Hoopload/);
  }
});

test("Open Graph image, apple icon and manifest resolve", async ({ request }) => {
  const og = await request.get("/opengraph-image");
  expect(og.headers()["content-type"]).toBe("image/png");
  const png = await og.body();
  expect(png.readUInt32BE(16)).toBe(1200); // IHDR width
  expect(png.readUInt32BE(20)).toBe(630); // IHDR height
  expect((await request.get("/apple-icon")).headers()["content-type"]).toBe("image/png");
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.short_name).toBe("Hoopload");
});

test("API responses and downloads are not indexable", async ({ request }) => {
  const res = await request.get("/api/files");
  expect(res.headers()["cache-control"]).toBe("no-store");
});

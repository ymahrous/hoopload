import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import robots, { AI_CRAWLERS } from "@/app/robots";
import sitemap from "@/app/sitemap";
import { breadcrumbLd, faqLd, howToLd, serializeLd, techArticleLd, webAppLd, websiteLd } from "@/lib/seo/jsonld";
import { llmsFullTxt, llmsTxt } from "@/lib/seo/llms";
import { CHUNK_SIZE, MAX_FILE_SIZE } from "@/lib/shared/protocol";
import { FACTS, FAQS, HOW_TO_STEPS, NAV, SITE } from "@/lib/site";

describe("robots.txt", () => {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];

  it("blocks the API for everyone and points at the sitemap", () => {
    for (const rule of rules) expect(rule.disallow).toContain("/api/");
    expect(r.sitemap).toBe(`${SITE.url}/sitemap.xml`);
  });

  it("explicitly allows major AI answer-engine crawlers (GEO)", () => {
    const ai = rules.find((x) => Array.isArray(x.userAgent));
    for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "OAI-SearchBot"]) expect(AI_CRAWLERS).toContain(bot);
    expect(ai?.allow).toEqual(expect.arrayContaining(["/", "/llms.txt"]));
  });
});

describe("sitemap.xml", () => {
  it("lists every navigable page with absolute URLs", () => {
    const urls = sitemap().map((e) => e.url);
    for (const n of NAV) expect(urls).toContain(n.href === "/" ? SITE.url : `${SITE.url}${n.href}`);
    expect(urls.every((u) => u.startsWith("http"))).toBe(true);
  });
});

describe("web manifest", () => {
  it("is installable", () => {
    const m = manifest();
    expect(m.name).toContain(SITE.name);
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.icons?.length).toBeGreaterThan(0);
  });
});

describe("JSON-LD", () => {
  it("every block has a schema.org context and type", () => {
    for (const ld of [websiteLd(), webAppLd(), faqLd(), howToLd(), techArticleLd(), breadcrumbLd([{ name: "x", path: "/" }])]) {
      expect(ld["@context"]).toBe("https://schema.org");
      expect(typeof ld["@type"]).toBe("string");
    }
  });

  it("FAQPage mirrors the visible FAQ exactly (required for rich results)", () => {
    const ld = faqLd() as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(ld.mainEntity).toHaveLength(FAQS.length);
    ld.mainEntity.forEach((q, i) => {
      expect(q.name).toBe(FAQS[i].q);
      expect(q.acceptedAnswer.text).toBe(FAQS[i].a);
    });
  });

  it("HowTo steps are numbered in order", () => {
    const ld = howToLd() as { step: { position: number; name: string }[] };
    expect(ld.step.map((s) => s.position)).toEqual(HOW_TO_STEPS.map((_, i) => i + 1));
  });

  it("never fabricates ratings or reviews", () => {
    const all = JSON.stringify([websiteLd(), webAppLd(), faqLd(), howToLd(), techArticleLd()]);
    expect(all).not.toMatch(/aggregateRating|"review"/i);
  });

  it("serialisation cannot break out of the script tag", () => {
    const out = serializeLd({ "@context": "https://schema.org", "@type": "Thing", name: "</script><script>alert(1)</script> " });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain(" ");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script> ");
  });
});

describe("AEO copy", () => {
  it("FAQ answers are short and answer-first (fit a featured snippet)", () => {
    for (const f of FAQS) {
      expect(f.q.endsWith("?")).toBe(true);
      const words = f.a.split(/\s+/).length;
      expect(words, f.id).toBeLessThanOrEqual(60);
      expect(f.a.split(". ")[0].length, f.id).toBeLessThan(220);
    }
  });

  it("FAQ ids are unique, URL-safe anchors", () => {
    const ids = FAQS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("published facts are derived from the real limits", () => {
    expect(FACTS.chunkSizeMb).toBe(CHUNK_SIZE / 1024 / 1024);
    expect(FACTS.maxFileMb).toBe(MAX_FILE_SIZE / 1024 / 1024);
  });

  it("meta description is within the length search engines display", () => {
    expect(SITE.description.length).toBeGreaterThan(70);
    expect(SITE.description.length).toBeLessThanOrEqual(320);
  });
});

describe("llms.txt (GEO)", () => {
  it("follows the llms.txt shape: H1, blockquote summary, link sections", () => {
    const t = llmsTxt();
    expect(t.startsWith(`# ${SITE.name}\n`)).toBe(true);
    expect(t).toMatch(/\n> .+/);
    expect(t).toMatch(/## Pages\n/);
    expect(t).toContain(`${SITE.url}/faq`);
  });

  it("llms-full.txt contains every FAQ and every step", () => {
    const t = llmsFullTxt();
    for (const f of FAQS) expect(t).toContain(f.q);
    for (const s of HOW_TO_STEPS) expect(t).toContain(s.name);
    expect(t).toContain(`${FACTS.maxFileMb} MB`);
  });
});

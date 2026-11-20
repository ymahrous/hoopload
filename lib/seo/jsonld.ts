import { FACTS, FAQS, HOW_TO_STEPS, PIPELINE, SITE, absoluteUrl, type Faq } from "@/lib/site";

/**
 * schema.org builders. Everything here is factual and verifiable on the page:
 * no ratings, reviews or claims that the page itself does not show.
 */

type Thing = Record<string, unknown>;

const org = (): Thing => ({ "@type": "Organization", name: SITE.name, url: SITE.url, logo: absoluteUrl("/icon.svg") });

export function websiteLd(): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE.url}/#website`,
    name: SITE.name,
    alternateName: SITE.tagline,
    url: SITE.url,
    description: SITE.description,
    inLanguage: "en",
    publisher: org(),
  };
}

export function webAppLd(): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": `${SITE.url}/#app`,
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    applicationCategory: "UtilitiesApplication",
    applicationSubCategory: "File upload",
    operatingSystem: "Any (web browser)",
    browserRequirements: "Requires JavaScript and a modern browser.",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    featureList: [
      "Slingshot and assisted shots to upload files",
      `Chunked uploads (${FACTS.chunkSizeMb} MB chunks, up to ${FACTS.maxFileMb} MB per file)`,
      `${FACTS.hash} integrity checks on every chunk`,
      "Content-addressed deduplication",
      `Resumable uploads for ${FACTS.resumeHours} hours`,
      "Live file list across tabs (Server-Sent Events)",
      "Keyboard and screen-reader support",
    ],
    dateModified: SITE.updated,
    publisher: org(),
  };
}

export function faqLd(faqs: Faq[] = FAQS): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${absoluteUrl("/faq")}#faq`,
    url: absoluteUrl("/faq"),
    dateModified: SITE.updated,
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      url: `${absoluteUrl("/faq")}#${f.id}`,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
    // Voice assistants read the question and answer blocks.
    speakable: { "@type": "SpeakableSpecification", cssSelector: [".faq-q", ".faq-a"] },
  };
}

export function howToLd(): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "@id": `${absoluteUrl("/how-it-works")}#howto`,
    name: "How to upload a file with Hoopload",
    description: "Upload a file by shooting it into the hoop.",
    totalTime: "PT10S",
    tool: [{ "@type": "HowToTool", name: "A web browser" }],
    step: HOW_TO_STEPS.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
      url: `${absoluteUrl("/how-it-works")}#step-${i + 1}`,
    })),
  };
}

export function techArticleLd(): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${absoluteUrl("/how-it-works")}#article`,
    headline: "How Hoopload works: a gamified, resumable file upload pipeline",
    description: PIPELINE.map((p) => p.text).join(" "),
    url: absoluteUrl("/how-it-works"),
    dateModified: SITE.updated,
    datePublished: "2026-11-24",
    inLanguage: "en",
    proficiencyLevel: "Beginner",
    about: ["File upload", "Resumable uploads", "Deduplication", "SHA-256"],
    author: org(),
    publisher: org(),
    isPartOf: { "@id": `${SITE.url}/#website` },
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: absoluteUrl(it.path) })),
  };
}

/** Serialises JSON-LD safe for inline <script>: `<` can never close the tag. */
export function serializeLd(data: Thing | Thing[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

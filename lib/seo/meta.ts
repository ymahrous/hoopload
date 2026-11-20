import type { Metadata } from "next";
import { SITE } from "@/lib/site";

const OG_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: `${SITE.name} — ${SITE.tagline}` };

/**
 * Per-page metadata. Next.js replaces (not merges) a parent's `openGraph`
 * object, so every page sets images explicitly or loses its social card.
 */
export function pageMetadata(opts: { title: string; description: string; path: string; type?: "website" | "article" }): Metadata {
  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: opts.path },
    openGraph: {
      type: opts.type ?? "website",
      siteName: SITE.name,
      locale: SITE.locale,
      title: opts.title,
      description: opts.description,
      url: opts.path,
      images: [OG_IMAGE],
    },
    twitter: { card: "summary_large_image", title: opts.title, description: opts.description, images: [OG_IMAGE.url] },
  };
}

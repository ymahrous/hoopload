import type { MetadataRoute } from "next";
import { SITE, absoluteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date(SITE.updated);
  return [
    { url: absoluteUrl("/"), lastModified, changeFrequency: "monthly", priority: 1 },
    { url: absoluteUrl("/how-it-works"), lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/faq"), lastModified, changeFrequency: "monthly", priority: 0.8 },
  ];
}

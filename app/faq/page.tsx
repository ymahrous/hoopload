import type { Metadata } from "next";
import Link from "next/link";
import { DocShell } from "@/components/DocShell";
import { JsonLd } from "@/components/seo/JsonLd";
import { pageMetadata } from "@/lib/seo/meta";
import { breadcrumbLd, faqLd } from "@/lib/seo/jsonld";
import { FAQS, SITE } from "@/lib/site";

const title = "FAQ: file size limits, resuming, duplicates and safety";
const description = `Short answers about ${SITE.name}: maximum file size, what happens when you miss, resumable uploads, deduplication, allowed file types and accessibility.`;

export const metadata: Metadata = pageMetadata({ title, description, path: "/faq", type: "website" });

export default function FaqPage() {
  return (
    <DocShell current="/faq">
      <JsonLd data={[faqLd(), breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "FAQ", path: "/faq" }])]} />
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">{SITE.name}</Link> <span aria-hidden="true">/</span> <span aria-current="page">FAQ</span>
      </nav>
      <h1>Frequently asked questions</h1>
      <p className="lede">Everything about uploading files with {SITE.name}, answered in a sentence or two.</p>
      <div className="faq">
        {FAQS.map((f) => (
          <section key={f.id} id={f.id} aria-labelledby={`${f.id}-q`}>
            <h2 id={`${f.id}-q`} className="faq-q">
              {f.q}
            </h2>
            <p className="faq-a">{f.a}</p>
          </section>
        ))}
      </div>
      <p className="cta">
        <Link href="/" className="cta-button">Start uploading</Link> <Link href="/how-it-works">How it works</Link>
      </p>
    </DocShell>
  );
}

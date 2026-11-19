import type { Metadata } from "next";
import Link from "next/link";
import { DocShell } from "@/components/DocShell";
import { JsonLd } from "@/components/seo/JsonLd";
import { pageMetadata } from "@/lib/seo/meta";
import { breadcrumbLd, howToLd, techArticleLd } from "@/lib/seo/jsonld";
import { FACTS, HOW_TO_STEPS, PIPELINE, SITE } from "@/lib/site";

const title = "How it works: upload files by shooting hoops";
const description = `How to upload a file with ${SITE.name}, and how the pipeline behind the game works: ${FACTS.chunkSizeMb} MB chunks, ${FACTS.hash} verification, deduplication and resumable uploads.`;

export const metadata: Metadata = pageMetadata({ title, description, path: "/how-it-works", type: "article" });

export default function HowItWorks() {
  return (
    <DocShell current="/how-it-works">
      <JsonLd data={[howToLd(), techArticleLd(), breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "How it works", path: "/how-it-works" }])]} />
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">{SITE.name}</Link> <span aria-hidden="true">/</span> <span aria-current="page">How it works</span>
      </nav>
      <article>
        <h1>How {SITE.name} works</h1>
        <p className="lede">
          <strong>{SITE.name} uploads a file when you shoot it through the hoop.</strong> A make starts a real upload: the file is split into{" "}
          {FACTS.chunkSizeMb} MB chunks, each chunk is verified with {FACTS.hash}, identical files are stored once, and interrupted uploads resume.
        </p>

        <section aria-labelledby="play">
          <h2 id="play">How to upload a file</h2>
          <ol className="steps">
            {HOW_TO_STEPS.map((s, i) => (
              <li key={s.name} id={`step-${i + 1}`}>
                <h3>{s.name}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="pipeline">
          <h2 id="pipeline">What happens after you score</h2>
          <ol className="steps">
            {PIPELINE.map((s) => (
              <li key={s.name}>
                <h3>{s.name}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="limits">
          <h2 id="limits">Limits at a glance</h2>
          <table>
            <caption className="sr-only">Upload limits</caption>
            <tbody>
              <tr><th scope="row">Maximum file size</th><td>{FACTS.maxFileMb} MB</td></tr>
              <tr><th scope="row">Chunk size</th><td>{FACTS.chunkSizeMb} MB</td></tr>
              <tr><th scope="row">Parallel uploads</th><td>{FACTS.parallelFiles} files × {FACTS.parallelChunks} chunks</td></tr>
              <tr><th scope="row">Integrity check</th><td>{FACTS.hash} per chunk</td></tr>
              <tr><th scope="row">Resume window</th><td>{FACTS.resumeHours} hours</td></tr>
              <tr><th scope="row">Blocked</th><td>Native executables (PE, ELF, Mach-O)</td></tr>
            </tbody>
          </table>
        </section>

        <p className="cta">
          <Link href="/" className="cta-button">Take a shot</Link> <Link href="/faq">Read the FAQ</Link>
        </p>
      </article>
    </DocShell>
  );
}

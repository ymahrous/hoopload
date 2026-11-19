import Link from "next/link";
import { FACTS, HOW_TO_STEPS, SITE } from "@/lib/site";

/** Server-rendered, crawlable copy under the game: what it is, in answer-first form. */
export function HomeAbout() {
  return (
    <section className="about" aria-labelledby="about-title">
      <div className="about-inner">
        <h2 id="about-title">{SITE.tagline}</h2>
        <p className="lede">
          <strong>{SITE.name} is a free file uploader you play like basketball.</strong> Pull a file back, release, and sink it: the make starts an
          upload that is chunked, {FACTS.hash}-verified, deduplicated and resumable, up to {FACTS.maxFileMb} MB per file.
        </p>
        <ol className="mini-steps">
          {HOW_TO_STEPS.slice(0, 4).map((s) => (
            <li key={s.name}>
              <strong>{s.name}.</strong> {s.text}
            </li>
          ))}
        </ol>
        <p>
          <Link href="/how-it-works">How it works</Link> · <Link href="/faq">FAQ</Link>
        </p>
      </div>
    </section>
  );
}

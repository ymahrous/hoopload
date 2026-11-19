import Link from "next/link";
import { NAV, SITE } from "@/lib/site";
import { SiteFooter } from "./SiteFooter";

/** Shared layout for the server-rendered content pages. */
export function DocShell({ current, children }: { current: string; children: React.ReactNode }) {
  return (
    <>
      <header className="doc-header">
        <Link href="/" className="brand" aria-label={`${SITE.name} home`}>
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="#e8622c" />
            <rect x="9" y="6" width="14" height="10" rx="1.5" fill="none" stroke="#fff" strokeWidth="2" />
            <ellipse cx="16" cy="18" rx="8" ry="2" fill="none" stroke="#fff" strokeWidth="2" />
          </svg>
          {SITE.name}
        </Link>
        <nav aria-label="Primary">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={n.href === current ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="content" className="doc">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}

import Link from "next/link";
import { NAV, SITE } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav aria-label="Site">
        <Link href="/" className="brand">
          {SITE.name}
        </Link>
        <ul>
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href}>{n.label}</Link>
            </li>
          ))}
          <li>
            <a href="/llms.txt">llms.txt</a>
          </li>
        </ul>
      </nav>
      <p>{SITE.shortDescription}</p>
    </footer>
  );
}

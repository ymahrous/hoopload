import { render, screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import FaqPage from "@/app/faq/page";
import HowItWorks from "@/app/how-it-works/page";
import { HomeAbout } from "@/components/HomeAbout";
import { FAQS, HOW_TO_STEPS } from "@/lib/site";

const jsonLd = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('script[type="application/ld+json"]')).flatMap((s) => {
    const v = JSON.parse(s.textContent ?? "null");
    return Array.isArray(v) ? v : [v];
  });

describe("server-rendered content pages (SEO/AEO)", () => {
  it("FAQ: one h1, every question as a heading with its anchor, FAQPage JSON-LD in sync", () => {
    const { container } = render(<FaqPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    for (const f of FAQS) {
      const h = screen.getByRole("heading", { level: 2, name: f.q });
      expect(h.closest("section")).toHaveAttribute("id", f.id);
      expect(within(h.closest("section")!).getByText(f.a)).toHaveClass("faq-a");
    }
    const types = jsonLd(container).map((x) => x["@type"]);
    expect(types).toEqual(["FAQPage", "BreadcrumbList"]);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
  });

  it("How it works: ordered steps with deep-link anchors, HowTo + TechArticle JSON-LD", () => {
    const { container } = render(<HowItWorks />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    HOW_TO_STEPS.forEach((s, i) => expect(screen.getByRole("heading", { level: 3, name: s.name }).closest("li")).toHaveAttribute("id", `step-${i + 1}`));
    expect(jsonLd(container).map((x) => x["@type"])).toEqual(["HowTo", "TechArticle", "BreadcrumbList"]);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "How it works" })).toHaveAttribute("aria-current", "page");
  });

  it("Home: crawlable answer-first summary below the game", () => {
    render(<HomeAbout />);
    const lede = screen.getByText(/is a free file uploader you play like basketball/);
    expect(lede.tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "FAQ" })).toHaveAttribute("href", "/faq");
  });
});

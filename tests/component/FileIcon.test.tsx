import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileIcon } from "@/components/FileIcon";

describe("<FileIcon>", () => {
  it.each([
    ["deck.pdf", "PDF", "#e5383b"],
    ["photo.png", "PNG", "#16a34a"],
    ["README", "FILE", "#64748b"],
  ])("%s shows %s in the kind colour", (name, label, color) => {
    const { container } = render(<FileIcon name={name} />);
    expect(container.querySelector("text")?.textContent).toBe(label);
    expect(container.querySelector(`rect[fill="${color}"]`)).not.toBeNull();
  });

  it("is decorative (hidden from assistive tech) and scales", () => {
    const { container } = render(<FileIcon name="a.zip" size={28} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "28");
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Locker } from "@/components/Locker";
import type { FileRecord } from "@/lib/shared/protocol";

const f = (id: string, name: string): FileRecord => ({ id, name, size: 2048, mime: "application/pdf", fingerprint: "ab", createdAt: Date.now() });

const props = (over = {}) => ({ open: true, onClose: vi.fn(), files: [] as FileRecord[], bytes: 0, connected: true, loaded: true, onDelete: vi.fn(), ...over });

describe("<Locker>", () => {
  it("shows an empty state", () => {
    render(<Locker {...props()} />);
    expect(screen.getByText("No files yet. Sink one.")).toBeInTheDocument();
    expect(screen.getByText("0 files · 0 B")).toBeInTheDocument();
  });

  it("lists files with download links and delete buttons", async () => {
    const p = props({ files: [f("file_1", "a.pdf"), f("file_2", "b.pdf")], bytes: 4096 });
    render(<Locker {...p} />);
    expect(screen.getByText("2 files · 4.0 KB")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "Download" });
    expect(links[0]).toHaveAttribute("href", "/api/files/file_1");
    expect(links[0]).toHaveAttribute("download", "a.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Delete b.pdf" }));
    expect(p.onDelete).toHaveBeenCalledWith("file_2");
  });

  it("closes on Escape and on the close button", async () => {
    const p = props();
    render(<Locker {...p} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close locker" }));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it("is inert (unfocusable, hidden from assistive tech) when closed", () => {
    const { container, rerender } = render(<Locker {...props({ open: false, files: [f("file_1", "a.pdf")] })} />);
    expect(container.querySelector("aside")).toHaveAttribute("inert");
    rerender(<Locker {...props({ open: true, files: [f("file_1", "a.pdf")] })} />);
    expect(container.querySelector("aside")).not.toHaveAttribute("inert");
  });

  it("shows live connection status", () => {
    const { rerender } = render(<Locker {...props()} />);
    expect(screen.getByTitle("Live updates connected")).toHaveTextContent("Live");
    rerender(<Locker {...props({ connected: false })} />);
    expect(screen.getByTitle("Reconnecting…")).toHaveTextContent("Offline");
  });
});

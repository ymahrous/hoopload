import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadItem } from "@/lib/client/uploadManager";

const manager = vi.hoisted(() => ({ cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn(), clearFinished: vi.fn() }));
vi.mock("@/lib/client/uploadManager", () => ({ getUploadManager: () => manager }));

import { UploadTray } from "@/components/UploadTray";

const item = (over: Partial<UploadItem>): UploadItem => ({
  id: Math.random().toString(36),
  name: "final fileeeee.pdf",
  size: 2_900_000,
  mime: "application/pdf",
  status: "uploading",
  progress: 0.42,
  bytesPerSec: 1_500_000,
  deduped: false,
  resumed: false,
  addedAt: 0,
  ...over,
});

describe("<UploadTray>", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders nothing when empty", () => {
    const { container } = render(<UploadTray items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows progress, speed and an accessible progressbar while uploading", async () => {
    render(<UploadTray items={[item({ id: "u1", resumed: true })]} />);
    expect(screen.getByText("final fileeeee.pdf")).toBeInTheDocument();
    expect(screen.getByText("2.8 MB")).toBeInTheDocument();
    expect(screen.getByText("42% · 1.4 MB/s · resumed")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /final fileeeee.pdf/ })).toHaveAttribute("aria-valuenow", "42");
    await userEvent.click(screen.getByRole("button", { name: "Cancel final fileeeee.pdf" }));
    expect(manager.cancel).toHaveBeenCalledWith("u1");
  });

  it("shows a check when done and calls out deduped uploads", () => {
    render(<UploadTray items={[item({ status: "done", progress: 1, deduped: true })]} />);
    expect(screen.getByLabelText("Uploaded")).toBeInTheDocument();
    expect(screen.getByText("Uploaded · already stored")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("offers retry and dismiss on failure, with the error message", async () => {
    render(<UploadTray items={[item({ id: "bad", status: "error", error: "Executable files are not accepted." })]} />);
    expect(screen.getByText("Executable files are not accepted.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss final fileeeee.pdf" }));
    expect(manager.retry).toHaveBeenCalledWith("bad");
    expect(manager.dismiss).toHaveBeenCalledWith("bad");
  });

  it("lets you clear finished uploads once there are several", async () => {
    render(<UploadTray items={[item({ status: "done" }), item({ status: "canceled" }), item({})]} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear 2" }));
    expect(manager.clearFinished).toHaveBeenCalled();
  });

  it("announces changes politely to screen readers", () => {
    render(<UploadTray items={[item({ status: "hashing", progress: 0.5 })]} />);
    expect(screen.getByRole("region", { name: "Uploads" })).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Fingerprinting 50%")).toBeInTheDocument();
  });
});

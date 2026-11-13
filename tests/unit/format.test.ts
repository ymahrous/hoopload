import { describe, expect, it } from "vitest";
import { badgeLabel, extOf, fileKind, formatBytes, timeAgo } from "@/lib/shared/format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [10 * 1024, "10 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [3 * 1024 ** 4, "3.0 TB"],
    [-1, "—"],
    [Number.NaN, "—"],
  ])("%s -> %s", (n, out) => expect(formatBytes(n)).toBe(out));
});

describe("timeAgo", () => {
  const now = 1_000_000_000;
  it.each([
    [now - 2_000, "just now"],
    [now - 30_000, "30s ago"],
    [now - 5 * 60_000, "5m ago"],
    [now - 3 * 3_600_000, "3h ago"],
    [now - 2 * 86_400_000, "2d ago"],
    [now + 50_000, "just now"],
  ])("%s", (ts, out) => expect(timeAgo(ts, now)).toBe(out));
});

describe("file kinds and badges", () => {
  it.each([
    ["report.PDF", "", "pdf", "PDF"],
    ["photo.jpeg", "", "image", "JPEG"],
    ["clip", "video/mp4", "video", "VID"],
    ["song.flac", "", "audio", "FLAC"],
    ["backup.tar", "", "archive", "TAR"],
    ["budget.xlsx", "", "sheet", "XLSX"],
    ["notes.md", "", "doc", "MD"],
    ["main.rs", "", "code", "RS"],
    ["README", "", "other", "FILE"],
    ["archive.verylongext", "", "other", "FILE"],
    [".bashrc", "", "other", "FILE"],
  ])("%s (%s) -> %s / %s", (name, mime, kind, badge) => {
    expect(fileKind(name, mime)).toBe(kind);
    expect(badgeLabel(name, mime)).toBe(badge);
  });

  it("extOf ignores leading dots", () => {
    expect(extOf(".env")).toBe("");
    expect(extOf("a.b.C")).toBe("c");
  });
});

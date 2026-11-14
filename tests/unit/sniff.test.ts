import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sniff } from "@/lib/server/sniff";

const b = (...bytes: number[]) => Buffer.from(bytes);
const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(32)]);

describe("sniff", () => {
  it.each([
    ["pdf", Buffer.from("%PDF-1.7"), "application/pdf"],
    ["png", b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a), "image/png"],
    ["jpeg", b(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"],
    ["gif", Buffer.from("GIF89a"), "image/gif"],
    ["webp", Buffer.concat([Buffer.from("RIFF"), b(0, 0, 0, 0), Buffer.from("WEBP")]), "image/webp"],
    ["mp4", Buffer.concat([b(0, 0, 0, 0x18), Buffer.from("ftypisom")]), "video/mp4"],
    ["mov", Buffer.concat([b(0, 0, 0, 0x14), Buffer.from("ftypqt  ")]), "video/quicktime"],
    ["webm", b(0x1a, 0x45, 0xdf, 0xa3), "video/webm"],
    ["mp3", Buffer.from("ID3"), "audio/mpeg"],
    ["ogg", Buffer.from("OggS"), "audio/ogg"],
    ["gzip", b(0x1f, 0x8b, 0x08), "application/gzip"],
    ["zip", b(0x50, 0x4b, 0x03, 0x04), "application/zip"],
  ])("detects %s", (_n, head, mime) => {
    expect(sniff(pad(head), "")).toEqual({ mime, blocked: false });
  });

  it("keeps OOXML claims for zip containers", () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(sniff(pad(b(0x50, 0x4b, 0x03, 0x04)), docx).mime).toBe(docx);
  });

  it.each([
    ["PE", b(0x4d, 0x5a, 0x90)],
    ["ELF", b(0x7f, 0x45, 0x4c, 0x46)],
    ["Mach-O 64", b(0xcf, 0xfa, 0xed, 0xfe)],
    ["Mach-O BE", b(0xfe, 0xed, 0xfa, 0xce)],
  ])("blocks %s executables even when they claim to be PDFs", (_n, head) => {
    expect(sniff(pad(head), "application/pdf").blocked).toBe(true);
  });

  it("never trusts active-content claims", () => {
    for (const claim of ["text/html", "application/javascript", "image/svg+xml", "application/xhtml+xml"]) {
      expect(sniff(Buffer.from("<script>alert(1)</script>"), claim).mime).toBe("text/plain");
    }
  });

  it("falls back to text/plain or octet-stream", () => {
    expect(sniff(Buffer.from("hello, world\nline two"), "").mime).toBe("text/plain");
    expect(sniff(b(0, 1, 2, 3, 4, 5, 6, 7), "").mime).toBe("application/octet-stream");
    expect(sniff(Buffer.alloc(0), "").mime).toBe("application/octet-stream");
    expect(sniff(Buffer.from("a,b\n1,2"), "text/csv").mime).toBe("text/csv");
  });

  it("property: total on arbitrary input, and the result is always a safe MIME", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.string({ maxLength: 60 }), (bytes, claim) => {
        const r = sniff(Buffer.from(bytes), claim);
        expect(r.mime).toMatch(/^[\w.+-]+\/[\w.+-]+$/);
        expect(r.mime).not.toMatch(/html|javascript/);
      }),
      { numRuns: 500 },
    );
  });
});

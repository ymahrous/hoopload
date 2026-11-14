import "server-only";

/**
 * Detect the real content type from magic bytes rather than trusting the
 * client-supplied MIME type. Native executables are rejected outright.
 */
export interface SniffResult {
  mime: string;
  blocked: boolean;
}

const startsWith = (b: Buffer, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

export function sniff(head: Buffer, claimed: string): SniffResult {
  // Executables: Windows PE, ELF, Mach-O (32/64, both endians, fat).
  if (startsWith(head, [0x4d, 0x5a])) return { mime: "application/x-msdownload", blocked: true };
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return { mime: "application/x-elf", blocked: true };
  for (const sig of [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe]]) {
    if (startsWith(head, sig)) return { mime: "application/x-mach-binary", blocked: true };
  }

  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return ok("application/pdf");
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return ok("image/png");
  if (startsWith(head, [0xff, 0xd8, 0xff])) return ok("image/jpeg");
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return ok("image/gif");
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return ok("image/webp");
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand.startsWith("qt")) return ok("video/quicktime");
    if (brand.startsWith("M4A")) return ok("audio/mp4");
    if (brand.startsWith("avif")) return ok("image/avif");
    if (brand.startsWith("heic")) return ok("image/heic");
    return ok("video/mp4");
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return ok("video/webm");
  if (startsWith(head, [0x49, 0x44, 0x33]) || startsWith(head, [0xff, 0xfb])) return ok("audio/mpeg");
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) return ok("audio/ogg");
  if (startsWith(head, [0x1f, 0x8b])) return ok("application/gzip");
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    // OOXML (docx/xlsx/pptx), epub, jar... are zip containers; keep a plausible claim.
    return ok(/officedocument|epub|zip/.test(claimed) ? claimed : "application/zip");
  }

  // Fall back to the claimed type, but never let an upload claim to be active content.
  const safeClaim = /^[\w.+-]+\/[\w.+-]+$/.test(claimed) && !/html|javascript|xml/.test(claimed) ? claimed : "";
  if (safeClaim) return ok(safeClaim);
  return ok(looksLikeText(head) ? "text/plain" : "application/octet-stream");
}

function ok(mime: string): SniffResult {
  return { mime, blocked: false };
}

function looksLikeText(b: Buffer): boolean {
  if (b.length === 0) return false;
  let printable = 0;
  for (const byte of b) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 0xc2) printable++;
  return printable / b.length > 0.95;
}

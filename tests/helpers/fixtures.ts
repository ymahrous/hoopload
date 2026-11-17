import { createHash, randomBytes } from "node:crypto";
import { CHUNK_SIZE, fingerprintInput, totalChunksFor, type InitUploadRequest } from "@/lib/shared/protocol";

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** What the browser's hash worker would send for these bytes. */
export function planUpload(bytes: Buffer, name = "file.pdf", type = "application/pdf"): InitUploadRequest {
  const chunkHashes = Array.from({ length: totalChunksFor(bytes.length) }, (_, i) => sha256(bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)));
  return { name, size: bytes.length, type, chunkSize: CHUNK_SIZE, chunkHashes, fingerprint: sha256(fingerprintInput(bytes.length, chunkHashes)) };
}

export const chunkOf = (bytes: Buffer, i: number) => bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

export function streamOf(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      // Several pieces, like a real network body.
      const step = 64 * 1024;
      for (let o = 0; o < buf.length; o += step) c.enqueue(buf.subarray(o, o + step));
      c.close();
    },
  });
}

export const pdfBytes = (size: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(Math.max(0, size - 9))]);
export const exeBytes = (size = 2048) => Buffer.concat([Buffer.from([0x4d, 0x5a]), randomBytes(size - 2)]);

export class FakeClock {
  constructor(public t = Date.UTC(2026, 10, 25, 12)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

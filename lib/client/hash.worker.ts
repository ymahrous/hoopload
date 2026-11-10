/**
 * Hashes files off the main thread so the game loop never stutters.
 * Emits per-chunk SHA-256 digests plus the file fingerprint.
 */
import { fingerprintInput, totalChunksFor } from "@/lib/shared/protocol";

type Req = { id: string; file: File; chunkSize: number };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(message: unknown): void;
};

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { id, file, chunkSize } = e.data;
  try {
    const total = totalChunksFor(file.size, chunkSize);
    const hashes: string[] = [];
    for (let i = 0; i < total; i++) {
      const buf = await file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize)).arrayBuffer();
      hashes.push(hex(await crypto.subtle.digest("SHA-256", buf)));
      ctx.postMessage({ id, type: "progress", value: (i + 1) / total });
    }
    const fp = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintInput(file.size, hashes))));
    ctx.postMessage({ id, type: "done", hashes, fingerprint: fp });
  } catch (err) {
    ctx.postMessage({ id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

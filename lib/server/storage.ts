import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { HttpError, UPLOAD_DIR, singleton } from "./core";

/**
 * Blob storage abstraction. `LocalDiskStorage` ships by default; an S3/R2/GCS
 * driver implements the same five operations (chunks map to multipart parts,
 * `assemble` to CompleteMultipartUpload).
 */
export interface StorageDriver {
  writeChunk(sessionId: string, index: number, body: ReadableStream<Uint8Array>, opts: { maxBytes: number; timeoutMs?: number }): Promise<{ bytes: number; sha256: string }>;
  discardChunk(sessionId: string, index: number): Promise<void>;
  /** Chunk indexes already stored — the source of truth for resume and completeness. */
  listChunks(sessionId: string): Promise<number[]>;
  hasChunk(sessionId: string, index: number): Promise<boolean>;
  assemble(sessionId: string, totalChunks: number, objectKey: string): Promise<{ head: Buffer; size: number }>;
  open(objectKey: string, range?: { start: number; end: number }): Promise<{ stream: ReadableStream<Uint8Array>; size: number }>;
  deleteObject(objectKey: string): Promise<void>;
  deleteChunks(sessionId: string): Promise<void>;
  /** Bytes free on the backing volume (Infinity when unknown/unbounded). */
  freeBytes(): Promise<number>;
}

/** A chunk body must finish streaming within this window (slow-body / slowloris defence). */
export const CHUNK_TIMEOUT_MS = 60_000;

const SAFE_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const SAFE_KEY = /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/;

export class LocalDiskStorage implements StorageDriver {
  constructor(private root: string) {}

  private chunkDir(sessionId: string) {
    if (!SAFE_ID.test(sessionId)) throw new HttpError(400, "bad_id", "Invalid upload id.");
    return path.join(this.root, "chunks", sessionId);
  }

  private objectPath(key: string) {
    if (!SAFE_KEY.test(key)) throw new Error(`unsafe object key: ${key}`);
    return path.join(this.root, key);
  }

  async writeChunk(sessionId: string, index: number, body: ReadableStream<Uint8Array>, { maxBytes, timeoutMs = CHUNK_TIMEOUT_MS }: { maxBytes: number; timeoutMs?: number }) {
    const dir = this.chunkDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const final = path.join(dir, `${index}.part`);
    const tmp = `${final}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new HttpError(413, "chunk_too_large", "Chunk exceeds its declared size."));
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await pipeline(Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>), meter, createWriteStream(tmp, { mode: 0o600 }), { signal }).catch((err) => {
        if (signal.aborted) throw new HttpError(408, "chunk_timeout", "Chunk upload took too long.");
        throw err;
      });
      // Atomic publish: a reader never observes a half-written chunk.
      await fs.rename(tmp, final);
      return { bytes, sha256: hash.digest("hex") };
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async listChunks(sessionId: string) {
    const names = await fs.readdir(this.chunkDir(sessionId)).catch(() => [] as string[]);
    return names
      .map((n) => /^(\d+)\.part$/.exec(n)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  async hasChunk(sessionId: string, index: number) {
    return fs
      .stat(path.join(this.chunkDir(sessionId), `${index}.part`))
      .then(() => true)
      .catch(() => false);
  }

  async discardChunk(sessionId: string, index: number) {
    await fs.rm(path.join(this.chunkDir(sessionId), `${index}.part`), { force: true });
  }

  async assemble(sessionId: string, totalChunks: number, objectKey: string) {
    const dir = this.chunkDir(sessionId);
    const dest = this.objectPath(objectKey);
    await fs.mkdir(path.dirname(dest), { recursive: true });

    // Always assemble fully, even when these bytes are already stored, so the
    // response time cannot reveal whether ANOTHER owner holds the same file.
    const tmp = `${dest}.${sessionId}.tmp`;
    const out = createWriteStream(tmp, { mode: 0o600 });
    let head = Buffer.alloc(0);
    let size = 0;
    try {
      for (let i = 0; i < totalChunks; i++) {
        for await (const buf of createReadStream(path.join(dir, `${i}.part`), { highWaterMark: 1 << 20 })) {
          const b = buf as Buffer;
          if (head.length < 64) head = Buffer.concat([head, b.subarray(0, 64 - head.length)]);
          size += b.length;
          if (!out.write(b)) await once(out, "drain");
        }
      }
      out.end();
      await once(out, "finish");
      if (await fs.stat(dest).catch(() => null)) await fs.rm(tmp, { force: true });
      else await fs.rename(tmp, dest);
      return { head, size };
    } catch (err) {
      out.destroy();
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async open(objectKey: string, range?: { start: number; end: number }) {
    const p = this.objectPath(objectKey);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) throw new HttpError(404, "not_found", "Object missing.");
    const node = createReadStream(p, range ? { start: range.start, end: range.end } : undefined);
    return { stream: Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>, size: stat.size };
  }

  async deleteObject(objectKey: string) {
    await fs.rm(this.objectPath(objectKey), { force: true });
  }

  async deleteChunks(sessionId: string) {
    await fs.rm(this.chunkDir(sessionId), { recursive: true, force: true });
  }

  async freeBytes() {
    await fs.mkdir(this.root, { recursive: true });
    const st = await fs.statfs(this.root);
    return st.bavail * st.bsize;
  }
}


export const objectKeyFor = (fingerprint: string) => `objects/${fingerprint.slice(0, 2)}/${fingerprint}`;

export function getStorage(): StorageDriver {
  return singleton("storage", () => new LocalDiskStorage(UPLOAD_DIR));
}

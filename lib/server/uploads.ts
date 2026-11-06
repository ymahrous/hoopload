import { createHash, randomBytes } from "node:crypto";
import {
  CHUNK_SIZE,
  MAX_CHUNKS,
  MAX_FILE_SIZE,
  QUOTAS,
  SESSION_TTL_MS,
  expectedChunkBytes,
  fingerprintInput,
  totalChunksFor,
  type ChunkResponse,
  type FeedEvent,
  type FileRecord,
  type FilesResponse,
  type InitUploadRequest,
  type InitUploadResponse,
} from "@/lib/shared/protocol";
import { HttpError, singleton } from "./core";
import { publish as busPublish } from "./events";
import { TtlLru } from "./lru";
import { sanitizeName } from "./names";
import { CONCURRENCY, acquire } from "./security/rateLimit";
import { sniff } from "./sniff";
import { getStorage, objectKeyFor, type StorageDriver } from "./storage";
import { getStore } from "./store";
import type { MetadataStore, UploadSession } from "./store/types";

const HEX64 = /^[a-f0-9]{64}$/;
const ID_RE = /^(up|file)_[A-Za-z0-9_-]{16}$/;
const INIT_KEYS = new Set(["name", "size", "type", "chunkSize", "chunkHashes", "fingerprint"]);
const MIME_RE = /^[\w.+-]{1,60}\/[\w.+-]{1,60}$/;
const COMPLETED_KEEP_MS = 60 * 60 * 1000;
const GC_INTERVAL_MS = 15 * 60 * 1000;
const LIST_CACHE_MS = 10_000;
/** Never let uploads fill the disk: keep this much free for the OS, logs and the database file. */
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES ?? 1024 ** 3);

export interface UploadServiceDeps {
  store: MetadataStore;
  storage: StorageDriver;
  publish: (owner: string, e: FeedEvent) => void;
  now?: () => number;
  newId?: (prefix: string) => string;
  quotas?: typeof QUOTAS;
  minFreeBytes?: number;
  chunkTimeoutMs?: number;
}

export type UploadService = ReturnType<typeof createUploadService>;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const defaultId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;

/** Strict server-side validation: exact shape, types, bounds; unknown fields rejected. */
export function validateInit(body: Partial<InitUploadRequest>): InitUploadRequest {
  for (const k of Object.keys(body)) if (!INIT_KEYS.has(k)) throw new HttpError(400, "unknown_field", `Unknown field: ${k.slice(0, 40)}`);
  const name = sanitizeName(body.name);
  const size = body.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) throw new HttpError(400, "bad_size", "Size must be a positive integer.");
  if (size > MAX_FILE_SIZE) throw new HttpError(413, "file_too_large", `Files are limited to ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
  if (body.chunkSize !== CHUNK_SIZE) throw new HttpError(400, "bad_chunk_size", `chunkSize must be ${CHUNK_SIZE}.`);
  const hashes = body.chunkHashes;
  const total = totalChunksFor(size);
  if (!Array.isArray(hashes) || hashes.length !== total || total > MAX_CHUNKS || !hashes.every((h) => typeof h === "string" && HEX64.test(h))) {
    throw new HttpError(400, "bad_hashes", "chunkHashes must list one lowercase hex SHA-256 per chunk.");
  }
  if (typeof body.fingerprint !== "string" || body.fingerprint !== sha256(fingerprintInput(size, hashes))) {
    throw new HttpError(400, "bad_fingerprint", "Fingerprint does not match chunk hashes.");
  }
  if (body.type !== undefined && typeof body.type !== "string") throw new HttpError(400, "bad_type", "type must be a string.");
  const type = body.type && MIME_RE.test(body.type) ? body.type.toLowerCase() : "";
  return { name, size, type, chunkSize: CHUNK_SIZE, chunkHashes: hashes, fingerprint: body.fingerprint };
}

/** Opaque ids are checked before any lookup or path use. Malformed ids look exactly like missing ones. */
function assertId(id: string, kind: "up" | "file"): void {
  if (!ID_RE.test(id) || !id.startsWith(`${kind}_`)) throw new HttpError(404, kind === "up" ? "upload_not_found" : "not_found", "Not found.");
}

/**
 * Upload orchestration over three injected ports. SECURITY: every operation
 * takes the caller's `owner`, and a resource belonging to anyone else is
 * indistinguishable from one that does not exist (404, never 403).
 *
 * Database budget per upload (Postgres): init 2, chunks 0, complete 2.
 */
export function createUploadService(deps: UploadServiceDeps) {
  const { store, storage } = deps;
  const publish = deps.publish;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? defaultId;
  const quotas = deps.quotas ?? QUOTAS;
  const minFree = deps.minFreeBytes ?? MIN_FREE_BYTES;
  const sessions = new TtlLru<string, UploadSession>(1000, 10 * 60 * 1000, now);
  const listCache = new TtlLru<string, FilesResponse>(500, LIST_CACHE_MS, now);
  let lastGc = 0;
  let disk: { at: number; free: number } | null = null;

  // Writes are rare next to reads; dropping the whole (small) micro-cache is simplest and always correct.
  const invalidateList = (_owner: string) => listCache.clear();

  async function gc() {
    const t = now();
    if (t - lastGc < GC_INTERVAL_MS) return;
    lastGc = t;
    const expired = await store.deleteExpiredSessions(t);
    for (const id of expired) sessions.delete(id);
    await Promise.all(expired.map((id) => storage.deleteChunks(id)));
  }

  async function assertDiskRoom(bytes: number) {
    const t = now();
    if (!disk || t - disk.at > 10_000) disk = { at: t, free: await storage.freeBytes() };
    if (disk.free - bytes < minFree) {
      console.warn("[security] upload refused: low disk space");
      throw new HttpError(507, "insufficient_storage", "The server is out of space for uploads. Try again later.");
    }
  }

  /** The caller's own session, or 404. Served from cache on the chunk hot path. */
  async function ownSession(owner: string, id: string): Promise<UploadSession> {
    assertId(id, "up");
    let s = sessions.get(id);
    if (!s || s.expiresAt <= now()) {
      s = (await store.getSession(id, now())) ?? undefined;
      if (s) sessions.set(id, s);
    }
    if (!s || s.ownerId !== owner) throw new HttpError(404, "upload_not_found", "Upload session not found or expired.");
    return s;
  }

  return {
    async init(owner: string, raw: Partial<InitUploadRequest>): Promise<InitUploadResponse> {
      const req = validateInit(raw);
      void gc().catch((e) => console.error("[gc]", e));
      const t = now();
      const found = await store.lookupForInit(owner, req.fingerprint, req.name, t);

      // Dedupe ONLY within the owner's own files: answering "complete" for
      // another owner's bytes would reveal that someone holds this file.
      if (found.file) {
        if (found.exact) return { status: "complete", file: found.file, deduped: true };
        if (found.usage.files >= quotas.files) throw new HttpError(413, "quota_files", `You can keep up to ${quotas.files} files. Delete some first.`);
        const alias = await store.upsertFile(owner, { ...found.file, id: newId("file"), name: req.name, createdAt: t });
        invalidateList(owner);
        publish(owner, { type: "file.created", file: alias });
        return { status: "complete", file: alias, deduped: true };
      }

      if (found.usage.files >= quotas.files) throw new HttpError(413, "quota_files", `You can keep up to ${quotas.files} files. Delete some first.`);
      if (found.usage.bytes + req.size > quotas.storageBytes) {
        throw new HttpError(413, "quota_storage", `This would exceed your ${quotas.storageBytes / 1024 ** 3} GiB storage quota.`);
      }

      if (found.openSessionId) {
        const id = found.openSessionId;
        await store.touchSession(id, owner, req.name, t + SESSION_TTL_MS);
        sessions.delete(id);
        return { status: "open", uploadId: id, received: await storage.listChunks(id), totalChunks: req.chunkHashes.length };
      }

      if (found.usage.openSessions >= quotas.openUploads) {
        throw new HttpError(429, "too_many_uploads", `Finish or cancel your other uploads first (max ${quotas.openUploads}).`, { "Retry-After": "30" });
      }
      await assertDiskRoom(req.size);

      const session: UploadSession = {
        id: newId("up"),
        ownerId: owner,
        name: req.name,
        size: req.size,
        claimedType: req.type,
        fingerprint: req.fingerprint,
        chunkHashes: req.chunkHashes,
        status: "open",
        fileId: null,
        createdAt: t,
        expiresAt: t + SESSION_TTL_MS,
      };
      await store.createSession(session);
      sessions.set(session.id, session);
      return { status: "open", uploadId: session.id, received: [], totalChunks: session.chunkHashes.length };
    },

    /** Idempotent. Zero database queries on the hot path. */
    async putChunk(owner: string, id: string, index: number, body: ReadableStream<Uint8Array> | null, contentLength: number | null): Promise<ChunkResponse> {
      const cancel = () => body?.cancel().catch(() => {});
      let s: UploadSession;
      try {
        s = await ownSession(owner, id);
      } catch (e) {
        await cancel();
        throw e;
      }
      const total = s.chunkHashes.length;
      if (!Number.isInteger(index) || index < 0 || index >= total) {
        await cancel();
        throw new HttpError(400, "bad_index", "Chunk index out of range.");
      }
      if (s.status !== "open") {
        await cancel();
        throw new HttpError(409, "upload_closed", "Upload is no longer accepting chunks.");
      }
      const expected = expectedChunkBytes(s.size, index, CHUNK_SIZE);
      if (contentLength === null || contentLength !== expected) {
        await cancel();
        throw new HttpError(contentLength === null ? 411 : 400, "bad_length", `Chunk ${index} must be sent with Content-Length: ${expected}.`);
      }
      if (await storage.hasChunk(id, index)) {
        await cancel();
        return { index, received: (await storage.listChunks(id)).length, totalChunks: total, duplicate: true };
      }
      if (!body) throw new HttpError(400, "empty_body", "Chunk body is required.");

      const release = acquire([[`chunkw|${owner}`, CONCURRENCY.chunkWritesPerOwner]]);
      try {
        const { bytes, sha256: digest } = await storage.writeChunk(id, index, body, { maxBytes: expected, timeoutMs: deps.chunkTimeoutMs });
        if (bytes !== expected || digest !== s.chunkHashes[index]) {
          await storage.discardChunk(id, index);
          throw new HttpError(422, "chunk_corrupt", `Chunk ${index} failed integrity check.`);
        }
      } finally {
        release();
      }
      return { index, received: (await storage.listChunks(id)).length, totalChunks: total, duplicate: false };
    },

    async complete(owner: string, id: string): Promise<FileRecord> {
      const s = await ownSession(owner, id);
      if (s.status === "open") {
        const missing = s.chunkHashes.length - (await storage.listChunks(id)).length;
        if (missing > 0) throw new HttpError(409, "incomplete", `${missing} chunk(s) still missing.`);
      }

      const claim = await store.claimSession(id, owner, now());
      if (claim.outcome === "complete") return claim.file;
      if (claim.outcome === "assembling") throw new HttpError(409, "assembling", "Already finalising, retry shortly.", { "Retry-After": "1" });
      if (claim.outcome === "missing") throw new HttpError(404, "upload_not_found", "Upload session not found or expired.");

      const session = claim.session;
      sessions.set(id, session);
      const key = objectKeyFor(session.fingerprint);
      try {
        if ((await storage.listChunks(id)).length !== session.chunkHashes.length) throw new HttpError(409, "incomplete", "Chunks missing.");
        const { head, size } = await storage.assemble(id, session.chunkHashes.length, key);
        if (size !== session.size) throw new HttpError(500, "size_mismatch", "Assembled size mismatch.");

        const kind = sniff(head, session.claimedType);
        if (kind.blocked) {
          console.warn("[security] blocked executable upload");
          if (!(await store.isReferenced(session.fingerprint))) await storage.deleteObject(key);
          await store.deleteSession(id, owner);
          sessions.delete(id);
          await storage.deleteChunks(id);
          throw new HttpError(415, "blocked_type", "Executable files are not accepted.");
        }

        const t = now();
        const file = await store.finalizeSession(
          id,
          owner,
          { id: newId("file"), name: session.name, size: session.size, mime: kind.mime, fingerprint: session.fingerprint, createdAt: t },
          t + COMPLETED_KEEP_MS,
        );
        sessions.delete(id);
        await storage.deleteChunks(id);
        invalidateList(owner);
        publish(owner, { type: "file.created", file });
        return file;
      } catch (err) {
        if (!(err instanceof HttpError && err.code === "blocked_type")) {
          await store.reopenSession(id);
          sessions.delete(id);
        }
        throw err;
      }
    },

    async abort(owner: string, id: string): Promise<void> {
      await ownSession(owner, id);
      sessions.delete(id);
      if (await store.deleteSession(id, owner)) await storage.deleteChunks(id);
    },

    async status(owner: string, id: string) {
      const s = await ownSession(owner, id);
      return { uploadId: s.id, status: s.status, received: await storage.listChunks(id), totalChunks: s.chunkHashes.length, expiresAt: s.expiresAt };
    },

    async list(owner: string | null, opts: { limit?: number; cursor?: string | null } = {}): Promise<FilesResponse> {
      if (!owner) return { files: [], totals: { count: 0, bytes: 0 }, nextCursor: null };
      const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 100)));
      const key = `${owner}|${limit}|${opts.cursor ?? ""}`;
      const hit = listCache.get(key);
      if (hit) return hit;
      const page = await store.listFiles(owner, { limit, cursor: opts.cursor ?? null });
      const value: FilesResponse = { files: page.files, totals: page.totals, nextCursor: page.nextCursor };
      listCache.set(key, value);
      return value;
    },

    async getFile(owner: string, id: string): Promise<FileRecord> {
      assertId(id, "file");
      const f = await store.getFile(owner, id);
      if (!f) throw new HttpError(404, "not_found", "File not found.");
      return f;
    },

    async remove(owner: string, id: string): Promise<void> {
      assertId(id, "file");
      const res = await store.deleteFile(owner, id);
      if (!res) throw new HttpError(404, "not_found", "File not found.");
      if (res.orphaned) await storage.deleteObject(objectKeyFor(res.fingerprint));
      invalidateList(owner);
      publish(owner, { type: "file.deleted", id });
    },
  };
}

export function uploads(): UploadService {
  return singleton("upload-service", () => createUploadService({ store: getStore(), storage: getStorage(), publish: busPublish }));
}

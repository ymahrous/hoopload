/**
 * Wire protocol shared by the browser and the route handlers.
 * Keeping it in one module means the client and server cannot drift apart.
 */

/** Server-dictated chunk size. 4 MiB keeps each request small enough for any proxy. */
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_FILE_SIZE = 512 * 1024 * 1024;
export const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE);
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-owner quotas (anti-abuse). Public: shown in the FAQ and llms.txt. */
export const QUOTAS = {
  storageBytes: 2 * 1024 * 1024 * 1024,
  files: 500,
  openUploads: 10,
};

export interface FileRecord {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Content fingerprint (see `fingerprintInput`). Identical bytes => identical fingerprint. */
  fingerprint: string;
  createdAt: number;
}

export interface InitUploadRequest {
  name: string;
  size: number;
  type: string;
  chunkSize: number;
  /** SHA-256 of every chunk, in order (hex). The server verifies each chunk against these. */
  chunkHashes: string[];
  fingerprint: string;
}

export type InitUploadResponse =
  | { status: "complete"; file: FileRecord; deduped: true }
  | { status: "open"; uploadId: string; received: number[]; totalChunks: number };

export interface ChunkResponse {
  index: number;
  received: number;
  totalChunks: number;
  duplicate: boolean;
}

export interface CompleteResponse {
  file: FileRecord;
}

export interface FilesResponse {
  files: FileRecord[];
  totals: { count: number; bytes: number };
  /** Opaque keyset cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export type FeedEvent =
  | { type: "file.created"; file: FileRecord }
  | { type: "file.deleted"; id: string }
  | { type: "hello"; at: number };

/**
 * The fingerprint is a two-level hash: SHA-256 over the file size plus the ordered
 * chunk hashes. It lets the server verify the whole file chunk by chunk, without
 * the browser needing to hold the full file in memory to compute a single digest.
 */
export function fingerprintInput(size: number, chunkHashes: string[]): string {
  return `${size}:${chunkHashes.join(",")}`;
}

export function totalChunksFor(size: number, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

export function expectedChunkBytes(size: number, index: number, chunkSize = CHUNK_SIZE): number {
  const total = totalChunksFor(size, chunkSize);
  return index === total - 1 ? size - chunkSize * (total - 1) : chunkSize;
}

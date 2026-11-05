import type { FileRecord } from "@/lib/shared/protocol";

/**
 * Metadata persistence boundary. Two implementations:
 *  - `JsonStore`     — zero-config local dev and tests (single process).
 *  - `PostgresStore` — Neon (or any Postgres); every method is ONE round trip.
 *
 * SECURITY: every read and write of a user's data takes the `owner` and
 * filters by it inside the query. There is no "get any file by id" method, so
 * an IDOR cannot be written by accident in the service layer.
 *
 * Time is always passed in (`now`, epoch ms) for determinism.
 * Chunk receipt lives in blob storage, not here (one fewer write per chunk).
 */

export type SessionStatus = "open" | "assembling" | "complete";

export interface UploadSession {
  id: string;
  ownerId: string;
  name: string;
  size: number;
  claimedType: string;
  fingerprint: string;
  chunkHashes: string[];
  status: SessionStatus;
  fileId: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface OwnerUsage {
  files: number;
  bytes: number;
  openSessions: number;
}

export interface InitLookup {
  /** The OWNER's stored file with the same bytes (prefers the same name). Never another owner's. */
  file: FileRecord | null;
  exact: boolean;
  /** The owner's open, unexpired session for the same bytes. */
  openSessionId: string | null;
  usage: OwnerUsage;
}

export type ClaimResult =
  | { outcome: "claimed"; session: UploadSession }
  | { outcome: "complete"; file: FileRecord }
  | { outcome: "assembling" }
  | { outcome: "missing" };

export interface FilePage {
  files: FileRecord[];
  totals: { count: number; bytes: number };
  nextCursor: string | null;
}

export interface MetadataStore {
  readonly kind: "json" | "postgres";
  lookupForInit(owner: string, fingerprint: string, name: string, now: number): Promise<InitLookup>;
  /** Insert, or return the owner's existing row for the same (fingerprint, name). */
  upsertFile(owner: string, file: FileRecord): Promise<FileRecord>;
  createSession(session: UploadSession): Promise<void>;
  touchSession(id: string, owner: string, name: string, expiresAt: number): Promise<void>;
  /** Unscoped by design: the service caches it and compares `ownerId` itself before any use. */
  getSession(id: string, now: number): Promise<UploadSession | null>;
  claimSession(id: string, owner: string, now: number): Promise<ClaimResult>;
  finalizeSession(id: string, owner: string, file: FileRecord, keepUntil: number): Promise<FileRecord>;
  reopenSession(id: string): Promise<void>;
  deleteSession(id: string, owner: string): Promise<boolean>;
  deleteExpiredSessions(now: number): Promise<string[]>;
  getFile(owner: string, id: string): Promise<FileRecord | null>;
  listFiles(owner: string, opts: { limit: number; cursor?: string | null }): Promise<FilePage>;
  /** `orphaned`: no record of ANY owner still references these bytes (storage is shared). */
  deleteFile(owner: string, id: string): Promise<{ fingerprint: string; orphaned: boolean } | null>;
  isReferenced(fingerprint: string): Promise<boolean>;
}

export const encodeCursor = (f: FileRecord) => `${f.createdAt}_${f.id}`;
export function decodeCursor(c: string | null | undefined): { createdAt: number; id: string } | null {
  if (!c) return null;
  const m = /^(\d{1,15})_([A-Za-z0-9_-]{1,64})$/.exec(c);
  return m ? { createdAt: Number(m[1]), id: m[2] } : null;
}

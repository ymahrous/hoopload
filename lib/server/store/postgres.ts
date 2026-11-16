import type { FileRecord } from "@/lib/shared/protocol";
import type { SqlExecutor } from "../db/executor";
import { decodeCursor, encodeCursor, type ClaimResult, type FilePage, type InitLookup, type MetadataStore, type UploadSession } from "./types";

/**
 * Postgres implementation tuned for Neon's free tier.
 * Budget: every method is ONE HTTP round trip (multi-statement work goes
 * through `batch`), except `claimSession`'s rare fallback path.
 * Security: every query on user data filters by `owner_id`. All values are
 * bound parameters — no string interpolation of input, ever.
 */

const ts = (p: number) => `to_timestamp($${p}::float8 / 1000.0)`;
const ms = (col: string) => `(extract(epoch FROM ${col}) * 1000)::float8`;

const fileCols = (t = "") => {
  const c = (col: string) => (t ? `${t}.${col}` : col);
  return `${c("id")} AS id, ${c("name")} AS name, ${c("size")}::float8 AS size, ${c("mime")} AS mime,
    encode(${c("fingerprint")}, 'hex') AS fingerprint, ${ms(c("created_at"))} AS created_at`;
};
const FILE_COLS = fileCols();
const SESSION_COLS = `id, owner_id, name, size::float8 AS size, claimed_type, encode(fingerprint, 'hex') AS fingerprint,
  encode(chunk_hashes, 'hex') AS chunk_hashes, status, file_id, ${ms("created_at")} AS created_at, ${ms("expires_at")} AS expires_at`;

type Row = Record<string, unknown>;

function toFile(r: Row): FileRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    size: Number(r.size),
    mime: String(r.mime),
    fingerprint: String(r.fingerprint),
    createdAt: Math.round(Number(r.created_at)),
  };
}

function toSession(r: Row): UploadSession {
  const hex = String(r.chunk_hashes);
  const chunkHashes: string[] = [];
  for (let i = 0; i < hex.length; i += 64) chunkHashes.push(hex.slice(i, i + 64));
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    name: String(r.name),
    size: Number(r.size),
    claimedType: String(r.claimed_type ?? ""),
    fingerprint: String(r.fingerprint),
    chunkHashes,
    status: r.status as UploadSession["status"],
    fileId: r.file_id ? String(r.file_id) : null,
    createdAt: Math.round(Number(r.created_at)),
    expiresAt: Math.round(Number(r.expires_at)),
  };
}

const UPSERT_FILE = `INSERT INTO files (id, owner_id, name, size, mime, fingerprint, created_at)
  VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), ${ts(7)})
  ON CONFLICT (owner_id, fingerprint, name) DO UPDATE SET name = EXCLUDED.name
  RETURNING ${FILE_COLS}`;
const upsertParams = (owner: string, f: FileRecord) => [f.id, owner, f.name, f.size, f.mime, f.fingerprint, f.createdAt];

export class PostgresStore implements MetadataStore {
  readonly kind = "postgres" as const;
  constructor(private db: SqlExecutor) {}

  async lookupForInit(owner: string, fingerprint: string, name: string, now: number): Promise<InitLookup> {
    const [files, sessions, usage] = await this.db.batch(
      [
        {
          text: `SELECT ${FILE_COLS}, (name = $3) AS exact FROM files
                 WHERE owner_id = $1 AND fingerprint = decode($2, 'hex')
                 ORDER BY (name = $3) DESC, created_at ASC LIMIT 1`,
          params: [owner, fingerprint, name],
        },
        {
          text: `SELECT id FROM upload_sessions
                 WHERE owner_id = $1 AND fingerprint = decode($2, 'hex') AND status = 'open' AND expires_at > ${ts(3)}
                 ORDER BY created_at DESC LIMIT 1`,
          params: [owner, fingerprint, now],
        },
        {
          text: `SELECT
                   (SELECT count(*) FROM files WHERE owner_id = $1)::float8 AS files,
                   (SELECT coalesce(sum(size), 0) FROM files WHERE owner_id = $1)::float8 AS bytes,
                   (SELECT count(*) FROM upload_sessions WHERE owner_id = $1 AND status <> 'complete' AND expires_at > ${ts(2)})::float8 AS open_sessions`,
          params: [owner, now],
        },
      ],
      { readOnly: true },
    );
    const f = files[0];
    const u = usage[0];
    return {
      file: f ? toFile(f) : null,
      exact: Boolean(f?.exact),
      openSessionId: sessions[0] ? String(sessions[0].id) : null,
      usage: { files: Number(u.files), bytes: Number(u.bytes), openSessions: Number(u.open_sessions) },
    };
  }

  async upsertFile(owner: string, file: FileRecord): Promise<FileRecord> {
    return toFile((await this.db.query(UPSERT_FILE, upsertParams(owner, file)))[0]);
  }

  async createSession(s: UploadSession): Promise<void> {
    await this.db.query(
      `INSERT INTO upload_sessions (id, owner_id, name, size, claimed_type, fingerprint, chunk_hashes, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), decode($7, 'hex'), 'open', ${ts(8)}, ${ts(9)})`,
      [s.id, s.ownerId, s.name, s.size, s.claimedType, s.fingerprint, s.chunkHashes.join(""), s.createdAt, s.expiresAt],
    );
  }

  async touchSession(id: string, owner: string, name: string, expiresAt: number): Promise<void> {
    await this.db.query(`UPDATE upload_sessions SET name = $3, expires_at = ${ts(4)} WHERE id = $1 AND owner_id = $2`, [id, owner, name, expiresAt]);
  }

  async getSession(id: string, now: number): Promise<UploadSession | null> {
    const rows = await this.db.query(`SELECT ${SESSION_COLS} FROM upload_sessions WHERE id = $1 AND expires_at > ${ts(2)}`, [id, now]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async claimSession(id: string, owner: string, now: number): Promise<ClaimResult> {
    const claimed = await this.db.query(
      `UPDATE upload_sessions SET status = 'assembling'
       WHERE id = $1 AND owner_id = $2 AND status = 'open' AND expires_at > ${ts(3)}
       RETURNING ${SESSION_COLS}`,
      [id, owner, now],
    );
    if (claimed[0]) return { outcome: "claimed", session: toSession(claimed[0]) };

    const rows = await this.db.query(
      `SELECT s.status, ${fileCols("f")}
       FROM upload_sessions s LEFT JOIN files f ON f.id = s.file_id AND f.owner_id = s.owner_id
       WHERE s.id = $1 AND s.owner_id = $2 AND s.expires_at > ${ts(3)}`,
      [id, owner, now],
    );
    const r = rows[0];
    if (!r) return { outcome: "missing" };
    if (r.status === "complete" && r.id) return { outcome: "complete", file: toFile(r) };
    if (r.status === "assembling") return { outcome: "assembling" };
    return { outcome: "missing" };
  }

  async finalizeSession(id: string, owner: string, file: FileRecord, keepUntil: number): Promise<FileRecord> {
    const [inserted] = await this.db.batch([
      { text: UPSERT_FILE, params: upsertParams(owner, file) },
      {
        text: `UPDATE upload_sessions
               SET status = 'complete', expires_at = ${ts(5)},
                   file_id = (SELECT id FROM files WHERE owner_id = $2 AND fingerprint = decode($3, 'hex') AND name = $4)
               WHERE id = $1 AND owner_id = $2`,
        params: [id, owner, file.fingerprint, file.name, keepUntil],
      },
    ]);
    return toFile(inserted[0]);
  }

  async reopenSession(id: string): Promise<void> {
    await this.db.query(`UPDATE upload_sessions SET status = 'open' WHERE id = $1 AND status = 'assembling'`, [id]);
  }

  async deleteSession(id: string, owner: string): Promise<boolean> {
    return (await this.db.query(`DELETE FROM upload_sessions WHERE id = $1 AND owner_id = $2 AND status <> 'complete' RETURNING id`, [id, owner])).length > 0;
  }

  async deleteExpiredSessions(now: number): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(`DELETE FROM upload_sessions WHERE expires_at <= ${ts(1)} RETURNING id`, [now]);
    return rows.map((r) => String(r.id));
  }

  async getFile(owner: string, id: string): Promise<FileRecord | null> {
    const rows = await this.db.query(`SELECT ${FILE_COLS} FROM files WHERE id = $1 AND owner_id = $2`, [id, owner]);
    return rows[0] ? toFile(rows[0]) : null;
  }

  async listFiles(owner: string, { limit, cursor }: { limit: number; cursor?: string | null }): Promise<FilePage> {
    const c = decodeCursor(cursor);
    const page = c
      ? {
          text: `SELECT ${FILE_COLS} FROM files WHERE owner_id = $1 AND (created_at, id) < (${ts(2)}, $3) ORDER BY created_at DESC, id DESC LIMIT $4`,
          params: [owner, c.createdAt, c.id, limit + 1],
        }
      : { text: `SELECT ${FILE_COLS} FROM files WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, params: [owner, limit + 1] };
    const [rows, totals] = await this.db.batch(
      [page, { text: `SELECT count(*)::float8 AS count, coalesce(sum(size), 0)::float8 AS bytes FROM files WHERE owner_id = $1`, params: [owner] }],
      { readOnly: true },
    );
    const files = rows.slice(0, limit).map(toFile);
    return {
      files,
      totals: { count: Number(totals[0].count), bytes: Number(totals[0].bytes) },
      nextCursor: rows.length > limit ? encodeCursor(files[files.length - 1]) : null,
    };
  }

  async deleteFile(owner: string, id: string): Promise<{ fingerprint: string; orphaned: boolean } | null> {
    // One statement: owner-scoped delete, then a GLOBAL reference check (blob
    // storage is shared across owners). The outer SELECT sees the pre-delete
    // snapshot, hence `f.id <> d.id`.
    const rows = await this.db.query(
      `WITH d AS (DELETE FROM files WHERE id = $1 AND owner_id = $2 RETURNING id, fingerprint)
       SELECT encode(d.fingerprint, 'hex') AS fingerprint,
              NOT EXISTS (SELECT 1 FROM files f WHERE f.fingerprint = d.fingerprint AND f.id <> d.id) AS orphaned
       FROM d`,
      [id, owner],
    );
    const r = rows[0];
    return r ? { fingerprint: String(r.fingerprint), orphaned: Boolean(r.orphaned) } : null;
  }

  async isReferenced(fingerprint: string): Promise<boolean> {
    const rows = await this.db.query(`SELECT EXISTS (SELECT 1 FROM files WHERE fingerprint = decode($1, 'hex')) AS used`, [fingerprint]);
    return Boolean(rows[0]?.used);
  }
}

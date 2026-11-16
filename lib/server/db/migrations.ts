import type { SqlExecutor } from "./executor";

/**
 * Schema designed for Neon's free tier (1 GB per project):
 *  - Only metadata lives in Postgres. File bytes never do.
 *  - SHA-256 values are stored as raw `bytea` (32 B) rather than hex text (64 B).
 *  - The storage key is derived from the fingerprint, so it is not stored.
 *  - Only the indexes that actual queries use; a partial index for open sessions.
 *  - Sessions are short-lived and garbage-collected; files have no per-chunk rows.
 *
 * Each migration is a list of single statements, because the HTTP driver runs
 * one statement per query. A migration is applied atomically in one batch.
 */
export interface Migration {
  id: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "init",
    statements: [
      `CREATE TABLE IF NOT EXISTS files (
        id          text        PRIMARY KEY,
        name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
        size        bigint      NOT NULL CHECK (size > 0),
        mime        text        NOT NULL,
        fingerprint bytea       NOT NULL CHECK (octet_length(fingerprint) = 32),
        created_at  timestamptz NOT NULL
      )`,
      // Dedupe lookups, alias upserts and reference counting all use this index.
      `CREATE UNIQUE INDEX IF NOT EXISTS files_fingerprint_name ON files (fingerprint, name)`,
      // Keyset pagination for the locker: newest first.
      `CREATE INDEX IF NOT EXISTS files_created_id ON files (created_at DESC, id DESC)`,
      `CREATE TABLE IF NOT EXISTS upload_sessions (
        id            text        PRIMARY KEY,
        name          text        NOT NULL,
        size          bigint      NOT NULL CHECK (size > 0),
        claimed_type  text        NOT NULL DEFAULT '',
        fingerprint   bytea       NOT NULL CHECK (octet_length(fingerprint) = 32),
        chunk_hashes  bytea       NOT NULL CHECK (octet_length(chunk_hashes) % 32 = 0),
        status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assembling', 'complete')),
        file_id       text        REFERENCES files (id) ON DELETE SET NULL,
        created_at    timestamptz NOT NULL,
        expires_at    timestamptz NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS upload_sessions_open_fp ON upload_sessions (fingerprint) WHERE status = 'open'`,
      `CREATE INDEX IF NOT EXISTS upload_sessions_expires ON upload_sessions (expires_at)`,
    ],
  },
  {
    // Ownership: every row belongs to one anonymous owner. Additive (existing
    // rows become owner 'legacy', which no real identity can match).
    id: 2,
    name: "owner_scoping",
    statements: [
      `ALTER TABLE files ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE files ALTER COLUMN owner_id DROP DEFAULT`,
      `ALTER TABLE upload_sessions ALTER COLUMN owner_id DROP DEFAULT`,
      `ALTER TABLE files ADD CONSTRAINT files_owner_len CHECK (char_length(owner_id) BETWEEN 1 AND 64)`,
      `ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_owner_len CHECK (char_length(owner_id) BETWEEN 1 AND 64)`,
      // Uniqueness and listing are per owner; ref-counting stays global by fingerprint.
      `CREATE UNIQUE INDEX IF NOT EXISTS files_owner_fp_name ON files (owner_id, fingerprint, name)`,
      `DROP INDEX IF EXISTS files_fingerprint_name`,
      `CREATE INDEX IF NOT EXISTS files_fingerprint ON files (fingerprint)`,
      `CREATE INDEX IF NOT EXISTS files_owner_created ON files (owner_id, created_at DESC, id DESC)`,
      `DROP INDEX IF EXISTS files_created_id`,
      `CREATE INDEX IF NOT EXISTS upload_sessions_owner_open ON upload_sessions (owner_id, fingerprint) WHERE status = 'open'`,
      `DROP INDEX IF EXISTS upload_sessions_open_fp`,
    ],
  },
  {
    // Default-deny row-level security (defence in depth). Only the server talks
    // to the database, as the table owner. Any other role — a leaked read-only
    // credential, a BI tool, Neon's Data API roles — sees zero rows. A least-
    // privilege login can be created IN ROLE hoopload_app (see SECURITY.md).
    id: 3,
    name: "rls_default_deny",
    statements: [
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hoopload_app') THEN CREATE ROLE hoopload_app NOLOGIN; END IF;
       END $$`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`,
    ],
  },
];

/**
 * Enables RLS on EVERY table in `public` with exactly one policy, for the app
 * role. Runs after each migration batch, so tables added later are covered
 * automatically; `rls.test.ts` fails if any table is ever left without it.
 */
export const ENSURE_RLS = `DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS hoopload_app_all ON public.%I', t);
    EXECUTE format('CREATE POLICY hoopload_app_all ON public.%I TO hoopload_app USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO hoopload_app', t);
  END LOOP;
END $$`;

export async function migrate(db: SqlExecutor, log: (m: string) => void = () => {}): Promise<number[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.query<{ id: number }>(`SELECT id FROM schema_migrations`)).map((r) => Number(r.id)));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    log(`applying ${m.id}_${m.name}`);
    await db.batch([
      ...m.statements.map((text) => ({ text })),
      { text: `INSERT INTO schema_migrations (id, name) VALUES ($1, $2)`, params: [m.id, m.name] },
    ]);
    ran.push(m.id);
  }
  if (ran.length) await db.query(ENSURE_RLS);
  return ran;
}

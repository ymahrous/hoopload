import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "@/lib/server/db/migrations";
import { createPgliteExecutor } from "../helpers/pglite";

describe("migrations", () => {
  let close: () => Promise<void> = async () => {};
  afterEach(() => close());

  it("apply once, then are a no-op", async () => {
    const { db, exec } = await createPgliteExecutor({ migrate: false });
    close = () => db.close();
    expect(await migrate(exec)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(exec)).toEqual([]);
    const tables = await exec.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
    expect(tables.map((t) => t.tablename)).toEqual(["files", "schema_migrations", "upload_sessions"]);
  });

  it("each migration is applied in one round trip (one Neon HTTP request)", async () => {
    const { db, exec } = await createPgliteExecutor({ migrate: false });
    close = () => db.close();
    await migrate(exec);
    // create-table + select-applied + one batch per migration + one RLS sweep
    expect(exec.roundTrips).toBe(2 + MIGRATIONS.length + 1);
  });

  it("enforces integrity constraints", async () => {
    const { db, exec } = await createPgliteExecutor();
    close = () => db.close();
    const ins = (fp: string, size = 1, name = "x") =>
      exec.query(`INSERT INTO files (id, owner_id, name, size, mime, fingerprint, created_at) VALUES ($1, 'o', $2, $3, 'a/b', decode($4, 'hex'), now())`, [
        `f${Math.random()}`,
        name,
        size,
        fp,
      ]);
    const fp = "ab".repeat(32);
    await ins(fp);
    await expect(ins("ab".repeat(16))).rejects.toThrow(); // 16-byte fingerprint
    await expect(ins("cd".repeat(32), 0)).rejects.toThrow(); // size must be > 0
    await expect(ins("cd".repeat(32), 1, "")).rejects.toThrow(); // empty name
    await expect(ins(fp)).rejects.toThrow(); // duplicate (owner, fingerprint, name)
    await expect(
      exec.query(
        `INSERT INTO upload_sessions (id, owner_id, name, size, fingerprint, chunk_hashes, status, created_at, expires_at)
         VALUES ('s', 'o', 'n', 1, decode($1, 'hex'), decode($1, 'hex'), 'bogus', now(), now())`,
        [fp],
      ),
    ).rejects.toThrow(); // status check
  });

  it("stores hashes compactly as bytea (32 bytes, not 64 hex chars)", async () => {
    const { db, exec } = await createPgliteExecutor();
    close = () => db.close();
    const rows = await exec.query<{ t: string }>(
      `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'files'::regclass AND attname = 'fingerprint'`,
    );
    expect(rows[0].t).toBe("bytea");
  });
});

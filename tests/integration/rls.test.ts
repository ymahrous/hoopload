import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENSURE_RLS, MIGRATIONS } from "@/lib/server/db/migrations";
import { PostgresStore } from "@/lib/server/store/postgres";
import { createPgliteExecutor } from "../helpers/pglite";

/**
 * Check 1 — RLS on every table (defence in depth; only the server talks to the DB).
 * Proves: every public table has RLS with only the app policy, and a role
 * OUTSIDE the app that holds a direct SELECT grant still reads zero rows.
 */
describe("row-level security", () => {
  let pg: Awaited<ReturnType<typeof createPgliteExecutor>>;
  beforeAll(async () => {
    pg = await createPgliteExecutor();
    const store = new PostgresStore(pg.exec);
    await store.upsertFile("o_aaaaaaaaaaaaaaaaaaaaaa", { id: "file_aaaaaaaaaaaaaaaa", name: "secret.pdf", size: 1, mime: "application/pdf", fingerprint: "ab".repeat(32), createdAt: 0 });
  });
  afterAll(() => pg.db.close());

  it("is enabled on every table in public, with only the app policy", async () => {
    const tables = await pg.exec.query<{ table: string; rls: boolean }>(
      `SELECT c.relname AS table, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p') AND n.nspname = 'public' ORDER BY 1`,
    );
    expect(tables.map((t) => t.table)).toEqual(["files", "schema_migrations", "upload_sessions"]);
    expect(tables.filter((t) => !t.rls)).toEqual([]);

    const policies = await pg.exec.query<{ tablename: string; roles: string; qual: string }>(`SELECT tablename, roles::text AS roles, qual FROM pg_policies WHERE schemaname = 'public'`);
    expect(policies).toHaveLength(tables.length);
    for (const p of policies) expect(p.roles).toBe("{hoopload_app}"); // never anon/authenticated/public
  });

  it("an outside role with a direct SELECT grant sees 0 rows; the app role sees data", async () => {
    await pg.exec.query(`CREATE ROLE intruder NOLOGIN`);
    await pg.exec.query(`GRANT USAGE ON SCHEMA public TO intruder`);
    await pg.exec.query(`GRANT SELECT ON files, upload_sessions TO intruder`);
    await pg.exec.query(`CREATE ROLE app_login NOLOGIN IN ROLE hoopload_app`);

    await pg.db.exec(`SET ROLE intruder`);
    const leaked = await pg.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM files`);
    await pg.db.exec(`RESET ROLE`);
    expect(leaked.rows[0].n).toBe(0);

    await pg.db.exec(`SET ROLE app_login`);
    const visible = await pg.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM files`);
    await pg.db.exec(`RESET ROLE`);
    expect(visible.rows[0].n).toBe(1);
  });

  it("PUBLIC has no table privileges", async () => {
    await pg.db.exec(`CREATE ROLE nobody NOLOGIN`);
    await pg.db.exec(`SET ROLE nobody`);
    await expect(pg.db.query(`SELECT 1 FROM files`)).rejects.toThrow(/permission denied/);
    await pg.db.exec(`RESET ROLE`);
  });

  it("tables added later are covered by the RLS sweep", async () => {
    await pg.exec.query(`CREATE TABLE future_feature (id int)`);
    await pg.exec.query(ENSURE_RLS);
    const r = await pg.exec.query<{ rls: boolean }>(`SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'future_feature'`);
    expect(r[0].rls).toBe(true);
    expect(MIGRATIONS.some((m) => m.name === "rls_default_deny")).toBe(true);
  });
});

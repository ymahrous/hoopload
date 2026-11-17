import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "@/lib/server/db/executor";
import { migrate } from "@/lib/server/db/migrations";

/**
 * Real Postgres (compiled to WASM) in-process. The store runs the exact SQL it
 * would send to Neon; only the transport differs.
 */
export interface CountingExecutor extends SqlExecutor {
  /** Network round trips a Neon HTTP driver would have made. */
  roundTrips: number;
  reset(): void;
}

export async function createPgliteExecutor(opts: { migrate?: boolean } = { migrate: true }): Promise<{ db: PGlite; exec: CountingExecutor }> {
  const db = new PGlite();
  await db.waitReady;
  const exec: CountingExecutor = {
    roundTrips: 0,
    reset() {
      this.roundTrips = 0;
    },
    async query<T>(text: string, params: unknown[] = []) {
      exec.roundTrips++;
      return (await db.query<T>(text, params)).rows;
    },
    async batch(statements, o = {}) {
      exec.roundTrips++;
      return db.transaction(async (tx) => {
        if (o.readOnly) await tx.query("SET TRANSACTION READ ONLY");
        const out: Record<string, unknown>[][] = [];
        for (const s of statements) out.push((await tx.query<Record<string, unknown>>(s.text, s.params ?? [])).rows);
        return out;
      });
    },
  };
  if (opts.migrate !== false) await migrate(exec);
  exec.reset();
  return { db, exec };
}

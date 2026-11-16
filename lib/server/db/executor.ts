import { neon } from "@neondatabase/serverless";

/**
 * The only two things the Postgres store needs from a driver. Keeping it this
 * small means tests run the exact same SQL against PGlite (in-process Postgres).
 */
export interface Statement {
  text: string;
  params?: unknown[];
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs statements atomically in ONE network round trip. */
  batch(statements: Statement[], opts?: { readOnly?: boolean }): Promise<Record<string, unknown>[][]>;
}

/**
 * Neon over HTTP: each call is a single fetch. No sockets are held open, so an
 * idle app never keeps the compute awake, and it can scale to zero after 5 min.
 */
export function neonExecutor(connectionString: string): SqlExecutor {
  const sql = neon(connectionString);
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.query(text, params)) as T[];
    },
    async batch(statements, opts = {}) {
      const results = await sql.transaction(
        statements.map((s) => sql.query(s.text, s.params ?? [])),
        { readOnly: opts.readOnly ?? false, isolationLevel: "ReadCommitted" },
      );
      return results as Record<string, unknown>[][];
    },
  };
}

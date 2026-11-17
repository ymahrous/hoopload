import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/server/store/json";
import { PostgresStore } from "@/lib/server/store/postgres";
import type { MetadataStore, UploadSession } from "@/lib/server/store/types";
import type { FileRecord } from "@/lib/shared/protocol";
import { createPgliteExecutor } from "../helpers/pglite";

/**
 * Contract test: both stores must behave identically. Postgres runs the exact
 * SQL sent to Neon, against a real (WASM) Postgres via PGlite.
 */
const T0 = Date.UTC(2026, 10, 25, 12);
const hex = () => randomBytes(32).toString("hex");
let seq = 0;

const file = (over: Partial<FileRecord> = {}): FileRecord => ({
  id: `file_${++seq}`,
  name: `f${seq}.pdf`,
  size: 1000 + seq,
  mime: "application/pdf",
  fingerprint: hex(),
  createdAt: T0 + seq,
  ...over,
});

const A = "o_aaaaaaaaaaaaaaaaaaaaaa";
const B = "o_bbbbbbbbbbbbbbbbbbbbbb";

const session = (over: Partial<UploadSession> = {}): UploadSession => ({
  id: `up_${++seq}`,
  ownerId: A,
  name: "s.pdf",
  size: 10,
  claimedType: "application/pdf",
  fingerprint: hex(),
  chunkHashes: [hex(), hex()],
  status: "open",
  fileId: null,
  createdAt: T0,
  expiresAt: T0 + 60_000,
  ...over,
});

const pgs: { close(): Promise<void> }[] = [];
const factories: [string, () => Promise<MetadataStore>][] = [
  ["JsonStore", async () => new JsonStore(null)],
  [
    "PostgresStore (PGlite)",
    async () => {
      const { db, exec } = await createPgliteExecutor();
      pgs.push(db);
      return new PostgresStore(exec);
    },
  ],
];
afterAll(async () => Promise.all(pgs.map((d) => d.close())));

describe.each(factories)("%s", (_name, make) => {
  let store: MetadataStore;
  beforeEach(async () => {
    store = await make();
  });

  it("upsertFile is idempotent per (fingerprint, name) and round-trips fields", async () => {
    const f = file();
    expect(await store.upsertFile(A, f)).toEqual(f);
    const again = await store.upsertFile(A, { ...f, id: "file_other", createdAt: T0 + 999 });
    expect(again).toEqual(f);
    expect(await store.getFile(A, f.id)).toEqual(f);
    expect(await store.getFile(A, "nope")).toBeNull();
  });

  it("lookupForInit prefers the exact name, then the oldest same-bytes file, plus open sessions", async () => {
    const fp = hex();
    const older = await store.upsertFile(A, file({ fingerprint: fp, name: "a.pdf", createdAt: T0 + 1 }));
    await store.upsertFile(A, file({ fingerprint: fp, name: "b.pdf", createdAt: T0 + 2 }));

    expect(await store.lookupForInit(A, fp, "b.pdf", T0)).toMatchObject({ exact: true, file: { name: "b.pdf" } });
    expect(await store.lookupForInit(A, fp, "zzz.pdf", T0)).toMatchObject({ exact: false, file: { id: older.id } });

    const s = session();
    await store.createSession(s);
    expect(await store.lookupForInit(A, s.fingerprint, "x", T0)).toMatchObject({ file: null, exact: false, openSessionId: s.id });
    expect((await store.lookupForInit(A, s.fingerprint, "x", s.expiresAt + 1)).openSessionId).toBeNull();
  });

  it("sessions round-trip, including chunk hashes stored as bytea", async () => {
    const s = session({ chunkHashes: [hex(), hex(), hex()] });
    await store.createSession(s);
    expect(await store.getSession(s.id, T0)).toEqual(s);
    expect(await store.getSession(s.id, s.expiresAt)).toBeNull();

    await store.touchSession(s.id, A, "renamed.pdf", T0 + 999_999);
    expect(await store.getSession(s.id, T0)).toMatchObject({ name: "renamed.pdf", expiresAt: T0 + 999_999 });
  });

  it("claim -> finalize lifecycle is atomic and idempotent", async () => {
    const s = session();
    await store.createSession(s);

    const first = await store.claimSession(s.id, A, T0);
    expect(first.outcome).toBe("claimed");
    expect(await store.claimSession(s.id, A, T0)).toEqual({ outcome: "assembling" });

    const f = file({ fingerprint: s.fingerprint, name: s.name });
    const saved = await store.finalizeSession(s.id, A, f, T0 + 3_600_000);
    expect(saved).toEqual(f);
    expect(await store.claimSession(s.id, A, T0)).toEqual({ outcome: "complete", file: f });
    expect(await store.claimSession("missing", A, T0)).toEqual({ outcome: "missing" });
    // Completed sessions can't be aborted.
    expect(await store.deleteSession(s.id, A)).toBe(false);
  });

  it("reopen returns an assembling session to open", async () => {
    const s = session();
    await store.createSession(s);
    await store.claimSession(s.id, A, T0);
    await store.reopenSession(s.id);
    expect((await store.claimSession(s.id, A, T0)).outcome).toBe("claimed");
  });

  it("finalize reuses an existing (fingerprint, name) row", async () => {
    const existing = await store.upsertFile(A, file());
    const s = session({ fingerprint: existing.fingerprint, name: existing.name });
    await store.createSession(s);
    await store.claimSession(s.id, A, T0);
    const saved = await store.finalizeSession(s.id, A, file({ fingerprint: existing.fingerprint, name: existing.name }), T0 + 1000);
    expect(saved.id).toBe(existing.id);
    expect(await store.claimSession(s.id, A, T0)).toEqual({ outcome: "complete", file: existing });
  });

  it("deleteExpiredSessions only removes expired ones", async () => {
    const live = session({ expiresAt: T0 + 10_000 });
    const dead = session({ expiresAt: T0 - 1 });
    await store.createSession(live);
    await store.createSession(dead);
    expect(await store.deleteExpiredSessions(T0)).toEqual([dead.id]);
    expect(await store.getSession(live.id, T0)).not.toBeNull();
  });

  it("deleteFile reference-counts shared bytes", async () => {
    const fp = hex();
    const a = await store.upsertFile(A, file({ fingerprint: fp, name: "a" }));
    const b = await store.upsertFile(A, file({ fingerprint: fp, name: "b" }));
    expect(await store.deleteFile(A, a.id)).toEqual({ fingerprint: fp, orphaned: false });
    expect(await store.deleteFile(A, b.id)).toEqual({ fingerprint: fp, orphaned: true });
    expect(await store.deleteFile(A, b.id)).toBeNull();
  });

  it("listFiles paginates newest-first with a stable keyset cursor and exact totals", async () => {
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await store.upsertFile(A, file({ createdAt: T0 + 100 + (i % 3) }))); // ties on created_at
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.listFiles(A, { limit: 3, cursor });
      expect(page.totals).toEqual({ count: 7, bytes: made.reduce((n, f) => n + f.size, 0) });
      seen.push(...page.files.map((f) => f.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const expected = [...made].sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? 1 : -1)).map((f) => f.id);
    expect(seen).toEqual(expected);
  });

  it("SECURITY: every read and write is isolated by owner", async () => {
    const fp = hex();
    const mine = await store.upsertFile(A, file({ fingerprint: fp, name: "secret.pdf" }));
    // B cannot see, list, fetch, dedupe against, or delete A's file.
    expect(await store.getFile(B, mine.id)).toBeNull();
    expect((await store.listFiles(B, { limit: 10 })).totals).toEqual({ count: 0, bytes: 0 });
    expect((await store.lookupForInit(B, fp, "secret.pdf", T0)).file).toBeNull();
    expect(await store.deleteFile(B, mine.id)).toBeNull();
    expect(await store.getFile(A, mine.id)).toEqual(mine);
    // Same bytes + name for B is a separate record; deleting A's keeps the shared bytes referenced.
    const theirs = await store.upsertFile(B, file({ fingerprint: fp, name: "secret.pdf" }));
    expect(theirs.id).not.toBe(mine.id);
    expect(await store.deleteFile(A, mine.id)).toEqual({ fingerprint: fp, orphaned: false });
    expect(await store.isReferenced(fp)).toBe(true);
    expect(await store.deleteFile(B, theirs.id)).toEqual({ fingerprint: fp, orphaned: true });
    expect(await store.isReferenced(fp)).toBe(false);

    // Sessions: B cannot claim, resume, finalize or abort A's session.
    const s = session({ ownerId: A });
    await store.createSession(s);
    expect((await store.lookupForInit(B, s.fingerprint, "x", T0)).openSessionId).toBeNull();
    expect(await store.claimSession(s.id, B, T0)).toEqual({ outcome: "missing" });
    expect(await store.deleteSession(s.id, B)).toBe(false);
    await store.touchSession(s.id, B, "hijack.pdf", T0 + 1);
    expect((await store.getSession(s.id, T0))?.name).toBe(s.name);
  });

  it("reports per-owner usage for quotas in the init lookup", async () => {
    await store.upsertFile(A, file({ size: 100 }));
    await store.upsertFile(A, file({ size: 250 }));
    await store.upsertFile(B, file({ size: 999 }));
    await store.createSession(session({ ownerId: A }));
    await store.createSession(session({ ownerId: A, expiresAt: T0 - 1 })); // expired: not counted
    expect((await store.lookupForInit(A, hex(), "n", T0)).usage).toEqual({ files: 2, bytes: 350, openSessions: 1 });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/server/core";
import { LocalDiskStorage, objectKeyFor } from "@/lib/server/storage";
import { JsonStore } from "@/lib/server/store/json";
import { PostgresStore } from "@/lib/server/store/postgres";
import type { MetadataStore } from "@/lib/server/store/types";
import { createUploadService, type UploadService } from "@/lib/server/uploads";
import { CHUNK_SIZE, SESSION_TTL_MS, type FeedEvent } from "@/lib/shared/protocol";
import { createPgliteExecutor, type CountingExecutor } from "../helpers/pglite";
import { FakeClock, chunkOf, exeBytes, pdfBytes, planUpload, sha256, streamOf } from "../helpers/fixtures";

const ME = "o_mmmmmmmmmmmmmmmmmmmmmm";
const THEM = "o_tttttttttttttttttttttt";
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

interface Ctx {
  svc: UploadService;
  store: MetadataStore;
  storage: LocalDiskStorage;
  root: string;
  events: FeedEvent[];
  clock: FakeClock;
  exec?: CountingExecutor;
}

async function setup(kind: "json" | "postgres"): Promise<Ctx> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hoop-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  let store: MetadataStore;
  let exec: CountingExecutor | undefined;
  if (kind === "postgres") {
    const pg = await createPgliteExecutor();
    cleanups.push(() => pg.db.close());
    exec = pg.exec;
    store = new PostgresStore(exec);
  } else {
    store = new JsonStore(null);
  }
  const storage = new LocalDiskStorage(root);
  const events: FeedEvent[] = [];
  const clock = new FakeClock();
  const svc = createUploadService({ store, storage, publish: (_owner, e) => events.push(e), now: clock.now, minFreeBytes: 0 });
  return { svc, store, storage, root, events, clock, exec };
}

async function uploadAll(svc: UploadService, bytes: Buffer, name = "doc.pdf") {
  const plan = planUpload(bytes, name);
  const init = await svc.init(ME, plan);
  if (init.status === "complete") return { init, file: init.file };
  for (let i = 0; i < init.totalChunks; i++) if (!init.received.includes(i)) await svc.putChunk(ME, init.uploadId, i, streamOf(chunkOf(bytes, i)), chunkOf(bytes, i).length);
  return { init, file: await svc.complete(ME, init.uploadId) };
}

const expectHttp = async (p: Promise<unknown>, status: number, code?: string) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err.status).toBe(status);
  if (code) expect(err.code).toBe(code);
};

describe.each(["json", "postgres"] as const)("upload service with %s store", (kind) => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup(kind);
  });

  it("uploads a multi-chunk file byte-for-byte, publishes it and cleans up staging", async () => {
    const bytes = pdfBytes(CHUNK_SIZE * 2 + 123);
    const { init, file } = await uploadAll(c.svc, bytes);
    expect(init).toMatchObject({ status: "open", totalChunks: 3 });
    expect(file).toMatchObject({ name: "doc.pdf", size: bytes.length, mime: "application/pdf" });

    const stored = await fs.readFile(path.join(c.root, objectKeyFor(file.fingerprint)));
    expect(sha256(stored)).toBe(sha256(bytes));
    expect(c.events).toEqual([{ type: "file.created", file }]);
    expect(await c.storage.listChunks(init.status === "open" ? init.uploadId : "")).toEqual([]);
  });

  it("rejects corrupted chunks with 422 and accepts the retry", async () => {
    const bytes = pdfBytes(5000);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    const bad = Buffer.from(bytes);
    bad[100] ^= 0xff;
    await expectHttp(c.svc.putChunk(ME, init.uploadId, 0, streamOf(bad), bad.length), 422, "chunk_corrupt");
    expect(await c.storage.listChunks(init.uploadId)).toEqual([]);
    const ok = await c.svc.putChunk(ME, init.uploadId, 0, streamOf(bytes), bytes.length);
    expect(ok).toMatchObject({ duplicate: false, received: 1 });
  });

  it("chunk PUTs are idempotent and validated", async () => {
    const bytes = pdfBytes(CHUNK_SIZE + 10);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    const id = init.uploadId;
    await c.svc.putChunk(ME, id, 0, streamOf(chunkOf(bytes, 0)), CHUNK_SIZE);
    expect(await c.svc.putChunk(ME, id, 0, streamOf(chunkOf(bytes, 0)), CHUNK_SIZE)).toMatchObject({ duplicate: true });
    await expectHttp(c.svc.putChunk(ME, id, 2, streamOf(Buffer.alloc(1)), 1), 400, "bad_index");
    await expectHttp(c.svc.putChunk(ME, id, 1, streamOf(Buffer.alloc(5)), 5), 400, "bad_length");
    await expectHttp(c.svc.putChunk(ME, id, 1, streamOf(Buffer.alloc(11)), null), 411, "bad_length");
    await expectHttp(c.svc.putChunk(ME, id, 1, streamOf(Buffer.alloc(11)), 10), 413, "chunk_too_large"); // body longer than declared
    await expectHttp(c.svc.putChunk(ME, "up_doesnotexist0000", 0, streamOf(Buffer.alloc(1)), 1), 404);
  });

  it("refuses to complete with missing chunks", async () => {
    const bytes = pdfBytes(CHUNK_SIZE + 10);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    await c.svc.putChunk(ME, init.uploadId, 0, streamOf(chunkOf(bytes, 0)), CHUNK_SIZE);
    await expectHttp(c.svc.complete(ME, init.uploadId), 409, "incomplete");
  });

  it("resumes an interrupted upload, reporting chunks already stored", async () => {
    const bytes = pdfBytes(CHUNK_SIZE * 2 + 1);
    const plan = planUpload(bytes, "first-name.pdf");
    const a = await c.svc.init(ME, plan);
    if (a.status !== "open") throw new Error();
    await c.svc.putChunk(ME, a.uploadId, 1, streamOf(chunkOf(bytes, 1)), CHUNK_SIZE);

    const b = await c.svc.init(ME, { ...plan, name: "second-name.pdf" });
    expect(b).toMatchObject({ status: "open", uploadId: a.uploadId, received: [1] });
    for (const i of [0, 2]) await c.svc.putChunk(ME, a.uploadId, i, streamOf(chunkOf(bytes, i)), chunkOf(bytes, i).length);
    expect((await c.svc.complete(ME, a.uploadId)).name).toBe("second-name.pdf");
  });

  it("deduplicates: same bytes complete instantly; a new name becomes an alias sharing storage", async () => {
    const bytes = pdfBytes(3000);
    const { file } = await uploadAll(c.svc, bytes, "one.pdf");
    const again = await c.svc.init(ME, planUpload(bytes, "one.pdf"));
    expect(again).toEqual({ status: "complete", file, deduped: true });

    const alias = await c.svc.init(ME, planUpload(bytes, "two.pdf"));
    if (alias.status !== "complete") throw new Error();
    expect(alias.file).toMatchObject({ name: "two.pdf", fingerprint: file.fingerprint });
    expect(alias.file.id).not.toBe(file.id);

    // Deleting one keeps the bytes for the other (reference counting).
    await c.svc.remove(ME, file.id);
    await expect(fs.stat(path.join(c.root, objectKeyFor(file.fingerprint)))).resolves.toBeTruthy();
    await c.svc.remove(ME, alias.file.id);
    await expect(fs.stat(path.join(c.root, objectKeyFor(file.fingerprint)))).rejects.toThrow();
    expect(c.events.map((e) => e.type)).toEqual(["file.created", "file.created", "file.deleted", "file.deleted"]);
  });

  it("complete is idempotent and safe under concurrency", async () => {
    const bytes = pdfBytes(2000);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    await c.svc.putChunk(ME, init.uploadId, 0, streamOf(bytes), bytes.length);
    const results = await Promise.allSettled([c.svc.complete(ME, init.uploadId), c.svc.complete(ME, init.uploadId)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409, headers: { "Retry-After": "1" } });
    // A retry after success returns the same file.
    const first = (ok[0] as PromiseFulfilledResult<{ id: string }>).value;
    expect((await c.svc.complete(ME, init.uploadId)).id).toBe(first.id);
    expect((await c.svc.list(ME)).totals.count).toBe(1);
  });

  it("blocks an executable disguised as a PDF and leaves nothing behind", async () => {
    const bytes = exeBytes();
    const init = await c.svc.init(ME, planUpload(bytes, "invoice.pdf"));
    if (init.status !== "open") throw new Error();
    await c.svc.putChunk(ME, init.uploadId, 0, streamOf(bytes), bytes.length);
    await expectHttp(c.svc.complete(ME, init.uploadId), 415, "blocked_type");
    expect((await c.svc.list(ME)).totals.count).toBe(0);
    await expect(fs.stat(path.join(c.root, objectKeyFor(planUpload(bytes).fingerprint)))).rejects.toThrow();
    expect(c.events).toEqual([]);
  });

  it("rejects forged or malformed init requests", async () => {
    const plan = planUpload(pdfBytes(100));
    await expectHttp(c.svc.init(ME, { ...plan, fingerprint: "0".repeat(64) }), 400, "bad_fingerprint");
    await expectHttp(c.svc.init(ME, { ...plan, chunkSize: 1024 }), 400, "bad_chunk_size");
    await expectHttp(c.svc.init(ME, { ...plan, chunkHashes: ["xyz"] }), 400, "bad_hashes");
    await expectHttp(c.svc.init(ME, { ...plan, size: 0 }), 400, "bad_size");
    await expectHttp(c.svc.init(ME, { ...plan, size: 2 ** 40 }), 413, "file_too_large");
    await expectHttp(c.svc.init(ME, { ...plan, name: ".." }), 400, "bad_name");
  });

  it("abort discards staged chunks; status reports progress", async () => {
    const bytes = pdfBytes(CHUNK_SIZE + 5);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    await c.svc.putChunk(ME, init.uploadId, 0, streamOf(chunkOf(bytes, 0)), CHUNK_SIZE);
    expect(await c.svc.status(ME, init.uploadId)).toMatchObject({ status: "open", received: [0], totalChunks: 2 });
    await c.svc.abort(ME, init.uploadId);
    expect(await c.storage.listChunks(init.uploadId)).toEqual([]);
    await expectHttp(c.svc.complete(ME, init.uploadId), 404);
  });

  it("expired sessions are swept lazily by later traffic", async () => {
    const bytes = pdfBytes(CHUNK_SIZE + 5);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    await c.svc.putChunk(ME, init.uploadId, 0, streamOf(chunkOf(bytes, 0)), CHUNK_SIZE);
    c.clock.advance(SESSION_TTL_MS + 16 * 60_000);
    await c.svc.init(ME, planUpload(pdfBytes(10), "trigger.pdf")); // triggers GC
    await new Promise((r) => setTimeout(r, 50));
    expect(await c.storage.listChunks(init.uploadId)).toEqual([]);
    await expectHttp(c.svc.status(ME, init.uploadId), 404);
  });

  it("list is micro-cached but invalidated by writes", async () => {
    await uploadAll(c.svc, pdfBytes(100), "a.pdf");
    expect((await c.svc.list(ME)).files).toHaveLength(1);
    await uploadAll(c.svc, pdfBytes(100), "b.pdf");
    expect((await c.svc.list(ME)).files).toHaveLength(2);
    await expectHttp(c.svc.getFile(ME, "file_nope00000000000"), 404);
    await expectHttp(c.svc.remove(ME, "file_nope00000000000"), 404);
  });
});

describe.each(["json", "postgres"] as const)("SECURITY: owner isolation with %s store", (kind) => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup(kind);
  });

  it("another owner cannot read, list, download, delete, resume, complete or abort", async () => {
    const bytes = pdfBytes(CHUNK_SIZE + 10);
    const { file } = await uploadAll(c.svc, bytes, "private.pdf");
    await expectHttp(c.svc.getFile(THEM, file.id), 404, "not_found");
    await expectHttp(c.svc.remove(THEM, file.id), 404, "not_found");
    expect((await c.svc.list(THEM)).files).toEqual([]);
    expect((await c.svc.list(null)).files).toEqual([]);

    const mine = await c.svc.init(ME, planUpload(pdfBytes(CHUNK_SIZE + 5), "wip.pdf"));
    if (mine.status !== "open") throw new Error();
    const id = mine.uploadId;
    await expectHttp(c.svc.status(THEM, id), 404, "upload_not_found");
    await expectHttp(c.svc.putChunk(THEM, id, 0, streamOf(Buffer.alloc(CHUNK_SIZE)), CHUNK_SIZE), 404, "upload_not_found");
    await expectHttp(c.svc.complete(THEM, id), 404, "upload_not_found");
    await expectHttp(c.svc.abort(THEM, id), 404, "upload_not_found");
    expect((await c.svc.status(ME, id)).status).toBe("open");
    expect((await c.svc.getFile(ME, file.id)).id).toBe(file.id);
  });

  it("dedupe is not an oracle: another owner's identical bytes must be uploaded in full", async () => {
    const bytes = pdfBytes(3000);
    await uploadAll(c.svc, bytes, "known.pdf");
    const probe = await c.svc.init(THEM, planUpload(bytes, "known.pdf"));
    expect(probe).toMatchObject({ status: "open", received: [] }); // indistinguishable from unknown bytes
    // Proof of possession: they get the file only after sending every byte. Storage is still shared.
    if (probe.status !== "open") throw new Error();
    await c.svc.putChunk(THEM, probe.uploadId, 0, streamOf(bytes), bytes.length);
    const theirs = await c.svc.complete(THEM, probe.uploadId);
    expect(theirs.fingerprint).toBe(planUpload(bytes).fingerprint);
  });

  it("malformed ids are rejected before any lookup and look like missing ones", async () => {
    for (const id of ["../../etc/passwd", "up_", "up_short", "file_x", "up_aaaaaaaaaaaaaaaa/../x", "file_aaaaaaaaaaaaaaaa"]) {
      await expectHttp(c.svc.status(ME, id), 404);
    }
    await expectHttp(c.svc.getFile(ME, "up_aaaaaaaaaaaaaaaa"), 404);
  });

  it("rejects unknown fields and wrong types in init (no mass assignment)", async () => {
    const plan = planUpload(pdfBytes(10));
    await expectHttp(c.svc.init(ME, { ...plan, ownerId: THEM } as never), 400, "unknown_field");
    await expectHttp(c.svc.init(ME, { ...plan, __proto__: { x: 1 }, isAdmin: true } as never), 400, "unknown_field");
    await expectHttp(c.svc.init(ME, { ...plan, type: 42 } as never), 400, "bad_type");
    await expectHttp(c.svc.init(ME, { ...plan, size: 1.5 }), 400, "bad_size");
    // A hostile MIME claim is dropped, not stored.
    const ok = await c.svc.init(ME, { ...plan, type: "text/html<script>" });
    expect(ok.status).toBe("open");
  });
});

describe("SECURITY: quotas, disk guard and slow bodies", () => {
  async function svcWith(over: Partial<Parameters<typeof createUploadService>[0]>) {
    const c = await setup("json");
    return { ...c, svc: createUploadService({ store: c.store, storage: c.storage, publish: () => {}, now: c.clock.now, minFreeBytes: 0, ...over }) };
  }

  it("enforces per-owner storage, file-count and open-upload quotas", async () => {
    const c = await svcWith({ quotas: { storageBytes: 5000, files: 2, openUploads: 2 } });
    await uploadAll(c.svc, pdfBytes(2000), "a.pdf");
    await expectHttp(c.svc.init(ME, planUpload(pdfBytes(4000), "big.pdf")), 413, "quota_storage");
    await uploadAll(c.svc, pdfBytes(1000), "b.pdf");
    await expectHttp(c.svc.init(ME, planUpload(pdfBytes(10), "c.pdf")), 413, "quota_files");
    // Quotas are per owner.
    expect((await c.svc.init(THEM, planUpload(pdfBytes(10), "c.pdf"))).status).toBe("open");

    const d = await svcWith({ quotas: { storageBytes: 1e9, files: 100, openUploads: 2 } });
    await d.svc.init(ME, planUpload(pdfBytes(10), "1.pdf"));
    await d.svc.init(ME, planUpload(pdfBytes(10), "2.pdf"));
    await expectHttp(d.svc.init(ME, planUpload(pdfBytes(10), "3.pdf")), 429, "too_many_uploads");
  });

  it("refuses new uploads when the disk would drop below the free-space reserve", async () => {
    const c = await setup("json");
    const storage = Object.assign(Object.create(Object.getPrototypeOf(c.storage)), c.storage, { freeBytes: async () => 10_000 });
    const svc = createUploadService({ store: c.store, storage, publish: () => {}, now: c.clock.now, minFreeBytes: 8_000 });
    expect((await svc.init(ME, planUpload(pdfBytes(1000), "fits.pdf"))).status).toBe("open");
    await expectHttp(svc.init(ME, planUpload(pdfBytes(3000), "toobig.pdf")), 507, "insufficient_storage");
  });

  it("aborts a chunk body that stalls (slowloris) with 408 and leaves nothing behind", async () => {
    const c = await svcWith({ chunkTimeoutMs: 150 });
    const bytes = pdfBytes(1000);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    const stalled = new ReadableStream<Uint8Array>({ start: (ctl) => ctl.enqueue(bytes.subarray(0, 10)) }); // never closes
    await expectHttp(c.svc.putChunk(ME, init.uploadId, 0, stalled, bytes.length), 408, "chunk_timeout");
    expect(await c.storage.listChunks(init.uploadId)).toEqual([]);
  });

  it("caps simultaneous chunk writes per owner", async () => {
    const c = await svcWith({ chunkTimeoutMs: 2000 });
    const bytes = pdfBytes(CHUNK_SIZE * 7 + 1);
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    const hold: ReadableStreamDefaultController<Uint8Array>[] = [];
    const slow = () => new ReadableStream<Uint8Array>({ start: (ctl) => void hold.push(ctl) });
    const inflight = Array.from({ length: 6 }, (_, i) => c.svc.putChunk(ME, init.uploadId, i, slow(), CHUNK_SIZE).catch((e) => e));
    await new Promise((r) => setTimeout(r, 50));
    await expectHttp(c.svc.putChunk(ME, init.uploadId, 6, streamOf(chunkOf(bytes, 6)), CHUNK_SIZE), 429, "too_many_concurrent");
    for (const ctl of hold) ctl.error(new Error("client went away"));
    await Promise.all(inflight);
  });
});

describe("Neon free-tier query budget (PostgresStore)", () => {
  it("costs 2 round trips to init, 0 per chunk, 2 to complete, 0-1 to list", async () => {
    const c = await setup("postgres");
    const exec = c.exec!;
    const bytes = pdfBytes(CHUNK_SIZE * 3 + 1); // 4 chunks

    // The first request on a fresh instance also sweeps expired sessions (one
    // extra DELETE), then sweeps are throttled to every 15 minutes.
    exec.reset();
    await c.svc.init(ME, planUpload(pdfBytes(50), "warm-up.pdf"));
    expect(exec.roundTrips).toBe(3);

    exec.reset();
    const init = await c.svc.init(ME, planUpload(bytes));
    if (init.status !== "open") throw new Error();
    expect(exec.roundTrips).toBe(2); // batched lookup + insert session (GC is throttled)

    exec.reset();
    for (let i = 0; i < 4; i++) await c.svc.putChunk(ME, init.uploadId, i, streamOf(chunkOf(bytes, i)), chunkOf(bytes, i).length);
    expect(exec.roundTrips).toBe(0); // session served from the in-process cache

    exec.reset();
    await c.svc.complete(ME, init.uploadId);
    expect(exec.roundTrips).toBe(2); // claim + batched finalize

    exec.reset();
    await c.svc.list(ME);
    await c.svc.list(ME);
    await c.svc.list(ME);
    expect(exec.roundTrips).toBe(1); // micro-cache absorbs bursts

    exec.reset();
    expect((await c.svc.init(ME, planUpload(bytes))).status).toBe("complete");
    expect(exec.roundTrips).toBe(1); // dedupe hit: one read
  });
});

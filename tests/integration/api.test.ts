import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHUNK_SIZE, type FilesResponse, type InitUploadResponse } from "@/lib/shared/protocol";
import { pdfBytes, planUpload, sha256 } from "../helpers/fixtures";
import { ctx, makeReq, newClient, uploadVia, type Client } from "../helpers/http";

/**
 * HTTP contract tests: real route handlers, real Request/Response, JSON store
 * on a temp dir. Status codes, headers and bodies that clients depend on.
 */
const env = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/hoop-api-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.SESSION_SECRET = "t".repeat(48);
  delete process.env.DATABASE_URL;
  return { dir };
});

import { routes } from "../helpers/routes";

let me: Client;
beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  me = await newClient(routes);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(env.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const post = (path: string, c: Client, body: unknown) =>
  makeReq(path, { method: "POST", client: c, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("HTTP API", () => {
  it("GET /api/session issues a signed HttpOnly cookie once", async () => {
    const res = await routes.session.GET(makeReq("/api/session", { client: { ip: "10.99.0.1" } }), ctx({}));
    expect(res.headers.get("set-cookie")).toMatch(/^hl_owner=o_[\w-]{22}\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    const again = await routes.session.GET(makeReq("/api/session", { client: me }), ctx({}));
    expect(await again.json()).toEqual({ ok: true, fresh: false });
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("POST /api/uploads: 201 for a new session, 200 for your own dedupe hit, RateLimit headers", async () => {
    const bytes = pdfBytes(CHUNK_SIZE + 77);
    const file = await uploadVia(routes, me, bytes, "contract.pdf");
    expect(file).toMatchObject({ name: "contract.pdf", size: bytes.length });
    const res = await routes.uploads.POST(post("/api/uploads", me, planUpload(bytes, "contract.pdf")), ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "complete", deduped: true });
    expect(res.headers.get("ratelimit-limit")).toMatch(/^\d+$/);
    expect(res.headers.get("ratelimit-remaining")).toMatch(/^\d+$/);
  });

  it("returns structured 4xx errors", async () => {
    const bad = await routes.uploads.POST(makeReq("/x", { method: "POST", client: me, headers: { "content-type": "application/json" }, body: "{nope" }), ctx({}));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "bad_json", message: expect.any(String) } });
    const big = await routes.uploads.POST(makeReq("/x", { method: "POST", client: me, headers: { "content-type": "application/json", "content-length": "999999" }, body: "{}" }), ctx({}));
    expect(big.status).toBe(413);
    const missing = await routes.complete.POST(makeReq("/x", { method: "POST", client: me }), ctx({ id: "up_missing00000000" }));
    expect(missing.status).toBe(404);
    const traversal = await routes.chunk.PUT(
      makeReq("/x", { method: "PUT", client: me, headers: { "content-type": "application/octet-stream", "content-length": "1" }, body: "x" }),
      ctx({ id: "../../etc", index: "0" }),
    );
    expect(traversal.status).toBe(404);
  });

  it("chunk PUT requires octet-stream and Content-Length", async () => {
    const init = (await (await routes.uploads.POST(post("/x", me, planUpload(pdfBytes(100), "ct.pdf")), ctx({}))).json()) as InitUploadResponse;
    if (init.status !== "open") throw new Error();
    const asText = await routes.chunk.PUT(
      makeReq("/x", { method: "PUT", client: me, headers: { "content-type": "text/plain", "content-length": "100" }, body: "x".repeat(100) }),
      ctx({ id: init.uploadId, index: "0" }),
    );
    expect(asText.status).toBe(415);
  });

  it("GET /api/files/:id streams your bytes as an inert, private attachment", async () => {
    const bytes = pdfBytes(10_000);
    const file = await uploadVia(routes, me, bytes, 'résumé "v2".pdf');
    const res = await routes.file.GET(makeReq(`/api/files/${file.id}`, { client: me }), ctx({ id: file.id }));
    expect(res.status).toBe(200);
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(sha256(bytes));
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="r_sum_ _v2_.pdf"; filename\*=UTF-8''/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("supports Range (206/416) and conditional requests (304)", async () => {
    const bytes = pdfBytes(5000);
    const file = await uploadVia(routes, me, bytes, "ranges.pdf");
    const get = (h: Record<string, string>) => routes.file.GET(makeReq("/x", { client: me, headers: h }), ctx({ id: file.id }));
    const part = await get({ range: "bytes=0-7" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-7/${bytes.length}`);
    expect(await part.text()).toBe("%PDF-1.7");
    expect((await get({ range: `bytes=${bytes.length}-` })).status).toBe(416);
    expect((await get({ "if-none-match": `"${file.fingerprint}"` })).status).toBe(304);
  });

  it("GET /api/files paginates YOUR files; DELETE removes and 404s afterwards", async () => {
    const c = await newClient(routes);
    for (let i = 0; i < 3; i++) await uploadVia(routes, c, pdfBytes(100 + i), `page-${i}.pdf`);
    const first = (await (await routes.files.GET(makeReq("/api/files?limit=2", { client: c }), ctx({}))).json()) as FilesResponse;
    expect(first.files).toHaveLength(2);
    expect(first.totals.count).toBe(3);
    const next = (await (await routes.files.GET(makeReq(`/api/files?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, { client: c }), ctx({}))).json()) as FilesResponse;
    expect(next.files).toHaveLength(1);
    const id = first.files[0].id;
    expect((await routes.file.DELETE(makeReq("/x", { method: "DELETE", client: c }), ctx({ id }))).status).toBe(204);
    expect((await routes.file.GET(makeReq("/x", { client: c }), ctx({ id }))).status).toBe(404);
  });

  it("GET/DELETE /api/uploads/:id reports and aborts your session", async () => {
    const init = (await (await routes.uploads.POST(post("/x", me, planUpload(pdfBytes(CHUNK_SIZE + 1), "abort.pdf")), ctx({}))).json()) as InitUploadResponse;
    if (init.status !== "open") throw new Error();
    const status = await routes.upload.GET(makeReq("/x", { client: me }), ctx({ id: init.uploadId }));
    expect(await status.json()).toMatchObject({ status: "open", received: [], totalChunks: 2 });
    expect((await routes.upload.DELETE(makeReq("/x", { method: "DELETE", client: me }), ctx({ id: init.uploadId }))).status).toBe(204);
    expect((await routes.upload.GET(makeReq("/x", { client: me }), ctx({ id: init.uploadId }))).status).toBe(404);
  });

  it("GET /api/events streams only your own file events", async () => {
    const other = await newClient(routes);
    const open = async (c: Client) => {
      const ac = new AbortController();
      const res = await routes.events.GET(new Request(`${"http://app.test"}/api/events`, { headers: { "x-hoop-client-ip": c.ip, cookie: c.cookie }, signal: ac.signal }), ctx({}));
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      let buf = "";
      const dec = new TextDecoder();
      return {
        ac,
        reader,
        read: async (needle: string, ms = 1500) => {
          const end = Date.now() + ms;
          while (!buf.includes(needle) && Date.now() < end) {
            const r = await Promise.race([reader.read(), new Promise<{ value: undefined }>((ok) => setTimeout(() => ok({ value: undefined }), 100))]);
            if (r.value) buf += dec.decode(r.value);
          }
          return buf.includes(needle);
        },
      };
    };
    const mine = await open(me);
    const theirs = await open(other);
    expect(await mine.read("event: hello")).toBe(true);
    const file = await uploadVia(routes, me, pdfBytes(321), "live.pdf");
    expect(await mine.read(file.id)).toBe(true);
    expect(await theirs.read(file.id, 400)).toBe(false);
    for (const s of [mine, theirs]) {
      s.ac.abort();
      await s.reader.cancel();
    }
  });
});

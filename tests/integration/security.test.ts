import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitUploadResponse } from "@/lib/shared/protocol";
import { pdfBytes, planUpload } from "../helpers/fixtures";
import { ctx, freshIp, makeReq, newClient, uploadVia, type Client } from "../helpers/http";

/**
 * Check 2 (server-side authorization) and Check 5 (rate limits), end to end
 * through the real route handlers.
 */
const env = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/hoop-sec-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.SESSION_SECRET = "z".repeat(48);
  process.env.RATE_LIMIT_MULTIPLIER = "1";
  process.env.HEALTH_TOKEN = "h".repeat(32);
  delete process.env.DATABASE_URL;
  return { dir };
});

import { SECURE_ROUTE, type SecureRouteOptions } from "@/lib/server/security/secureRoute";
import { POLICIES, resetRateLimits } from "@/lib/server/security/rateLimit";
import { routes } from "../helpers/routes";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(env.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ----------------------------------------------------------------- inventory

async function routeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await routeFiles(p)));
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** The only endpoints that may be called without an identity. */
const PUBLIC = new Set(["session", "files.list", "health"]);

describe("endpoint enumeration (new routes are covered automatically)", () => {
  it("every API handler is built with secureRoute, with CSRF on mutations and identity where needed", async () => {
    const files = await routeFiles(path.join(process.cwd(), "app/api"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    const seen: string[] = [];
    for (const f of files) {
      const mod = (await import(f)) as Record<string, unknown>;
      for (const verb of VERBS) {
        const handler = mod[verb] as ({ [SECURE_ROUTE]?: SecureRouteOptions } & object) | undefined;
        if (!handler) continue;
        const where = `${path.relative(process.cwd(), f)} ${verb}`;
        const opts = handler[SECURE_ROUTE];
        expect(opts, `${where} must use secureRoute`).toBeDefined();
        if (MUTATING.has(verb)) expect(opts!.mutating, `${where} must enforce same-origin`).toBe(true);
        if (!PUBLIC.has(opts!.name)) expect(opts!.identity, `${where} must require identity`).toBe("required");
        seen.push(opts!.name);
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
  });
});

// ------------------------------------------------------------ authorization

describe("authorization (IDOR) — another identity gets 404 everywhere", () => {
  let alice: Client;
  let mallory: Client;
  let fileId: string;
  let uploadId: string;

  beforeAll(async () => {
    alice = await newClient(routes);
    mallory = await newClient(routes);
    fileId = (await uploadVia(routes, alice, pdfBytes(500), "alice-private.pdf")).id;
    const init = (await (
      await routes.uploads.POST(
        makeReq("/x", { method: "POST", client: alice, headers: { "content-type": "application/json" }, body: JSON.stringify(planUpload(pdfBytes(800), "wip.pdf")) }),
        ctx({}),
      )
    ).json()) as InitUploadResponse;
    if (init.status !== "open") throw new Error();
    uploadId = init.uploadId;
  });

  it.each([
    ["download", () => routes.file.GET(makeReq("/x", { client: mallory }), ctx({ id: fileId }))],
    ["delete", () => routes.file.DELETE(makeReq("/x", { method: "DELETE", client: mallory }), ctx({ id: fileId }))],
    ["upload status", () => routes.upload.GET(makeReq("/x", { client: mallory }), ctx({ id: uploadId }))],
    ["abort upload", () => routes.upload.DELETE(makeReq("/x", { method: "DELETE", client: mallory }), ctx({ id: uploadId }))],
    ["complete upload", () => routes.complete.POST(makeReq("/x", { method: "POST", client: mallory }), ctx({ id: uploadId }))],
    [
      "inject chunk",
      () =>
        routes.chunk.PUT(
          makeReq("/x", { method: "PUT", client: mallory, headers: { "content-type": "application/octet-stream", "content-length": "800" }, body: new Uint8Array(800) }),
          ctx({ id: uploadId, index: "0" }),
        ),
    ],
  ])("%s -> 404", async (_n, call) => {
    expect((await call()).status).toBe(404);
  });

  it("the list shows only your own files; Alice's data is intact", async () => {
    const theirs = await (await routes.files.GET(makeReq("/api/files", { client: mallory }), ctx({}))).json();
    expect(theirs.files).toEqual([]);
    const hers = await (await routes.files.GET(makeReq("/api/files", { client: alice }), ctx({}))).json();
    expect(hers.files.map((f: { id: string }) => f.id)).toContain(fileId);
    expect((await routes.file.GET(makeReq("/x", { client: alice }), ctx({ id: fileId }))).status).toBe(200);
  });

  it("no identity -> 401; forged or tampered cookie -> 401; no list without identity", async () => {
    const anon = { ip: freshIp() };
    expect((await routes.file.GET(makeReq("/x", { client: anon }), ctx({ id: fileId }))).status).toBe(401);
    const forged = { ip: freshIp(), cookie: `hl_owner=${alice.cookie.split("=")[1].split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` };
    expect((await routes.file.GET(makeReq("/x", { client: forged }), ctx({ id: fileId }))).status).toBe(401);
    const list = await (await routes.files.GET(makeReq("/api/files", { client: anon }), ctx({}))).json();
    expect(list.files).toEqual([]);
  });

  it("dedupe never reveals another identity's files", async () => {
    const probe = await routes.uploads.POST(
      makeReq("/x", { method: "POST", client: mallory, headers: { "content-type": "application/json" }, body: JSON.stringify(planUpload(pdfBytes(500), "guess.pdf")) }),
      ctx({}),
    );
    expect((await probe.json()).status).toBe("open");
  });
});

describe("CSRF and content-type enforcement", () => {
  let c: Client;
  beforeAll(async () => {
    c = await newClient(routes);
  });

  it.each([
    [{ "sec-fetch-site": "cross-site" }],
    [{ "sec-fetch-site": "same-site" }],
    [{ "sec-fetch-site": "", origin: "https://evil.example" }],
  ])("cross-site mutation %j -> 403 before any work", async (h) => {
    const body = JSON.stringify(planUpload(pdfBytes(10), "csrf.pdf"));
    const headers: Record<string, string> = { "content-type": "application/json", ...h };
    if (headers["sec-fetch-site"] === "") delete headers["sec-fetch-site"];
    const req = new Request("http://app.test/api/uploads", { method: "POST", headers: { host: "app.test", "x-hoop-client-ip": c.ip, cookie: c.cookie, ...headers }, body });
    const res = await routes.uploads.POST(req, ctx({}));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("cross_site");
  });

  it("form-encoded bodies (the classic CSRF vector) are refused with 415", async () => {
    const res = await routes.uploads.POST(makeReq("/x", { method: "POST", client: c, headers: { "content-type": "text/plain" }, body: "{}" }), ctx({}));
    expect(res.status).toBe(415);
  });
});

// -------------------------------------------------------------- rate limits

describe("strict rate limits: one test per limit", () => {
  beforeEach(() => resetRateLimits());

  async function hammer(call: () => Promise<Response>, max: number): Promise<{ firstLimitedAt: number; res: Response }> {
    for (let i = 1; i <= max; i++) {
      const res = await call();
      if (res.status === 429) return { firstLimitedAt: i, res };
    }
    throw new Error(`no 429 within ${max} requests`);
  }

  it("global: every API request counts, per address", async () => {
    const ip = freshIp();
    const { firstLimitedAt, res } = await hammer(() => routes.health.GET(makeReq("/api/health", { client: { ip } }), ctx({})), 400);
    expect(firstLimitedAt).toBe(POLICIES.global.capacity + 1);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("mint: at most 5 new identities per address per hour", async () => {
    const ip = freshIp();
    const { firstLimitedAt } = await hammer(() => routes.session.GET(makeReq("/api/session", { client: { ip } }), ctx({})), 20);
    expect(firstLimitedAt).toBe(POLICIES.mint.capacity + 1);
  });

  it.each([
    ["init", POLICIES.init.capacity, (c: Client) => routes.uploads.POST(makeReq("/x", { method: "POST", client: c, headers: { "content-type": "application/json" }, body: "{}" }), ctx({}))],
    ["complete", POLICIES.complete.capacity, (c: Client) => routes.complete.POST(makeReq("/x", { method: "POST", client: c }), ctx({ id: "up_nope000000000000" }))],
    ["read", POLICIES.read.capacity, (c: Client) => routes.files.GET(makeReq("/api/files", { client: c }), ctx({}))],
    ["download", POLICIES.download.capacity, (c: Client) => routes.file.GET(makeReq("/x", { client: c }), ctx({ id: "file_nope0000000000" }))],
    ["mutate", POLICIES.mutate.capacity, (c: Client) => routes.file.DELETE(makeReq("/x", { method: "DELETE", client: c }), ctx({ id: "file_nope0000000000" }))],
    [
      "chunk",
      POLICIES.chunk.capacity,
      (c: Client) =>
        routes.chunk.PUT(
          makeReq("/x", { method: "PUT", client: c, headers: { "content-type": "application/octet-stream", "content-length": "1" }, body: "x" }),
          ctx({ id: "up_nope000000000000", index: "0" }),
        ),
    ],
  ])("%s: refused after %i requests (even when each request fails)", async (_name, capacity, call) => {
    const c = await newClient(routes);
    const { firstLimitedAt, res } = await hammer(() => call(c), capacity + 5);
    expect(firstLimitedAt).toBe(capacity + 1);
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("events: connection attempts are rate-limited", async () => {
    const c = await newClient(routes);
    const opened: AbortController[] = [];
    const { firstLimitedAt } = await hammer(async () => {
      const ac = new AbortController();
      opened.push(ac);
      return routes.events.GET(new Request("http://app.test/api/events", { headers: { "x-hoop-client-ip": c.ip, cookie: c.cookie }, signal: ac.signal }), ctx({}));
    }, 10);
    opened.forEach((a) => a.abort());
    // 4 concurrent connections per identity: the 5th is refused (by the cap or the connect rate).
    expect(firstLimitedAt).toBeLessThanOrEqual(POLICIES.events.capacity + 1);
  });

  it("uploadBytes: the byte budget is charged from Content-Length before streaming", async () => {
    const c = await newClient(routes);
    const res = await routes.chunk.PUT(
      makeReq("/x", { method: "PUT", client: c, headers: { "content-type": "application/octet-stream", "content-length": String(3 * 1024 ** 3) }, body: "x" }),
      ctx({ id: "up_nope000000000000", index: "0" }),
    );
    expect(res.status).toBe(429);
  });

  it("a spoofed X-Forwarded-For buys nothing: limits key on the trusted address only", async () => {
    const ip = freshIp();
    let limited = 0;
    for (let i = 0; i < 80; i++) {
      const res = await routes.files.GET(makeReq("/api/files", { client: { ip }, headers: { "x-forwarded-for": `9.9.${i}.${i}`, "x-real-ip": `8.8.${i}.1` } }), ctx({}));
      if (res.status === 429) limited++;
    }
    expect(limited).toBe(80 - POLICIES.read.capacity);
  });

  it("dropping the cookie does not reset per-identity limits: the address bucket still applies", async () => {
    const ip = freshIp();
    const a = await newClient(routes, ip);
    for (let i = 0; i < POLICIES.read.capacity; i++) await routes.files.GET(makeReq("/api/files", { client: a }), ctx({}));
    const b = await newClient(routes, ip); // new identity, same address
    expect((await routes.files.GET(makeReq("/api/files", { client: b }), ctx({}))).status).toBe(429);
  });
});

describe("health endpoint exposes nothing and cannot be used to wake the database", () => {
  it("public: { ok: true } only, even with ?deep=1", async () => {
    const ip = freshIp();
    expect(await (await routes.health.GET(makeReq("/api/health", { client: { ip } }), ctx({}))).json()).toEqual({ ok: true });
    expect(await (await routes.health.GET(makeReq("/api/health?deep=1", { client: { ip } }), ctx({}))).json()).toEqual({ ok: true });
  });
  it("with the bearer token: details and a deep check", async () => {
    const res = await routes.health.GET(makeReq("/api/health?deep=1", { client: { ip: freshIp() }, headers: { authorization: `Bearer ${"h".repeat(32)}` } }), ctx({}));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, store: "json", db: { ok: true } });
    const wrong = await routes.health.GET(makeReq("/api/health", { client: { ip: freshIp() }, headers: { authorization: `Bearer ${"x".repeat(32)}` } }), ctx({}));
    expect(await wrong.json()).toEqual({ ok: true });
  });
});

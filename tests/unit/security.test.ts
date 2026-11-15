import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsp } from "@/middleware";
import { HttpError } from "@/lib/server/core";
import { UNKNOWN_CLIENT, clientIp, normalizeIp } from "@/lib/server/security/clientIp";
import { assertSameOrigin } from "@/lib/server/security/csrf";
import { newOwnerId, ownerCookie, ownerFromRequest, signOwner, verifyOwner } from "@/lib/server/security/identity";
import { MemoryLimitStore, POLICIES, acquire, effectivePolicy, limit, resetRateLimits } from "@/lib/server/security/rateLimit";
// @ts-expect-error — plain ESM module without type declarations
import { resolveClientIp } from "@/server.mjs";

const SECRET = "s".repeat(48);
beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  resetRateLimits();
});
afterEach(() => vi.unstubAllEnvs());

describe("trusted client address", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2:3:4:5:6", "2001:0db8:0001:0002::/64"],
    ["2001:db8:1:2::99", "2001:0db8:0001:0002::/64"],
    ["[2001:db8::1]", "2001:0db8:0000:0000::/64"],
    ["fe80::1%eth0", "fe80:0000:0000:0000::/64"],
    ["not-an-ip", null],
    ["", null],
  ])("normalizeIp(%j) = %j", (raw, out) => expect(normalizeIp(raw)).toBe(out));

  it("groups a whole IPv6 /64 into one bucket (rotation inside a subnet does not help)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 4, maxLength: 4 }), (tail) => {
        const ip = `2001:db8:aa:bb:${tail.map((x) => x.toString(16)).join(":")}`;
        expect(normalizeIp(ip)).toBe("2001:0db8:00aa:00bb::/64");
      }),
    );
  });

  it("reads ONLY the trusted header, never the client's X-Forwarded-For", () => {
    const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(req({ "x-real-ip": "1.2.3.4" }))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(req({ "x-hoop-client-ip": "5.6.7.8", "x-forwarded-for": "1.2.3.4" }))).toBe("5.6.7.8");
    expect(clientIp(req({ "cf-connecting-ip": "9.9.9.9" }), "cf-connecting-ip")).toBe("9.9.9.9");
    expect(clientIp(req({ "x-hoop-client-ip": "<script>" }))).toBe(UNKNOWN_CLIENT);
  });
});

describe("server.mjs resolveClientIp (proxy-hop trust)", () => {
  it("with no trusted proxies, uses the socket and ignores any forwarded chain", () => {
    expect(resolveClientIp("6.6.6.6, 7.7.7.7", "10.0.0.5", 0)).toBe("10.0.0.5");
    expect(resolveClientIp(undefined, "::ffff:10.0.0.5", 0)).toBe("::ffff:10.0.0.5");
  });
  it("with N trusted proxies, takes the Nth address from the right; spoofed left entries are ignored", () => {
    // client 1.1.1.1 -> proxy A (appends 1.1.1.1) -> us (socket = A)
    expect(resolveClientIp("1.1.1.1", "172.16.0.2", 1)).toBe("1.1.1.1");
    // attacker pre-seeds a fake chain
    expect(resolveClientIp("6.6.6.6, 1.1.1.1", "172.16.0.2", 1)).toBe("1.1.1.1");
    // two proxies: CDN -> LB -> us
    expect(resolveClientIp("6.6.6.6, 1.1.1.1, 104.16.0.1", "172.16.0.2", 2)).toBe("1.1.1.1");
  });
  it("never returns a non-IP", () => {
    expect(resolveClientIp("evil", "garbage", 1)).toBe("");
  });
  it("property: whatever the client prepends, the result is fixed by the trusted suffix", () => {
    fc.assert(
      fc.property(fc.array(fc.ipV4(), { maxLength: 6 }), fc.ipV4(), (spoofed, real) => {
        expect(resolveClientIp([...spoofed, real].join(", "), "172.16.0.2", 1)).toBe(real);
      }),
    );
  });
});

describe("signed anonymous identity", () => {
  it("round-trips and rejects tampering", () => {
    const id = newOwnerId();
    expect(id).toMatch(/^o_[A-Za-z0-9_-]{22}$/);
    const token = signOwner(id);
    expect(verifyOwner(token)).toBe(id);
    const other = newOwnerId();
    expect(verifyOwner(`${other}${token.slice(id.length)}`)).toBeNull(); // swap id, keep sig
    expect(verifyOwner(`${token}x`)).toBeNull();
    expect(verifyOwner(id)).toBeNull();
    expect(verifyOwner("")).toBeNull();
    expect(verifyOwner("x".repeat(500))).toBeNull();
  });

  it("property: random tokens never verify", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (t) => {
        expect(verifyOwner(t)).toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  it("supports secret rotation via SESSION_SECRET_PREVIOUS", () => {
    const id = newOwnerId();
    const old = signOwner(id);
    vi.stubEnv("SESSION_SECRET", "n".repeat(48));
    expect(verifyOwner(old)).toBeNull();
    vi.stubEnv("SESSION_SECRET_PREVIOUS", SECRET);
    expect(verifyOwner(old)).toBe(id);
  });

  it("fails closed in production without a strong secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => signOwner(newOwnerId())).toThrow(HttpError);
    vi.stubEnv("SESSION_SECRET", "short");
    expect(() => signOwner(newOwnerId())).toThrow(HttpError);
  });

  it("cookie is HttpOnly + SameSite=Lax, and __Host- + Secure over HTTPS", () => {
    const id = newOwnerId();
    const http = ownerCookie(new Request("http://x/"), id);
    expect(http).toMatch(/^hl_owner=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    const https = ownerCookie(new Request("http://x/", { headers: { "x-forwarded-proto": "https" } }), id);
    expect(https).toMatch(/^__Host-hl_owner=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    const token = https.split(";")[0].split("=").slice(1).join("=");
    expect(ownerFromRequest(new Request("http://x/", { headers: { cookie: `a=b; __Host-hl_owner=${token}` } }))).toBe(id);
  });
});

describe("CSRF", () => {
  const req = (h: Record<string, string>) => new Request("http://app.test/api/x", { method: "POST", headers: { host: "app.test", ...h } });
  it.each([
    [{ "sec-fetch-site": "same-origin" }, true],
    [{ "sec-fetch-site": "none" }, true],
    [{ "sec-fetch-site": "cross-site" }, false],
    [{ "sec-fetch-site": "same-site" }, false],
    [{ origin: "http://app.test" }, true],
    [{ origin: "https://evil.example" }, false],
    [{ origin: "null" }, false],
    [{}, true], // non-browser client: no ambient cookies to abuse
  ])("%j -> allowed=%s", (h, ok) => {
    if (ok) expect(() => assertSameOrigin(req(h))).not.toThrow();
    else expect(() => assertSameOrigin(req(h))).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe("rate limiter", () => {
  it("charges address AND owner; either bucket empty refuses", () => {
    const cap = POLICIES.mutate.capacity;
    for (let i = 0; i < cap; i++) limit("mutate", { ip: "1.1.1.1", owner: "o_A" });
    // Same owner from a new address: still refused (owner bucket empty).
    expect(() => limit("mutate", { ip: "2.2.2.2", owner: "o_A" })).toThrow(expect.objectContaining({ status: 429 }));
    // Same address with a new identity: still refused (address bucket empty).
    expect(() => limit("mutate", { ip: "1.1.1.1", owner: "o_B" })).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => limit("mutate", { ip: "3.3.3.3", owner: "o_C" })).not.toThrow();
  });

  it("refusals consume nothing (all-or-nothing)", () => {
    const store = new MemoryLimitStore();
    const p = { capacity: 2, refillPerSec: 0, what: "" };
    store.take(["a"], p, 2, 0); // a empty
    expect(store.take(["a", "b"], p, 1, 0).allowed).toBe(false);
    expect(store.take(["b"], p, 2, 0).allowed).toBe(true); // b untouched by the refusal
  });

  it("returns Retry-After and RateLimit headers, and refills over time", () => {
    for (let i = 0; i < POLICIES.init.capacity; i++) limit("init", { ip: "4.4.4.4" }, 1, 0);
    try {
      limit("init", { ip: "4.4.4.4" }, 1, 0);
      expect.unreachable();
    } catch (e) {
      const h = (e as HttpError).headers;
      expect(Number(h["Retry-After"])).toBe(2); // 1 token at 0.5/s
      expect(h["RateLimit-Remaining"]).toBe("0");
      expect(h["RateLimit-Limit"]).toBe(String(POLICIES.init.capacity));
    }
    expect(() => limit("init", { ip: "4.4.4.4" }, 1, 2_001)).not.toThrow();
  });

  it("cost-weighted byte budget: 2 GiB/day per address and owner", () => {
    const GiB = 1024 ** 3;
    limit("uploadBytes", { ip: "5.5.5.5", owner: "o_X" }, 1.5 * GiB, 0);
    expect(() => limit("uploadBytes", { ip: "5.5.5.5", owner: "o_X" }, 0.6 * GiB, 0)).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => limit("uploadBytes", { ip: "5.5.5.5" }, 3 * GiB, 0)).toThrow(/exceeds the allowed budget/);
  });

  it("identity minting is the strictest limit (5 per hour per address)", () => {
    for (let i = 0; i < 5; i++) limit("mint", { ip: "6.6.6.6" }, 1, 0);
    expect(() => limit("mint", { ip: "6.6.6.6" }, 1, 0)).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => limit("mint", { ip: "6.6.6.6" }, 1, 11 * 60_000)).toThrow(); // still < 1 token after 11 min
    expect(() => limit("mint", { ip: "6.6.6.6" }, 1, 13 * 60_000)).not.toThrow();
  });

  it("the multiplier is ignored in production unless explicitly allowed", () => {
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "100");
    vi.stubEnv("NODE_ENV", "production");
    expect(effectivePolicy("init").capacity).toBe(POLICIES.init.capacity);
    vi.stubEnv("ALLOW_RATE_LIMIT_MULTIPLIER", "1");
    expect(effectivePolicy("init").capacity).toBe(POLICIES.init.capacity * 100);
  });

  it("every policy is strict: finite burst and refill, and descriptions for the docs", () => {
    for (const [name, p] of Object.entries(POLICIES)) {
      expect(p.capacity, name).toBeGreaterThan(0);
      expect(p.refillPerSec, name).toBeGreaterThan(0);
      expect(p.what.length, name).toBeGreaterThan(3);
    }
  });
});

describe("concurrency gates", () => {
  it("caps simultaneous holders under every key and releases idempotently", () => {
    const r1 = acquire([["k", 2], ["g", 3]]);
    const r2 = acquire([["k", 2], ["g", 3]]);
    expect(() => acquire([["k", 2], ["g", 3]])).toThrow(expect.objectContaining({ status: 429 }));
    r1();
    r1();
    const r3 = acquire([["k", 2], ["g", 3]]); // k: 2/2, g: 2/3
    const r4 = acquire([["other", 5], ["g", 3]]); // g: 3/3
    expect(() => acquire([["fresh", 5], ["g", 3]])).toThrow(expect.objectContaining({ status: 429 })); // global cap reached
    r2();
    r3();
    r4();
    expect(() => acquire([["k", 2], ["g", 3]])()).not.toThrow();
  });
});

describe("Content-Security-Policy", () => {
  it("production policy: nonce-only scripts, no eval, no framing, no plugins", () => {
    const csp = buildCsp("abc123", false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "upgrade-insecure-requests"]) expect(csp).toContain(d);
  });
  it("dev policy allows eval and HMR websockets only in development", () => {
    expect(buildCsp("n", true)).toMatch(/'unsafe-eval'.*connect-src 'self' ws:/s);
  });
});

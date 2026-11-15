import { HttpError, singleton } from "../core";

/**
 * Strict, layered rate limiting.
 *
 * Every limited request is charged against BOTH its client address and (when
 * known) its owner identity, and is refused if EITHER bucket is empty. Buckets
 * are checked all-or-nothing, so a refused request consumes nothing.
 *
 * Identities can be minted (by deleting the cookie), so minting itself is the
 * strictest limit of all, keyed by address.
 *
 * Store: in-process. That is authoritative for this app's architecture — blob
 * storage is a local disk, so it runs as ONE long-lived Node process
 * (`server.mjs`). `LimitStore` is the seam for a shared (Redis) store when the
 * storage moves to S3 and the app scales out.
 */
const GiB = 1024 ** 3;

export interface Policy {
  capacity: number;
  refillPerSec: number;
  /** Human description, surfaced in SECURITY.md and tests. */
  what: string;
}

export const POLICIES = {
  global: { capacity: 300, refillPerSec: 10, what: "all API requests" },
  mint: { capacity: 5, refillPerSec: 5 / 3600, what: "new anonymous identities (5/hour)" },
  init: { capacity: 20, refillPerSec: 0.5, what: "upload starts" },
  chunk: { capacity: 120, refillPerSec: 8, what: "chunk PUTs (~32 MB/s sustained)" },
  uploadBytes: { capacity: 2 * GiB, refillPerSec: (2 * GiB) / 86_400, what: "uploaded bytes (2 GiB/day)" },
  complete: { capacity: 20, refillPerSec: 0.5, what: "upload completions" },
  read: { capacity: 60, refillPerSec: 3, what: "list and status reads" },
  download: { capacity: 30, refillPerSec: 1, what: "downloads" },
  mutate: { capacity: 10, refillPerSec: 0.2, what: "deletes and aborts" },
  events: { capacity: 5, refillPerSec: 0.1, what: "live-update connections" },
} satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

/** Concurrency caps (simultaneous, not per time). */
export const CONCURRENCY = {
  /** Per identity: a person rarely has more than a few tabs open. */
  sseConnectionsPerOwner: 4,
  /** Per address: generous, because offices and mobile carriers put many people behind one IP (NAT). */
  sseConnectionsPerIp: 50,
  sseConnectionsGlobal: 500,
  chunkWritesPerOwner: 6,
};

export interface Decision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a full bucket. */
  reset: number;
  /** Seconds until this request could succeed (when refused). */
  retryAfter: number;
}

export interface LimitStore {
  take(keys: string[], policy: Policy, cost: number, now: number): Decision;
}

interface Bucket {
  tokens: number;
  updated: number;
}

export class MemoryLimitStore implements LimitStore {
  private buckets = new Map<string, Bucket>();

  take(keys: string[], policy: Policy, cost: number, now: number): Decision {
    const states = keys.map((k) => {
      const b = this.buckets.get(k) ?? { tokens: policy.capacity, updated: now };
      return { k, tokens: Math.min(policy.capacity, b.tokens + (Math.max(0, now - b.updated) / 1000) * policy.refillPerSec) };
    });
    const tightest = Math.min(...states.map((s) => s.tokens));
    const allowed = tightest >= cost;
    for (const s of states) this.buckets.set(s.k, { tokens: allowed ? s.tokens - cost : s.tokens, updated: now });
    if (this.buckets.size > 50_000) this.sweep(now);
    const remaining = Math.max(0, Math.floor(allowed ? tightest - cost : tightest));
    const deficit = allowed ? 0 : cost - tightest;
    return {
      allowed,
      limit: policy.capacity,
      remaining,
      reset: Math.ceil((policy.capacity - (allowed ? tightest - cost : tightest)) / policy.refillPerSec),
      retryAfter: allowed ? 0 : Math.max(1, Math.ceil(deficit / policy.refillPerSec)),
    };
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (now - b.updated > 24 * 3600_000) this.buckets.delete(k);
  }

  clear() {
    this.buckets.clear();
  }
}

const store = singleton("limit-store", () => new MemoryLimitStore());

/** Scales every limit; > 1 only for test environments (never below 1 in production). */
function multiplier(): number {
  const m = Number(process.env.RATE_LIMIT_MULTIPLIER ?? "1");
  if (!Number.isFinite(m) || m <= 0) return 1;
  // Production ignores the multiplier unless explicitly allowed (e.g. e2e runs on a prod build).
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_RATE_LIMIT_MULTIPLIER !== "1") return 1;
  return m;
}

export function effectivePolicy(name: PolicyName): Policy {
  const p = POLICIES[name];
  const m = multiplier();
  return { ...p, capacity: p.capacity * m, refillPerSec: p.refillPerSec * m };
}

export interface Subject {
  ip: string;
  owner?: string | null;
}

/** Charges `cost` against every key of `subject` for `policy`; throws 429 when refused. */
export function limit(name: PolicyName, subject: Subject, cost = 1, now = Date.now()): Decision {
  const policy = effectivePolicy(name);
  const keys = [`${name}|ip|${subject.ip}`];
  if (subject.owner) keys.push(`${name}|own|${subject.owner}`);
  if (cost > policy.capacity) {
    throw new HttpError(429, "rate_limited", "Request exceeds the allowed budget.", { "Retry-After": String(Math.ceil(cost / policy.refillPerSec)) });
  }
  const d = store.take(keys, policy, cost, now);
  if (!d.allowed) {
    console.warn(`[security] rate_limited policy=${name} subject=${subject.owner ? "owner+ip" : "ip"}`);
    throw new HttpError(429, "rate_limited", "Too many requests. Slow down a little.", { ...rateLimitHeaders(d), "Retry-After": String(d.retryAfter) });
  }
  return d;
}

export function rateLimitHeaders(d: Decision): Record<string, string> {
  return { "RateLimit-Limit": String(Math.floor(d.limit)), "RateLimit-Remaining": String(d.remaining), "RateLimit-Reset": String(d.reset) };
}

/** Test hook. */
export function resetRateLimits() {
  store.clear();
  gates.clear();
}

// ------------------------------------------------------------ concurrency

const gates = singleton("concurrency-gates", () => new Map<string, number>());

/** Acquires a slot under every (key, max) pair or throws 429. Returns an idempotent release. */
export function acquire(slots: [key: string, max: number][]): () => void {
  for (const [k, max] of slots) {
    if ((gates.get(k) ?? 0) >= max) {
      throw new HttpError(429, "too_many_concurrent", "Too many simultaneous requests.", { "Retry-After": "2" });
    }
  }
  for (const [k] of slots) gates.set(k, (gates.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const [k] of slots) {
      const n = (gates.get(k) ?? 1) - 1;
      if (n <= 0) gates.delete(k);
      else gates.set(k, n);
    }
  };
}

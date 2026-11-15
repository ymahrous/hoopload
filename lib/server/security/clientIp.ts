import { isIP } from "node:net";

/**
 * Trusted client address for rate limiting.
 *
 * `X-Forwarded-For` from the client is attacker-controlled (Next.js passes it
 * through untouched), so it is never read here. Instead:
 *  - `server.mjs` (the production entry) overwrites `x-hoop-client-ip` on every
 *    request from the socket address, or from a configured number of trusted
 *    proxy hops (TRUST_PROXY_HOPS).
 *  - On a platform that sets its own trusted header (e.g. `cf-connecting-ip`),
 *    set CLIENT_IP_HEADER to that header instead.
 *
 * If no trusted address is present, every such request shares ONE bucket
 * ("unknown"): fail closed, so spoofing can never buy extra quota.
 */
export const TRUSTED_IP_HEADER = "x-hoop-client-ip";
export const UNKNOWN_CLIENT = "unknown";

let warned = false;

export function clientIp(req: Request, headerName = process.env.CLIENT_IP_HEADER || TRUSTED_IP_HEADER): string {
  const raw = req.headers.get(headerName)?.split(",")[0]?.trim();
  const key = raw ? normalizeIp(raw) : null;
  if (!key) {
    if (!warned && process.env.NODE_ENV === "production") {
      warned = true;
      console.warn(`[security] no trusted client IP in "${headerName}"; all such clients share one rate-limit bucket. Start with "node server.mjs" or set CLIENT_IP_HEADER.`);
    }
    return UNKNOWN_CLIENT;
  }
  return key;
}

/**
 * Canonical rate-limit key for an address. IPv4-mapped IPv6 collapses to IPv4,
 * and IPv6 is grouped by /64 — one subscriber typically controls a whole /64,
 * so per-address IPv6 limits would be trivially rotated.
 */
export function normalizeIp(raw: string): string | null {
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v === 6) return `${expandV6(ip).slice(0, 4).join(":")}::/64`;
  return null;
}

function expandV6(ip: string): string[] {
  let s = ip.toLowerCase();
  // Embedded IPv4 tail -> two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = s.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((x) => x.padStart(4, "0"));
}

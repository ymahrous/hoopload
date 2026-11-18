import { timingSafeEqual } from "node:crypto";
import { json } from "@/lib/server/core";
import { subscriberCount } from "@/lib/server/events";
import { secureRoute } from "@/lib/server/security/secureRoute";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const token = process.env.HEALTH_TOKEN;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token || token.length < 16) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Public liveness: `{ ok: true }` and nothing else (no fingerprinting data), and
 * it never touches the database. Details and `?deep=1` (which wakes Neon)
 * require `Authorization: Bearer $HEALTH_TOKEN`.
 */
export const GET = secureRoute({ name: "health", limits: [], identity: "optional" }, async (req) => {
  if (!authorized(req)) return json({ ok: true });
  const base = { ok: true, uptime: Math.round(process.uptime()), liveConnections: subscriberCount(), store: getStore().kind };
  if (new URL(req.url).searchParams.get("deep") !== "1") return json(base);
  const started = performance.now();
  try {
    await getStore().listFiles("__health__", { limit: 1 });
    return json({ ...base, db: { ok: true, ms: Math.round(performance.now() - started) } });
  } catch {
    return json({ ...base, ok: false, db: { ok: false } }, { status: 503 });
  }
});

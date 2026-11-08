import { json } from "@/lib/server/core";
import { newOwnerId, ownerCookie } from "@/lib/server/security/identity";
import { limit } from "@/lib/server/security/rateLimit";
import { secureRoute } from "@/lib/server/security/secureRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/session — ensures this browser has a signed anonymous identity.
 * Minting a new identity is limited per address (5/hour), so deleting the
 * cookie cannot be used to reset per-owner quotas and limits.
 */
export const GET = secureRoute({ name: "session", limits: [], identity: "optional" }, async (req, { ip, owner }) => {
  if (owner) return json({ ok: true, fresh: false });
  limit("mint", { ip });
  const id = newOwnerId();
  return json({ ok: true, fresh: true }, { headers: { "Set-Cookie": ownerCookie(req, id) } });
});

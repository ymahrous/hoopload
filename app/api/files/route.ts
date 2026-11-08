import { json } from "@/lib/server/core";
import { secureRoute } from "@/lib/server/security/secureRoute";
import { uploads } from "@/lib/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/files?limit=100&cursor=… — YOUR files, newest first (empty without an identity). */
export const GET = secureRoute({ name: "files.list", limits: ["read"], identity: "optional" }, async (req, { owner }) => {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const cursor = url.searchParams.get("cursor");
  return json(await uploads().list(owner, { limit: Number.isFinite(limit) ? limit : 100, cursor: cursor && cursor.length <= 100 ? cursor : null }));
});

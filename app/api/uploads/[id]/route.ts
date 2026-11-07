import { json } from "@/lib/server/core";
import { secureRoute } from "@/lib/server/security/secureRoute";
import { uploads } from "@/lib/server/uploads";

export const runtime = "nodejs";
type P = { id: string };

/** GET /api/uploads/:id — which chunks the server already holds (your sessions only). */
export const GET = secureRoute<P>({ name: "uploads.status", limits: ["read"], identity: "required" }, async (_req, { owner, params }) =>
  json(await uploads().status(owner, params.id)),
);

/** DELETE /api/uploads/:id — abort and discard staged chunks. */
export const DELETE = secureRoute<P>({ name: "uploads.abort", limits: ["mutate"], mutating: true, identity: "required" }, async (_req, { owner, params }) => {
  await uploads().abort(owner, params.id);
  return new Response(null, { status: 204 });
});

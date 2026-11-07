import { json } from "@/lib/server/core";
import { secureRoute } from "@/lib/server/security/secureRoute";
import { uploads } from "@/lib/server/uploads";

export const runtime = "nodejs";
type P = { id: string };

/** POST /api/uploads/:id/complete — assemble, sniff, publish. Idempotent. */
export const POST = secureRoute<P>({ name: "uploads.complete", limits: ["complete"], mutating: true, identity: "required" }, async (_req, { owner, params }) =>
  json({ file: await uploads().complete(owner, params.id) }),
);

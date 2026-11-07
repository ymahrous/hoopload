import { json, readJson } from "@/lib/server/core";
import { secureRoute } from "@/lib/server/security/secureRoute";
import { uploads } from "@/lib/server/uploads";
import type { InitUploadRequest } from "@/lib/shared/protocol";

export const runtime = "nodejs";

/** POST /api/uploads — start, resume, or dedupe (within your own files) an upload. */
export const POST = secureRoute({ name: "uploads.init", limits: ["init"], mutating: true, identity: "required" }, async (req, { owner }) => {
  const result = await uploads().init(owner, await readJson<Partial<InitUploadRequest>>(req));
  return json(result, { status: result.status === "complete" ? 200 : 201 });
});

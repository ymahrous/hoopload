import { HttpError, json } from "@/lib/server/core";
import { secureRoute } from "@/lib/server/security/secureRoute";
import { uploads } from "@/lib/server/uploads";

export const runtime = "nodejs";
type P = { id: string; index: string };

const declaredLength = (req: Request) => {
  const v = req.headers.get("content-length");
  return v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null;
};

/**
 * PUT /api/uploads/:id/chunks/:index — raw bytes, streamed to storage while
 * hashed. Charged against the per-request AND per-byte (2 GiB/day) budgets.
 */
export const PUT = secureRoute<P>(
  {
    name: "uploads.chunk",
    limits: ["chunk"],
    mutating: true,
    identity: "required",
    cost: { policy: "uploadBytes", of: (req) => declaredLength(req) ?? 0 },
  },
  async (req, { owner, params }) => {
    const type = req.headers.get("content-type");
    if (type !== "application/octet-stream") {
      await req.body?.cancel().catch(() => {});
      throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/octet-stream.");
    }
    if (!/^\d{1,6}$/.test(params.index)) throw new HttpError(400, "bad_index", "Chunk index out of range.");
    const result = await uploads().putChunk(owner, params.id, Number(params.index), req.body, declaredLength(req));
    return json(result, { status: result.duplicate ? 200 : 201 });
  },
);

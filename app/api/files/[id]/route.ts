import { contentDisposition } from "@/lib/server/names";
import { parseRange } from "@/lib/server/range";
import { secureRoute } from "@/lib/server/security/secureRoute";
import { getStorage, objectKeyFor } from "@/lib/server/storage";
import { uploads } from "@/lib/server/uploads";

export const runtime = "nodejs";
type P = { id: string };

/**
 * GET /api/files/:id — your file only. Streamed, Range-capable, strong ETag.
 * Always an inert attachment: nosniff + sandbox CSP + noindex, never cached by
 * shared caches (private, varies by cookie).
 */
export const GET = secureRoute<P>({ name: "files.download", limits: ["download"], identity: "required" }, async (req, { owner, params }) => {
  const file = await uploads().getFile(owner, params.id);
  const etag = `"${file.fingerprint}"`;
  const base: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, no-cache",
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });

  const headers: Record<string, string> = {
    ...base,
    "Content-Type": file.mime,
    "Content-Disposition": contentDisposition(file.name),
    "Accept-Ranges": "bytes",
  };
  const key = objectKeyFor(file.fingerprint);
  const range = parseRange(req.headers.get("range"), file.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${file.size}` } });
  if (range) {
    const { stream } = await getStorage().open(key, range);
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`, "Content-Length": String(range.end - range.start + 1) },
    });
  }
  const { stream, size } = await getStorage().open(key);
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
});

export const DELETE = secureRoute<P>({ name: "files.delete", limits: ["mutate"], mutating: true, identity: "required" }, async (_req, { owner, params }) => {
  await uploads().remove(owner, params.id);
  return new Response(null, { status: 204 });
});

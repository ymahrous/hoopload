import { CHUNK_SIZE, type FileRecord, type InitUploadResponse } from "@/lib/shared/protocol";
import { chunkOf, planUpload } from "./fixtures";

/**
 * Drives real route handlers the way server.mjs would deliver requests:
 * a trusted `x-hoop-client-ip`, the identity cookie, and same-origin fetch metadata.
 */
export const BASE = "http://app.test";
type Handler = (req: Request, ctx: { params: Promise<never> }) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

export interface Client {
  ip: string;
  cookie: string;
}

let ipSeq = 0;
export const freshIp = () => `10.${(++ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;

export function makeReq(path: string, opts: { method?: string; client?: Partial<Client>; headers?: Record<string, string>; body?: BodyInit | null } = {}) {
  const headers: Record<string, string> = { host: "app.test", "sec-fetch-site": "same-origin", ...opts.headers };
  if (opts.client?.ip) headers["x-hoop-client-ip"] = opts.client.ip;
  if (opts.client?.cookie) headers.cookie = opts.client.cookie;
  return new Request(`${BASE}${path}`, { method: opts.method ?? "GET", headers, body: opts.body ?? null, duplex: "half" } as RequestInit);
}

export const ctx = <P>(params: P) => ({ params: Promise.resolve(params) }) as { params: Promise<never> };

export async function newClient(routes: Routes, ip = freshIp()): Promise<Client> {
  const res = await routes.session.GET(makeReq("/api/session", { client: { ip } }), ctx({}));
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error(`no cookie (status ${res.status})`);
  return { ip, cookie: set.split(";")[0] };
}

export async function uploadVia(routes: Routes, c: Client, bytes: Buffer, name: string): Promise<FileRecord> {
  const init = (await (
    await routes.uploads.POST(
      makeReq("/api/uploads", { method: "POST", client: c, headers: { "content-type": "application/json" }, body: JSON.stringify(planUpload(bytes, name)) }),
      ctx({}),
    )
  ).json()) as InitUploadResponse;
  if (init.status === "complete") return init.file;
  for (let i = 0; i < init.totalChunks; i++) {
    const body = chunkOf(bytes, i);
    const r = await routes.chunk.PUT(
      makeReq(`/api/uploads/${init.uploadId}/chunks/${i}`, {
        method: "PUT",
        client: c,
        headers: { "content-type": "application/octet-stream", "content-length": String(body.length) },
        body: new Uint8Array(body),
      }),
      ctx({ id: init.uploadId, index: String(i) }),
    );
    if (r.status !== 201) throw new Error(`chunk ${i}: ${r.status} ${await r.text()}`);
  }
  const done = await routes.complete.POST(makeReq(`/x`, { method: "POST", client: c }), ctx({ id: init.uploadId }));
  return ((await done.json()) as { file: FileRecord }).file;
}

export const ONE_CHUNK = CHUNK_SIZE;

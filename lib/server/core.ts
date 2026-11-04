import "server-only";
import path from "node:path";

/** Process-wide singletons that survive Next.js dev hot reloads. */
export function singleton<T>(key: string, make: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>;
  const k = `__hoopload_${key}`;
  if (g[k] === undefined) g[k] = make();
  return g[k] as T;
}

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), ".data"));

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json<T>(data: T, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers ?? {}) },
  });
}

/** Parses a JSON body. Requires `Content-Type: application/json` (blocks form-based CSRF) and caps size. */
export async function readJson<T>(req: Request, maxBytes = 32 * 1024): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "payload_too_large", "Request body too large.");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "payload_too_large", "Request body too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Body must be valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "bad_json", "Body must be a JSON object.");
  return value as T;
}

/** Serialises async critical sections (single-process lock). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

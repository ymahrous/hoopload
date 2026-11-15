import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HttpError, UPLOAD_DIR } from "../core";

/**
 * Anonymous per-browser identity: a random owner id in an HMAC-signed,
 * HttpOnly, SameSite=Lax cookie. Every file and upload session is scoped to
 * its owner, so one visitor can never list, read, resume or delete another's.
 *
 * Secrets: SESSION_SECRET (>= 32 chars) is required in production (fail closed).
 * SESSION_SECRET_PREVIOUS is also accepted for verification, for rotation.
 * In development a random secret is persisted in UPLOAD_DIR/.session-secret.
 */
export const COOKIE_SECURE = "__Host-hl_owner";
export const COOKIE_PLAIN = "hl_owner";
const MAX_AGE = 60 * 60 * 24 * 365;
const OWNER_RE = /^o_[A-Za-z0-9_-]{22}$/;

let devSecret: string | null = null;

function secrets(): string[] {
  const current = process.env.SESSION_SECRET;
  const previous = process.env.SESSION_SECRET_PREVIOUS;
  if (current) {
    if (current.length < 32) throw new HttpError(500, "misconfigured", "Server misconfigured.");
    return previous && previous.length >= 32 ? [current, previous] : [current];
  }
  if (process.env.NODE_ENV === "production") {
    console.error("[security] SESSION_SECRET is not set; refusing to issue or verify identities.");
    throw new HttpError(500, "misconfigured", "Server misconfigured.");
  }
  if (!devSecret) {
    const file = path.join(UPLOAD_DIR, ".session-secret");
    try {
      devSecret = fs.readFileSync(file, "utf8").trim();
    } catch {
      devSecret = randomBytes(32).toString("base64url");
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(file, devSecret, { mode: 0o600 });
    }
  }
  return [devSecret];
}

const mac = (secret: string, id: string) => createHmac("sha256", secret).update(`hoopload:owner:v1:${id}`).digest("base64url");

export function signOwner(id: string): string {
  return `${id}.${mac(secrets()[0], id)}`;
}

export function verifyOwner(token: string | undefined | null): string | null {
  if (!token || token.length > 128) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  if (!OWNER_RE.test(id)) return null;
  for (const s of secrets()) {
    const expected = Buffer.from(mac(s, id));
    if (expected.length === sig.length && timingSafeEqual(expected, sig)) return id;
  }
  return null;
}

export function newOwnerId(): string {
  return `o_${randomBytes(16).toString("base64url")}`;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function ownerFromRequest(req: Request): string | null {
  return verifyOwner(readCookie(req, COOKIE_SECURE)) ?? verifyOwner(readCookie(req, COOKIE_PLAIN));
}

export function isHttps(req: Request): boolean {
  return (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
}

/** `__Host-` prefix (Secure, Path=/, no Domain) whenever served over HTTPS. */
export function ownerCookie(req: Request, id: string): string {
  const secure = isHttps(req);
  const name = secure ? COOKIE_SECURE : COOKIE_PLAIN;
  return `${name}=${signOwner(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

import { HttpError } from "../core";

/**
 * CSRF defence for state-changing requests (defence in depth on top of
 * SameSite=Lax cookies). Browsers always send Sec-Fetch-Site and/or Origin on
 * cross-site POST/PUT/DELETE, so anything not same-origin is refused.
 * Requests with neither header come from non-browser clients, which carry no
 * ambient cookies to abuse.
 */
export function assertSameOrigin(req: Request): void {
  const site = req.headers.get("sec-fetch-site");
  if (site) {
    if (site === "same-origin" || site === "none") return;
    throw new HttpError(403, "cross_site", "Cross-site requests are not allowed.");
  }
  const origin = req.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "cross_site", "Cross-site requests are not allowed.");
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  if (originHost !== host) throw new HttpError(403, "cross_site", "Cross-site requests are not allowed.");
}

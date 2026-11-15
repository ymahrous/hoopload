import { HttpError, json } from "../core";
import { clientIp } from "./clientIp";
import { assertSameOrigin } from "./csrf";
import { ownerFromRequest } from "./identity";
import { limit, rateLimitHeaders, type Decision, type PolicyName } from "./rateLimit";

/**
 * The ONLY way to define an API handler. Every request passes through the same
 * pipeline, in this order:
 *
 *   1. trusted client address            (never the client's X-Forwarded-For)
 *   2. global per-address limit           (cheap flood guard, before any parsing)
 *   3. CSRF check for state-changing verbs
 *   4. identity from the signed cookie    (401 when the route requires one)
 *   5. per-route limits, charged against address AND owner
 *   6. the handler, with a typed context
 *   7. uniform error mapping + RateLimit-* headers
 *
 * `tests/integration/security.test.ts` enumerates every exported route handler
 * and fails if one was not built with `secureRoute`.
 */

export const SECURE_ROUTE = Symbol.for("hoopload.secureRoute");

export interface SecureRouteOptions {
  name: string;
  limits: PolicyName[];
  /** POST/PUT/PATCH/DELETE: enforces same-origin. */
  mutating?: boolean;
  /** "required": 401 without a valid identity cookie. "optional": handler gets null. */
  identity: "required" | "optional";
  /** Extra cost for a policy, derived from the request (e.g. bytes). Charged after the base limits. */
  cost?: { policy: PolicyName; of: (req: Request) => number };
}

export interface SecureContext<P> {
  ip: string;
  owner: string | null;
  params: P;
}

export interface RequiredContext<P> extends SecureContext<P> {
  owner: string;
}

export type RouteHandler<P> = ((req: Request, ctx: { params: Promise<P> }) => Promise<Response>) & { [SECURE_ROUTE]?: SecureRouteOptions };

export function secureRoute<P = Record<string, never>>(
  opts: SecureRouteOptions & { identity: "required" },
  handler: (req: Request, ctx: RequiredContext<P>) => Promise<Response>,
): RouteHandler<P>;
export function secureRoute<P = Record<string, never>>(
  opts: SecureRouteOptions & { identity: "optional" },
  handler: (req: Request, ctx: SecureContext<P>) => Promise<Response>,
): RouteHandler<P>;
export function secureRoute<P>(opts: SecureRouteOptions, handler: (req: Request, ctx: never) => Promise<Response>): RouteHandler<P> {
  const wrapped: RouteHandler<P> = async (req, nextCtx) => {
    const started = performance.now();
    let status = 500;
    let decision: Decision | null = null;
    try {
      const ip = clientIp(req);
      limit("global", { ip });
      if (opts.mutating) assertSameOrigin(req);

      const owner = ownerFromRequest(req);
      if (opts.identity === "required" && !owner) throw new HttpError(401, "no_session", "Session missing or invalid. Reload the page.");

      for (const name of opts.limits) decision = limit(name, { ip, owner }) ?? decision;
      if (opts.cost) {
        const c = opts.cost.of(req);
        if (c > 0) limit(opts.cost.policy, { ip, owner }, c);
      }

      const params = (nextCtx?.params ? await nextCtx.params : {}) as P;
      const res = await handler(req, { ip, owner, params } as never);
      status = res.status;
      if (decision) for (const [k, v] of Object.entries(rateLimitHeaders(decision))) if (!res.headers.has(k)) res.headers.set(k, v);
      return res;
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        return json({ error: { code: err.code, message: err.message } }, { status: err.status, headers: err.headers });
      }
      console.error(`[${opts.name}] unhandled`, err);
      return json({ error: { code: "internal", message: "Something went wrong." } }, { status: 500 });
    } finally {
      if (process.env.NODE_ENV !== "test") console.log(`${req.method} ${opts.name} ${status} ${(performance.now() - started).toFixed(1)}ms`);
    }
  };
  wrapped[SECURE_ROUTE] = opts;
  return wrapped;
}

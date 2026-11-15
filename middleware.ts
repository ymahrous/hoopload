import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce Content-Security-Policy for HTML pages.
 *
 * Scripts run only with this request's nonce ('strict-dynamic' lets Next's
 * nonce'd loader pull in its own chunks), so injected markup cannot execute
 * script even if an XSS bug slipped in. Next.js reads the nonce from the
 * request's CSP header and applies it to its scripts automatically.
 *
 * Note: middleware only sets headers here. It is NOT an auth boundary (see
 * CVE-2025-29927); every API route enforces its own checks via secureRoute.
 */
export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // React's style={{…}} attributes are applied via CSSOM at runtime; SSR emits a
    // few style="" attributes, which need 'unsafe-inline' (styles cannot run code).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|icon.svg|apple-icon|opengraph-image|robots.txt|sitemap.xml|manifest.webmanifest|llms).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

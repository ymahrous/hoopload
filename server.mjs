#!/usr/bin/env node
/**
 * Production entry point: `node server.mjs` (npm start).
 *
 * Why a custom server: Next.js passes the client's own X-Forwarded-For through
 * untouched, so route handlers cannot tell a real address from a spoofed one.
 * Here we see the TCP socket, so we:
 *   1. derive the client address from the socket, or from exactly
 *      TRUST_PROXY_HOPS trusted reverse proxies in front of us;
 *   2. overwrite `x-hoop-client-ip` (the only header the rate limiter reads)
 *      and strip anything a client sent under that name;
 *   3. set socket-level timeouts and caps against slowloris and header floods.
 */
import http from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export const TRUSTED_IP_HEADER = "x-hoop-client-ip";

/**
 * Client address given the X-Forwarded-For chain and the socket peer.
 * Each trusted proxy APPENDS the address it received from, so with `hops`
 * trusted proxies the client is the `hops`-th entry from the right of
 * [...xff, socketPeer]. Anything further left is client-controlled and ignored.
 */
export function resolveClientIp(xff, socketAddr, hops) {
  const chain = [
    ...(typeof xff === "string" ? xff.split(",").map((s) => s.trim()).filter(Boolean) : []),
    socketAddr ?? "",
  ];
  const n = Math.max(0, Math.min(Number.isInteger(hops) ? hops : 0, 10));
  const candidate = chain[chain.length - 1 - n] ?? chain[0];
  const bare = candidate?.replace(/^\[|\](:\d+)?$/g, "").replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");
  return bare && isIP(bare.split("%")[0]) ? bare : "";
}

async function main() {
  const { default: next } = await import("next");
  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOSTNAME ?? "0.0.0.0";
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  const dev = process.env.NODE_ENV === "development";

  if (!dev && !process.env.SESSION_SECRET) {
    console.error("[security] SESSION_SECRET must be set (>= 32 random chars). Generate one: openssl rand -base64 48");
    process.exit(1);
  }

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = http.createServer(
    {
      maxHeaderSize: 16 * 1024, // header-flood cap
      requestTimeout: 120_000, // whole request incl. body (a 4 MiB chunk needs far less)
      headersTimeout: 15_000, // slowloris: headers must arrive quickly
      keepAliveTimeout: 5_000,
    },
    (req, res) => {
      // Never trust a client-supplied value for our internal header.
      delete req.headers[TRUSTED_IP_HEADER];
      const ip = resolveClientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress, hops);
      if (ip) req.headers[TRUSTED_IP_HEADER] = ip;
      if (hops === 0) {
        // Not behind a proxy: forwarded headers are attacker-controlled. Replace them.
        req.headers["x-forwarded-for"] = ip;
        delete req.headers["x-forwarded-host"];
        delete req.headers["x-forwarded-proto"];
      }
      handle(req, res);
    },
  );
  server.maxConnections = Number(process.env.MAX_CONNECTIONS ?? 2000);
  server.maxRequestsPerSocket = 1000;

  server.listen(port, hostname, () => {
    console.log(`> Hoopload ready on http://${hostname}:${port} (trusted proxy hops: ${hops})`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

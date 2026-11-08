import { subscribe } from "@/lib/server/events";
import { CONCURRENCY, acquire } from "@/lib/server/security/rateLimit";
import { secureRoute } from "@/lib/server/security/secureRoute";
import type { FeedEvent } from "@/lib/shared/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONNECTION_MS = 30 * 60 * 1000;

/**
 * GET /api/events — Server-Sent Events of YOUR file activity only.
 * Long-lived connections are a DoS vector, so they are capped per client and
 * globally, rate-limited on connect, and recycled after 30 minutes (the
 * browser reconnects transparently).
 */
export const GET = secureRoute({ name: "events", limits: ["events"], identity: "required" }, async (req, { ip, owner }) => {
  const release = acquire([
    [`sse|ip|${ip}`, CONCURRENCY.sseConnectionsPerIp],
    [`sse|own|${owner}`, CONCURRENCY.sseConnectionsPerOwner],
    ["sse|global", CONCURRENCY.sseConnectionsGlobal],
  ]);
  const encoder = new TextEncoder();
  let cleanup = () => release();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: FeedEvent) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      controller.enqueue(encoder.encode("retry: 5000\n\n"));
      send({ type: "hello", at: Date.now() });

      const unsubscribe = subscribe(owner, send);
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);
      const lifetime = setTimeout(() => cleanup(), MAX_CONNECTION_MS);

      cleanup = () => {
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        release();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

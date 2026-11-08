import "server-only";
import { EventEmitter } from "node:events";
import type { FeedEvent } from "@/lib/shared/protocol";
import { singleton } from "./core";

/**
 * In-process pub/sub. Events carry their owner; the SSE route delivers each
 * event ONLY to connections of that owner. For multiple instances, back this
 * with Redis pub/sub (avoid Postgres LISTEN/NOTIFY: it keeps Neon awake).
 */
export interface OwnedEvent {
  owner: string;
  event: FeedEvent;
}

const bus = singleton("event-bus", () => {
  const e = new EventEmitter();
  e.setMaxListeners(10_000);
  return e;
});

export function publish(owner: string, event: FeedEvent): void {
  bus.emit("event", { owner, event } satisfies OwnedEvent);
}

export function subscribe(owner: string, fn: (event: FeedEvent) => void): () => void {
  const listener = (e: OwnedEvent) => {
    if (e.owner === owner) fn(e.event);
  };
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

export function subscriberCount(): number {
  return bus.listenerCount("event");
}

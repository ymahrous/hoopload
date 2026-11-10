"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { FeedEvent, FileRecord, FilesResponse } from "@/lib/shared/protocol";
import { ensureSession } from "./session";
import { getUploadManager, type UploadItem } from "./uploadManager";

const EMPTY: UploadItem[] = [];
const noopSubscribe = () => () => {};

export function useUploads(): UploadItem[] {
  const m = typeof window === "undefined" ? null : getUploadManager();
  return useSyncExternalStore(m?.subscribe ?? noopSubscribe, m?.getSnapshot ?? (() => EMPTY), () => EMPTY);
}

/** Server file list, kept live across tabs and devices via Server-Sent Events. */
export function useFilesFeed() {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      if (res.ok) setFiles(((await res.json()) as FilesResponse).files);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    // Identity first: the file list and the event stream are both per-owner.
    void ensureSession()
      .then(() => {
        if (closed) return;
        void refresh();
        es = connect();
      })
      .catch(() => setLoaded(true));
    return () => {
      closed = true;
      es?.close();
    };
  }, [refresh]);

  function connect(): EventSource {
    const es = new EventSource("/api/events");
    const onEvent = (e: MessageEvent<string>) => {
      const evt = JSON.parse(e.data) as FeedEvent;
      if (evt.type === "file.created") setFiles((prev) => (prev.some((f) => f.id === evt.file.id) ? prev : [evt.file, ...prev]));
      else if (evt.type === "file.deleted") setFiles((prev) => prev.filter((f) => f.id !== evt.id));
    };
    es.addEventListener("file.created", onEvent);
    es.addEventListener("file.deleted", onEvent);
    es.addEventListener("hello", () => {
      setConnected(true);
      void refresh(); // re-sync anything missed while disconnected
    });
    es.onerror = () => setConnected(false);
    return es;
  }

  const remove = useCallback(async (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id)); // optimistic
    const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) void refresh();
  }, [refresh]);

  const bytes = files.reduce((n, f) => n + f.size, 0);
  return { files, bytes, connected, loaded, remove };
}

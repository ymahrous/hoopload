"use client";

import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  expectedChunkBytes,
  type ApiErrorBody,
  type CompleteResponse,
  type FileRecord,
  type InitUploadResponse,
} from "@/lib/shared/protocol";
import { ensureSession } from "./session";

export type UploadStatus = "queued" | "hashing" | "uploading" | "finalizing" | "done" | "error" | "canceled";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  mime: string;
  status: UploadStatus;
  /** 0..1 of the current phase (hashing or transfer). */
  progress: number;
  bytesPerSec: number;
  deduped: boolean;
  resumed: boolean;
  error?: string;
  file?: FileRecord;
  addedAt: number;
}

interface Internal extends UploadItem {
  blob: File;
  abort: AbortController;
  uploadId?: string;
}

class RetryableError extends Error {
  constructor(message: string, public retryAfterMs?: number) {
    super(message);
  }
}
class AbortedError extends Error {}

const MAX_PARALLEL_FILES = 2;
const MAX_PARALLEL_CHUNKS = 3;
const MAX_ATTEMPTS = 6;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AbortedError("aborted"));
    }, { once: true });
  });

/** Exponential backoff with full jitter; honours Retry-After. */
async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new AbortedError("aborted");
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= MAX_ATTEMPTS - 1) throw err;
      const backoff = err.retryAfterMs ?? Math.random() * Math.min(8000, 400 * 2 ** attempt);
      await sleep(backoff, signal);
    }
  }
}

function classify(status: number, body: string, retryAfter: string | null): Error {
  let message = `HTTP ${status}`;
  try {
    message = (JSON.parse(body) as ApiErrorBody).error.message;
  } catch {}
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
  // 408/429/5xx are transient; 422 = chunk corrupted in transit, so resend.
  if (status === 0 || status === 408 || status === 422 || status === 429 || status >= 500 || (status === 409 && retryAfter)) return new RetryableError(message, retryAfterMs);
  return new Error(message);
}

async function fetchJson<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  return withRetry(async () => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      if (signal.aborted) throw new AbortedError("aborted");
      throw new RetryableError((e as Error).message);
    }
    const text = await res.text();
    if (!res.ok) throw classify(res.status, text, res.headers.get("retry-after"));
    return JSON.parse(text) as T;
  }, signal);
}

/** fetch() has no upload progress events, so chunk PUTs use XHR. */
function xhrPut(url: string, body: Blob, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(classify(xhr.status, xhr.responseText, xhr.getResponseHeader("retry-after"))));
    xhr.onerror = () => reject(new RetryableError("Network error"));
    xhr.ontimeout = () => reject(new RetryableError("Timed out"));
    xhr.timeout = 120_000;
    const onAbort = () => {
      xhr.abort();
      reject(new AbortedError("aborted"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

type HashResult = { hashes: string[]; fingerprint: string };

/**
 * Client-side upload orchestrator.
 *  - Bounded concurrency at two levels (files, and chunks per file).
 *  - Hashing in a Web Worker; chunk-level integrity verified by the server.
 *  - Resumable: the server reports which chunks it already holds.
 *  - Exposes an immutable snapshot for React's useSyncExternalStore.
 */
export class UploadManager {
  private items = new Map<string, Internal>();
  private order: string[] = [];
  private listeners = new Set<() => void>();
  private snapshot: UploadItem[] = [];
  private active = 0;
  private emitScheduled = false;
  private worker: Worker | null = null;
  private hashJobs = new Map<string, { resolve: (r: HashResult) => void; reject: (e: Error) => void; onProgress: (p: number) => void }>();
  private seq = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  add(blob: File): string {
    const id = `u${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const item: Internal = {
      id,
      blob,
      name: blob.name || "untitled",
      size: blob.size,
      mime: blob.type,
      status: "queued",
      progress: 0,
      bytesPerSec: 0,
      deduped: false,
      resumed: false,
      addedAt: Date.now(),
      abort: new AbortController(),
    };
    if (blob.size === 0) Object.assign(item, { status: "error", error: "File is empty." });
    else if (blob.size > MAX_FILE_SIZE) Object.assign(item, { status: "error", error: `Over the ${MAX_FILE_SIZE / 1024 / 1024} MB limit.` });
    this.items.set(id, item);
    this.order.unshift(id);
    this.emit(true);
    this.pump();
    return id;
  }

  cancel(id: string) {
    const it = this.items.get(id);
    if (!it || it.status === "done" || it.status === "canceled") return;
    it.abort.abort();
    if (it.status === "queued") this.patch(it, { status: "canceled" });
    if (it.uploadId) void fetch(`/api/uploads/${it.uploadId}`, { method: "DELETE" }).catch(() => {});
  }

  retry(id: string) {
    const it = this.items.get(id);
    if (!it || (it.status !== "error" && it.status !== "canceled") || it.blob.size === 0 || it.blob.size > MAX_FILE_SIZE) return;
    it.abort = new AbortController();
    this.patch(it, { status: "queued", error: undefined, progress: 0 });
    this.pump();
  }

  dismiss(id: string) {
    const it = this.items.get(id);
    if (!it) return;
    if (it.status !== "done" && it.status !== "error" && it.status !== "canceled") return;
    this.items.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit(true);
  }

  clearFinished() {
    for (const id of [...this.order]) {
      const s = this.items.get(id)?.status;
      if (s === "done" || s === "canceled") this.dismiss(id);
    }
  }

  // ---------------------------------------------------------------- internals

  private patch(it: Internal, p: Partial<Internal>, immediate = true) {
    Object.assign(it, p);
    this.emit(immediate);
  }

  /** Progress updates are coalesced to one emit per animation frame. */
  private emit(immediate = false) {
    const flush = () => {
      this.emitScheduled = false;
      this.snapshot = this.order.map((id) => {
        const { blob: _b, abort: _a, uploadId: _u, ...pub } = this.items.get(id)!;
        return pub;
      });
      this.listeners.forEach((l) => l());
    };
    if (immediate) return flush();
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    requestAnimationFrame(flush);
  }

  private pump() {
    while (this.active < MAX_PARALLEL_FILES) {
      // FIFO: oldest queued first (order is newest-first).
      const next = [...this.order].reverse().map((id) => this.items.get(id)!).find((i) => i.status === "queued");
      if (!next) return;
      this.active++;
      void this.run(next).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(it: Internal) {
    const signal = it.abort.signal;
    try {
      this.patch(it, { status: "hashing", progress: 0 });
      await ensureSession();
      const { hashes, fingerprint } = await this.hash(it.blob, (p) => this.patch(it, { progress: p }, false));
      if (signal.aborted) throw new AbortedError("aborted");

      const init = await fetchJson<InitUploadResponse>(
        "/api/uploads",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: it.name, size: it.size, type: it.mime, chunkSize: CHUNK_SIZE, chunkHashes: hashes, fingerprint }),
        },
        signal,
      );

      if (init.status === "complete") {
        this.patch(it, { status: "done", progress: 1, deduped: true, file: init.file });
        return;
      }

      it.uploadId = init.uploadId;
      const have = new Set(init.received);
      this.patch(it, { status: "uploading", progress: 0, resumed: have.size > 0 });
      await this.uploadChunks(it, init.totalChunks, have, signal);

      this.patch(it, { status: "finalizing", progress: 1 });
      const done = await fetchJson<CompleteResponse>(`/api/uploads/${init.uploadId}/complete`, { method: "POST" }, signal);
      this.patch(it, { status: "done", progress: 1, file: done.file, bytesPerSec: 0 });
    } catch (err) {
      if (err instanceof AbortedError || signal.aborted) this.patch(it, { status: "canceled" });
      else this.patch(it, { status: "error", error: (err as Error).message || "Upload failed" });
    }
  }

  private async uploadChunks(it: Internal, total: number, have: Set<number>, signal: AbortSignal) {
    const pending = Array.from({ length: total }, (_, i) => i).filter((i) => !have.has(i));
    let committed = [...have].reduce((n, i) => n + expectedChunkBytes(it.size, i), 0);
    const inflight = new Map<number, number>();
    let lastT = performance.now();
    let lastBytes = committed;

    const report = () => {
      let sent = committed;
      inflight.forEach((v) => (sent += v));
      const now = performance.now();
      if (now - lastT > 250) {
        const inst = ((sent - lastBytes) / (now - lastT)) * 1000;
        it.bytesPerSec = it.bytesPerSec ? it.bytesPerSec * 0.7 + inst * 0.3 : inst;
        lastT = now;
        lastBytes = sent;
      }
      this.patch(it, { progress: Math.min(1, sent / it.size) }, false);
    };

    const worker = async () => {
      for (let idx = pending.shift(); idx !== undefined; idx = pending.shift()) {
        const i = idx;
        const blob = it.blob.slice(i * CHUNK_SIZE, Math.min(it.size, (i + 1) * CHUNK_SIZE));
        await withRetry(async () => {
          inflight.set(i, 0);
          try {
            await xhrPut(`/api/uploads/${it.uploadId}/chunks/${i}`, blob, signal, (loaded) => {
              inflight.set(i, loaded);
              report();
            });
          } finally {
            inflight.delete(i);
          }
        }, signal);
        committed += blob.size;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHUNKS, pending.length) }, worker));
  }

  private hash(file: File, onProgress: (p: number) => void): Promise<HashResult> {
    if (!this.worker) {
      this.worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: string; type: string; value?: number; hashes?: string[]; fingerprint?: string; message?: string }>) => {
        const job = this.hashJobs.get(e.data.id);
        if (!job) return;
        if (e.data.type === "progress") job.onProgress(e.data.value ?? 0);
        else if (e.data.type === "done") {
          this.hashJobs.delete(e.data.id);
          job.resolve({ hashes: e.data.hashes!, fingerprint: e.data.fingerprint! });
        } else {
          this.hashJobs.delete(e.data.id);
          job.reject(new Error(e.data.message ?? "Hashing failed"));
        }
      };
    }
    const id = `h${this.seq++}`;
    return new Promise((resolve, reject) => {
      this.hashJobs.set(id, { resolve, reject, onProgress });
      this.worker!.postMessage({ id, file, chunkSize: CHUNK_SIZE });
    });
  }
}

let instance: UploadManager | null = null;
export function getUploadManager(): UploadManager {
  if (!instance) instance = new UploadManager();
  return instance;
}

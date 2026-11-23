#!/usr/bin/env node
/**
 * Load test: N virtual users each upload M unique files through the full
 * protocol (init -> parallel chunk PUTs -> complete), then re-upload one to
 * exercise the dedupe path. Fails (exit 1) if SLO thresholds are missed.
 *
 *   TRUST_PROXY_HOPS=1 SESSION_SECRET=… node server.mjs &
 *   BASE_URL=http://localhost:3000 VUS=8 FILES=3 SIZE_MB=6 node tests/load/load-test.mjs
 *
 * Each VU is a distinct client: run the server with TRUST_PROXY_HOPS=1 so this
 * script acts as the trusted proxy (its X-Forwarded-For is honoured), and each
 * VU gets its own identity cookie from /api/session — exactly like a browser.
 */
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const VUS = Number(process.env.VUS ?? 8);
const FILES = Number(process.env.FILES ?? 3);
const SIZE = Number(process.env.SIZE_MB ?? 6) * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const SLO = { p95ChunkMs: Number(process.env.SLO_P95_CHUNK_MS ?? 1500), p95InitMs: 500, maxErrorRate: 0.01 };
/** EXPECT_LIMITED=1: the scenario is abusive on purpose, and passing means the server pushed back with 429s. */
const expectLimited = process.env.EXPECT_LIMITED === "1";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const lat = { session: [], init: [], chunk: [], complete: [] };
let errors = 0;
let limited = 0;
let requests = 0;
let bytes = 0;

async function timed(kind, fn) {
  const t = performance.now();
  requests++;
  try {
    const res = await fn();
    if (res.status === 429) limited++;
    else if (!res.ok) {
      errors++;
      console.error(kind, res.status, await res.clone().text());
    }
    return res;
  } finally {
    lat[kind].push(performance.now() - t);
  }
}

async function uploadOne(buf, name, headers) {
  const hashes = [];
  for (let i = 0; i < Math.ceil(buf.length / CHUNK); i++) hashes.push(sha(buf.subarray(i * CHUNK, (i + 1) * CHUNK)));
  const body = { name, size: buf.length, type: "application/pdf", chunkSize: CHUNK, chunkHashes: hashes, fingerprint: sha(`${buf.length}:${hashes.join(",")}`) };
  const init = await (await timed("init", () => fetch(`${BASE}/api/uploads`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }))).json();
  if (!init.status) return;
  if (init.status === "complete") return;
  const pending = hashes.map((_, i) => i).filter((i) => !init.received.includes(i));
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let i = pending.shift(); i !== undefined; i = pending.shift()) {
        const part = buf.subarray(i * CHUNK, (i + 1) * CHUNK);
        await timed("chunk", () =>
          fetch(`${BASE}/api/uploads/${init.uploadId}/chunks/${i}`, { method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, body: part }),
        );
        bytes += part.length;
      }
    }),
  );
  await timed("complete", () => fetch(`${BASE}/api/uploads/${init.uploadId}/complete`, { method: "POST", headers }));
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const started = performance.now();
await Promise.all(
  Array.from({ length: VUS }, async (_, vu) => {
    const ip = { "x-forwarded-for": `198.51.100.${vu + 1}` };
    const s = await timed("session", () => fetch(`${BASE}/api/session`, { headers: ip }));
    const headers = { ...ip, cookie: (s.headers.get("set-cookie") ?? "").split(";")[0] };
    let last;
    for (let f = 0; f < FILES; f++) {
      last = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(SIZE)]);
      await uploadOne(last, `load-${vu}-${f}.pdf`, headers);
    }
    await uploadOne(last, `load-${vu}-${FILES - 1}.pdf`, headers); // dedupe hit
  }),
);
const secs = (performance.now() - started) / 1000;

const row = (k) => `${k.padEnd(9)} n=${String(lat[k].length).padStart(4)}  p50=${pct(lat[k], 50).toFixed(0).padStart(5)}ms  p95=${pct(lat[k], 95).toFixed(0).padStart(5)}ms  p99=${pct(lat[k], 99).toFixed(0).padStart(5)}ms`;
console.log(`\n${VUS} VUs × ${FILES} files × ${(SIZE / 1048576).toFixed(0)} MB against ${BASE}`);
console.log(["session", "init", "chunk", "complete"].map(row).join("\n"));
const errRate = errors / requests;
console.log(`throughput ${(bytes / 1048576 / secs).toFixed(1)} MB/s · ${requests} requests in ${secs.toFixed(1)}s · error rate ${(errRate * 100).toFixed(2)}% · rate-limited ${limited}`);

const failed = [];
if (pct(lat.chunk, 95) > SLO.p95ChunkMs) failed.push(`chunk p95 > ${SLO.p95ChunkMs}ms`);
if (pct(lat.init, 95) > SLO.p95InitMs) failed.push(`init p95 > ${SLO.p95InitMs}ms`);
if (errRate > SLO.maxErrorRate) failed.push(`error rate > ${SLO.maxErrorRate * 100}%`);
if (expectLimited && limited === 0) failed.push("abusive scenario was never rate-limited");
if (!expectLimited && limited > 0) failed.push(`${limited} legitimate requests were rate-limited`);
if (failed.length) {
  console.error(`SLO FAILED: ${failed.join("; ")}`);
  process.exit(1);
}
console.log("SLOs met ✓");

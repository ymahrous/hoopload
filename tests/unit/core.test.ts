import { describe, expect, it, vi } from "vitest";
import { HttpError, Mutex, json, readJson } from "@/lib/server/core";
import { TtlLru } from "@/lib/server/lru";
import { decodeCursor, encodeCursor } from "@/lib/server/store/types";

describe("HttpError", () => {
  it("is recognised across separately bundled copies of the module", async () => {
    vi.resetModules();
    const other = await import("@/lib/server/core");
    expect(other.HttpError).not.toBe(HttpError);
    const err = new other.HttpError(400, "empty_body", "Chunk body is required.");
    expect(err instanceof HttpError).toBe(true);
    expect(new HttpError(404, "x", "y") instanceof other.HttpError).toBe(true);
  });

  it("does not match plain errors", () => {
    expect(new Error("nope") instanceof HttpError).toBe(false);
    expect((null as unknown as object) instanceof HttpError).toBe(false);
  });
});

describe("json()", () => {
  it("disables caching", () => {
    expect(json({ a: 1 }).headers.get("cache-control")).toBe("no-store");
  });
});

describe("readJson", () => {
  const req = (body: string, len?: string, type = "application/json") =>
    new Request("http://x/", { method: "POST", body, headers: { "content-type": type, ...(len ? { "content-length": len } : {}) } });
  it("parses", async () => expect(await readJson(req('{"a":1}'))).toEqual({ a: 1 }));
  it("rejects bad JSON with 400", async () => expect(readJson(req("{"))).rejects.toMatchObject({ status: 400 }));
  it("requires application/json (blocks form-encoded CSRF payloads) with 415", async () => {
    await expect(readJson(req('{"a":1}', undefined, "text/plain"))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(req('{"a":1}', undefined, "application/x-www-form-urlencoded"))).rejects.toMatchObject({ status: 415 });
    expect(await readJson(req('{"a":1}', undefined, "application/json; charset=utf-8"))).toEqual({ a: 1 });
  });
  it("accepts only JSON objects", async () => {
    await expect(readJson(req("[1,2]"))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(req("null"))).rejects.toMatchObject({ status: 400 });
  });
  it("rejects large bodies with 413", async () => {
    await expect(readJson(req("x".repeat(20), "999999"), 10)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(req("x".repeat(20)), 10)).rejects.toMatchObject({ status: 413 });
  });
});

describe("Mutex", () => {
  it("serialises critical sections and survives failures", async () => {
    const m = new Mutex();
    const log: string[] = [];
    const task = (n: string, ms: number, fail = false) =>
      m.run(async () => {
        log.push(`start ${n}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${n}`);
        if (fail) throw new Error(n);
      });
    const results = await Promise.allSettled([task("a", 20, true), task("b", 1), task("c", 5)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});

describe("TtlLru", () => {
  it("expires, evicts least-recently-used and refreshes on read", () => {
    let t = 0;
    const c = new TtlLru<string, number>(2, 100, () => t);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1); // a is now most recent
    c.set("c", 3); // evicts b
    expect(c.get("b")).toBeUndefined();
    expect(c.size).toBe(2);
    t = 150;
    expect(c.get("a")).toBeUndefined();
    c.set("d", 4, 1000);
    c.delete("d");
    expect(c.get("d")).toBeUndefined();
    c.clear();
    expect(c.size).toBe(0);
  });
});

describe("cursors", () => {
  it("round-trips and rejects junk", () => {
    const c = encodeCursor({ id: "file_abc-1", name: "", size: 1, mime: "", fingerprint: "", createdAt: 1764000000000 });
    expect(decodeCursor(c)).toEqual({ createdAt: 1764000000000, id: "file_abc-1" });
    expect(decodeCursor("1_' OR 1=1 --")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});

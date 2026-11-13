import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseRange } from "@/lib/server/range";

describe("parseRange", () => {
  it.each([
    [null, 100, null],
    ["bytes=0-9", 100, { start: 0, end: 9 }],
    ["bytes=90-", 100, { start: 90, end: 99 }],
    ["bytes=-10", 100, { start: 90, end: 99 }],
    ["bytes=-500", 100, { start: 0, end: 99 }],
    ["bytes=50-5000", 100, { start: 50, end: 99 }],
    ["bytes=100-", 100, "invalid"],
    ["bytes=9-0", 100, "invalid"],
    ["bytes=-0", 100, "invalid"],
    ["bytes=-", 100, "invalid"],
    ["bytes=0-1,5-6", 100, "invalid"],
    ["items=0-1", 100, "invalid"],
  ] as const)("%s of %d", (h, size, out) => expect(parseRange(h, size)).toEqual(out));

  it("property: every accepted range lies within the file", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.option(fc.nat(2e9)), fc.option(fc.nat(2e9)), (size, a, z) => {
        const header = `bytes=${a ?? ""}-${z ?? ""}`;
        const r = parseRange(header, size);
        if (r && r !== "invalid") {
          expect(r.start).toBeGreaterThanOrEqual(0);
          expect(r.end).toBeLessThan(size);
          expect(r.start).toBeLessThanOrEqual(r.end);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

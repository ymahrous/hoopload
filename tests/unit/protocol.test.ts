import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, MAX_FILE_SIZE, expectedChunkBytes, fingerprintInput, totalChunksFor } from "@/lib/shared/protocol";

describe("protocol", () => {
  it("counts chunks", () => {
    expect(totalChunksFor(1)).toBe(1);
    expect(totalChunksFor(CHUNK_SIZE)).toBe(1);
    expect(totalChunksFor(CHUNK_SIZE + 1)).toBe(2);
    expect(totalChunksFor(MAX_FILE_SIZE)).toBe(MAX_FILE_SIZE / CHUNK_SIZE);
  });

  it("fingerprint input is order- and size-sensitive", () => {
    expect(fingerprintInput(3, ["a", "b"])).toBe("3:a,b");
    expect(fingerprintInput(3, ["b", "a"])).not.toBe(fingerprintInput(3, ["a", "b"]));
    expect(fingerprintInput(4, ["a", "b"])).not.toBe(fingerprintInput(3, ["a", "b"]));
  });

  it("property: chunk sizes always sum to the file size, and only the last chunk may be short", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_FILE_SIZE }), (size) => {
        const n = totalChunksFor(size);
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const b = expectedChunkBytes(size, i);
          expect(b).toBeGreaterThan(0);
          if (i < n - 1) expect(b).toBe(CHUNK_SIZE);
          sum += b;
        }
        expect(sum).toBe(size);
      }),
      { numRuns: 300 },
    );
  });
});

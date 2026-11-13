import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/server/core";
import { contentDisposition, sanitizeName } from "@/lib/server/names";

describe("sanitizeName", () => {
  it.each([
    ["report.pdf", "report.pdf"],
    ["  spaced  .txt ", "spaced  .txt"],
    ["../../etc/passwd", ".._.._etc_passwd"],
    ["C:\\Windows\\evil.dll", "C:_Windows_evil.dll"],
    ["a\u0000b\u001fc", "abc"],
    ["invoice\u202Efdp.exe", "invoicefdp.exe"],
    ["cafe\u0301.txt", "café.txt"],
  ])("%j -> %j", (input, out) => expect(sanitizeName(input)).toBe(out));

  it.each([[""], ["   "], ["."], [".."], ["..."], [42], [null]])("rejects %j", (input) => {
    expect(() => sanitizeName(input)).toThrow(HttpError);
  });

  it("clips to 200 code points without splitting surrogate pairs", () => {
    const out = sanitizeName("😀".repeat(300));
    expect(Array.from(out)).toHaveLength(200);
    expect(out.endsWith("😀")).toBe(true);
  });

  it("property: output never contains separators or control characters", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 400 }), (s) => {
        let out: string;
        try {
          out = sanitizeName(s);
        } catch {
          return;
        }
        expect(out).not.toMatch(/[\\/\u0000-\u001f\u007f\u202a-\u202e]/);
        expect(Array.from(out).length).toBeLessThanOrEqual(200);
        expect(out.length).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("contentDisposition", () => {
  it("has an ASCII fallback and an RFC 5987 UTF-8 name", () => {
    expect(contentDisposition('résumé "final".pdf')).toBe(
      `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
  });

  it("property: header value is always printable ASCII (no header injection)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), (s) => {
        expect(contentDisposition(s)).toMatch(/^[\x20-\x7e]*$/);
      }),
    );
  });
});

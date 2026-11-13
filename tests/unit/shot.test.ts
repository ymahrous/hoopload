import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GRAVITY, STEP, samplePath, solveShot } from "@/lib/game/shot";

/**
 * Where the engine's own integrator (same step, same scheme) crosses y = targetY
 * while falling, linearly interpolated between steps.
 */
function downwardCrossing(from: { x: number; y: number }, v: { x: number; y: number }, targetY: number) {
  const pts = [from, ...samplePath(from, v, 1200, STEP)];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.y < targetY && b.y >= targetY) {
      const t = (targetY - a.y) / (b.y - a.y);
      return { x: a.x + (b.x - a.x) * t, y: targetY };
    }
  }
  return null;
}

describe("solveShot", () => {
  it("rises above the rim before dropping through it", () => {
    const from = { x: 80, y: 700 };
    const rim = { x: 640, y: 260 };
    const v = solveShot(from, rim, 150);
    expect(v.y).toBeLessThan(0);
    const apexY = Math.min(...samplePath(from, v, 600).map((p) => p.y));
    expect(Math.abs(apexY - (rim.y - 150))).toBeLessThan(1.5);
    const hit = downwardCrossing(from, v, rim.y)!;
    expect(Math.abs(hit.x - rim.x)).toBeLessThan(1);
  });

  // Regression: before compensating for the integrator, long cross-court shots
  // (e.g. [1851, 694] -> [100, 191]) landed >10 px off-centre.
  it("property: from anywhere on the floor, the assisted shot enters the rim within ±2 px", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 1900 }),
        fc.integer({ min: 300, max: 1000 }),
        fc.integer({ min: 100, max: 1800 }),
        fc.integer({ min: 80, max: 400 }),
        (fx, fy, rx, ry) => {
          const v = solveShot({ x: fx, y: fy }, { x: rx, y: ry });
          const hit = downwardCrossing({ x: fx, y: fy }, v, ry);
          expect(hit).not.toBeNull();
          expect(Math.abs(hit!.x - rx)).toBeLessThan(2);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

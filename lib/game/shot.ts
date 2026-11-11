/**
 * Pure ballistics shared by the engine and its tests. Units: px, px/s, px/s².
 * Screen space: +y is down.
 */
export const GRAVITY = 2300;
/** Physics step used by the engine (fixed 120 Hz). */
export const STEP = 1 / 120;

export interface Vec {
  x: number;
  y: number;
}

/**
 * Launch velocity for a shot that rises `apex` px above the target, then falls
 * through it. Rising above first means the ball enters the rim moving downward,
 * which is what counts as a make.
 */
export function solveShot(from: Vec, target: Vec, apex = 150, g = GRAVITY, dt = STEP): Vec {
  const rise = Math.max(40, from.y - target.y + apex);
  const vy = -Math.sqrt(2 * g * rise);
  const flightTime = -vy / g + Math.sqrt((2 * apex) / g);
  // The engine integrates with semi-implicit Euler (v += g·dt; p += v·dt), whose
  // positions equal the exact parabola launched with vy + g·dt/2. Pre-compensate
  // so the simulated ball follows the analytic path exactly at every step.
  return { x: (target.x - from.x) / flightTime, y: vy - (g * dt) / 2 };
}

/** Samples a ballistic path (no collisions) — used for the aim guide and tests. */
export function samplePath(from: Vec, v: Vec, steps: number, dt = STEP, g = GRAVITY): Vec[] {
  const out: Vec[] = [];
  let { x, y } = from;
  let { x: vx, y: vy } = v;
  for (let i = 0; i < steps; i++) {
    vy += g * dt;
    x += vx * dt;
    y += vy * dt;
    out.push({ x, y });
  }
  return out;
}

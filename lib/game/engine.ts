import { GRAVITY, STEP as PHYSICS_STEP, solveShot } from "./shot";

/**
 * HoopEngine — a small, framework-agnostic 2D physics engine for the court.
 *
 *  - Fixed-timestep integration (120 Hz) decoupled from the render rate.
 *  - DOM nodes for the file "balls" (crisp text and icons, GPU transforms),
 *    two canvases for everything around them: back (rim back + shadows) and
 *    front (net, rim front, trajectory, particles), so a ball reads as going
 *    *through* the hoop.
 *  - Verlet-integrated net that the ball physically pushes through.
 *  - React only mounts/unmounts balls; positions never go through React state.
 */

export interface EngineCallbacks {
  onShot(id: string): void;
  onScore(id: string, dunk: boolean): void;
  onMiss(id: string): void;
  onGone(id: string): void;
  onHot(hot: boolean): void;
}

export type AttachIntent = { mode: "rest"; x?: number } | { mode: "dunk"; x?: number; stack?: number };

type Mode = "rest" | "aim" | "flying" | "scored" | "returning" | "gone";

interface Ball {
  id: string;
  el: HTMLElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  av: number;
  mode: Mode;
  restX: number;
  restY: number;
  opacity: number;
  dunk: boolean;
  airTime: number;
  shownMode: Mode | null;
  aim?: { sx: number; sy: number; ax: number; ay: number; dx: number; dy: number; pointerId: number };
  ret?: { fx: number; fy: number; fa: number; t: number };
  listeners: Array<[string, EventListener]>;
}

interface NetPoint {
  x: number;
  y: number;
  px: number;
  py: number;
  rx: number;
  ry: number;
  pinned: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  color: string;
}

const G = GRAVITY;
const R = 24; // collision radius
const HALF_W = 28;
const HALF_H = 34;
const LABEL = 20;
const RIM_R = 5;
const MAX_PULL = 170;
/** Shortest full-power pull, so aiming stays precise in very short windows. */
const MIN_PULL = 80;
/** Share of a full pull, straight down, that a make from the floor needs. */
const MAKE_PULL = 0.8;
const STEP = PHYSICS_STEP;
const NET_COLS = 9;
const NET_ROWS = 6;
const NET_H = 92;
const SLOT_W = 96;
const SLOT_H = 104;

const RIM = "#e8622c";
const RIM_DARK = "#c24a1a";

export class HoopEngine {
  private balls = new Map<string, Ball>();
  private order: string[] = [];
  private raf = 0;
  private last = 0;
  private acc = 0;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private rimL = 0;
  private rimR = 0;
  private rimY = 0;
  private floorY = 0;
  private floorL = 0;
  private floorR = 0;
  private power = 10;
  private maxPull = MAX_PULL;
  private net: NetPoint[][] = [];
  private particles: Particle[] = [];
  private floaters: Array<{ x: number; y: number; t: number }> = [];
  private hot = false;
  private hotUntil = 0;
  private ro: ResizeObserver;
  private reduced: boolean;
  private bctx: CanvasRenderingContext2D;
  private fctx: CanvasRenderingContext2D;

  constructor(
    private stage: HTMLElement,
    private back: HTMLCanvasElement,
    private front: HTMLCanvasElement,
    private rimEl: HTMLElement,
    private floorEl: HTMLElement,
    private cb: EngineCallbacks,
  ) {
    this.bctx = back.getContext("2d")!;
    this.fctx = front.getContext("2d")!;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(stage);
    this.ro.observe(rimEl);
    this.measure();
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const id of [...this.balls.keys()]) this.detach(id);
  }

  // ------------------------------------------------------------------ public

  attach(id: string, el: HTMLElement, intent: AttachIntent) {
    const existing = this.balls.get(id);
    if (existing) {
      existing.el = el;
      return;
    }
    const b: Ball = {
      id, el, x: 0, y: 0, vx: 0, vy: 0, a: 0, av: 0, mode: "rest",
      restX: 0, restY: 0, opacity: 1, dunk: false, airTime: 0, shownMode: null, listeners: [],
    };
    this.balls.set(id, b);
    this.order.push(id);
    this.layoutSlots();

    if (intent.mode === "dunk") {
      const cx = (this.rimL + this.rimR) / 2;
      const span = (this.rimR - this.rimL) / 2 - R - RIM_R - 4;
      const x0 = intent.x === undefined ? cx : Math.min(cx + span, Math.max(cx - span, intent.x));
      Object.assign(b, { x: x0, y: this.rimY - 150 - (intent.stack ?? 0) * 120, vx: 0, vy: -150, av: (Math.random() - 0.5) * 6, mode: "flying", dunk: true });
      this.layoutSlots();
    } else {
      // Enter from the drop point (or from the left edge) and glide into the slot.
      b.x = intent.x ?? -HALF_W * 2;
      b.y = b.restY;
      b.mode = "returning";
      b.ret = { fx: b.x, fy: b.y - 60, fa: -0.6, t: 0 };
    }

    const on = (type: string, fn: EventListener) => {
      el.addEventListener(type, fn);
      b.listeners.push([type, fn]);
    };
    on("pointerdown", ((e: PointerEvent) => this.onDown(b, e)) as EventListener);
    on("pointermove", ((e: PointerEvent) => this.onMove(b, e)) as EventListener);
    on("pointerup", ((e: PointerEvent) => this.onUp(b, e, false)) as EventListener);
    on("pointercancel", ((e: PointerEvent) => this.onUp(b, e, true)) as EventListener);
    on("keydown", ((e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.autoShoot(id);
      }
    }) as EventListener);
    this.render(b);
  }

  detach(id: string) {
    const b = this.balls.get(id);
    if (!b) return;
    for (const [t, fn] of b.listeners) b.el.removeEventListener(t, fn);
    this.balls.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.layoutSlots();
  }

  /** Computes a launch that peaks above the rim and drops through its centre. */
  autoShoot(id: string) {
    const b = this.balls.get(id);
    if (!b || (b.mode !== "rest" && b.mode !== "returning")) return;
    if (b.mode === "returning") {
      // Still gliding in (e.g. a fast keyboard user): shoot from its resting slot.
      b.x = b.restX;
      b.y = b.restY;
      b.a = 0;
      b.ret = undefined;
    }
    const cx = (this.rimL + this.rimR) / 2 + (Math.random() - 0.5) * 10;
    const v = solveShot({ x: b.x, y: b.y }, { x: cx, y: this.rimY });
    this.launch(b, v.x, v.y);
  }

  shootAll() {
    const ready = this.order.map((id) => this.balls.get(id)!).filter((b) => b.mode === "rest");
    ready.forEach((b, i) => setTimeout(() => this.autoShoot(b.id), i * 220));
  }

  /** True if a client point (e.g. a drop) is inside the stage's dropzone area. */
  stagePoint(clientX: number, clientY: number) {
    const r = this.stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  // ----------------------------------------------------------------- layout

  private measure() {
    const s = this.stage.getBoundingClientRect();
    const r = this.rimEl.getBoundingClientRect();
    const f = this.floorEl.getBoundingClientRect();
    this.W = s.width;
    this.H = s.height;
    this.rimL = r.left - s.left;
    this.rimR = r.right - s.left;
    this.rimY = r.top - s.top + r.height / 2;
    this.floorY = f.top - s.top;
    this.floorL = f.left - s.left;
    this.floorR = f.right - s.left;

    const vNeed = Math.sqrt(2 * G * Math.max(200, this.groundY() - this.rimY + 220));
    // The pointer cannot travel past the bottom of the stage, so a full pull must
    // fit in the room below a resting ball; otherwise shots can't reach the rim.
    const room = this.H - this.groundY() - 6;
    this.maxPull = Math.min(MAX_PULL, Math.max(MIN_PULL, room / MAKE_PULL));
    this.power = (vNeed * 1.3) / this.maxPull;

    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.back, this.front]) {
      c.width = Math.round(this.W * this.dpr);
      c.height = Math.round(this.H * this.dpr);
      c.style.width = `${this.W}px`;
      c.style.height = `${this.H}px`;
    }
    this.buildNet();
    this.layoutSlots();
  }

  private groundY() {
    return this.floorY - HALF_H - LABEL;
  }

  private layoutSlots() {
    const width = Math.max(SLOT_W, this.floorR - this.floorL);
    const perRow = Math.max(1, Math.floor(width / SLOT_W));
    let k = 0;
    for (const id of this.order) {
      const b = this.balls.get(id)!;
      if (b.dunk || b.mode === "scored" || b.mode === "gone") continue;
      const row = Math.floor(k / perRow);
      const col = k % perRow;
      b.restX = this.floorL + SLOT_W / 2 + col * SLOT_W;
      b.restY = this.groundY() - row * SLOT_H;
      k++;
    }
  }

  private buildNet() {
    const cx = (this.rimL + this.rimR) / 2;
    const w = this.rimR - this.rimL;
    this.net = [];
    for (let r = 0; r < NET_ROWS; r++) {
      const t = r / (NET_ROWS - 1);
      const taper = 1 - 0.4 * t;
      const row: NetPoint[] = [];
      for (let c = 0; c < NET_COLS; c++) {
        const u = c / (NET_COLS - 1) - 0.5;
        const x = cx + u * w * taper;
        const y = this.rimY + 3 + t * NET_H + Math.sin(u * Math.PI + Math.PI / 2) * 4 * t;
        row.push({ x, y, px: x, py: y, rx: x, ry: y, pinned: r === 0 });
      }
      this.net.push(row);
    }
  }

  // ---------------------------------------------------------------- input

  private local(e: PointerEvent) {
    const s = this.stage.getBoundingClientRect();
    return { x: e.clientX - s.left, y: e.clientY - s.top };
  }

  private onDown(b: Ball, e: PointerEvent) {
    if (b.mode !== "rest" && b.mode !== "returning") return;
    if (e.button !== 0) return;
    e.preventDefault();
    b.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    b.mode = "aim";
    b.ret = undefined;
    b.aim = { sx: p.x, sy: p.y, ax: b.x, ay: b.y, dx: 0, dy: 0, pointerId: e.pointerId };
  }

  private onMove(b: Ball, e: PointerEvent) {
    if (b.mode !== "aim" || !b.aim || e.pointerId !== b.aim.pointerId) return;
    const p = this.local(e);
    let dx = p.x - b.aim.sx;
    let dy = p.y - b.aim.sy;
    const len = Math.hypot(dx, dy);
    if (len > this.maxPull) {
      dx = (dx / len) * this.maxPull;
      dy = (dy / len) * this.maxPull;
    }
    b.aim.dx = dx;
    b.aim.dy = dy;
    // Keep the file on screen while aiming, however far the pointer travels.
    b.x = Math.min(this.W - HALF_W, Math.max(HALF_W, b.aim.ax + dx));
    b.y = Math.min(this.H - HALF_H - 4, Math.max(HALF_H, b.aim.ay + dy));
    b.a = Math.atan2(dy, dx) * 0.08;
  }

  private onUp(b: Ball, e: PointerEvent, cancelled: boolean) {
    if (b.mode !== "aim" || !b.aim || e.pointerId !== b.aim.pointerId) return;
    const { dx, dy } = b.aim;
    b.aim = undefined;
    const pull = Math.hypot(dx, dy);
    if (cancelled) return this.sendHome(b);
    if (pull < 12) {
      // A tap is an auto-shot: friendly on touch screens and for first-timers.
      b.mode = "rest";
      return this.autoShoot(b.id);
    }
    this.launch(b, -dx * this.power, -dy * this.power);
  }

  private launch(b: Ball, vx: number, vy: number) {
    Object.assign(b, { vx, vy, av: vx * 0.006 + (Math.random() - 0.5), mode: "flying", airTime: 0 });
    b.ret = undefined;
    this.cb.onShot(b.id);
  }

  private sendHome(b: Ball) {
    b.mode = "returning";
    b.ret = { fx: b.x, fy: b.y, fa: b.a, t: 0 };
  }

  // -------------------------------------------------------------- simulate

  private tick = (t: number) => {
    const dt = Math.min(0.05, this.last ? (t - this.last) / 1000 : 0);
    this.last = t;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.step(STEP);
      this.acc -= STEP;
    }
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private step(dt: number) {
    for (const b of this.balls.values()) {
      switch (b.mode) {
        case "flying":
          this.stepFlying(b, dt);
          break;
        case "scored":
          this.stepScored(b, dt);
          break;
        case "returning": {
          const r = b.ret!;
          r.t = Math.min(1, r.t + dt / 0.5);
          const e = 1 - Math.pow(1 - r.t, 3);
          b.x = r.fx + (b.restX - r.fx) * e;
          b.y = r.fy + (b.restY - r.fy) * e - Math.sin(r.t * Math.PI) * 26;
          b.a = r.fa * (1 - e);
          if (r.t >= 1) b.mode = "rest";
          break;
        }
        case "rest": {
          const k = Math.min(1, dt * 10);
          b.x += (b.restX - b.x) * k;
          b.y += (b.restY - b.y) * k;
          b.a += (0 - b.a) * k;
          break;
        }
      }
    }
    this.stepNet(dt);
    this.stepParticles(dt);
  }

  private stepFlying(b: Ball, dt: number) {
    b.airTime += dt;
    const py = b.y;
    b.vy += G * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.av * dt;

    // Rim ends are solid circles, but only for a falling ball. In this front-on
    // view a rising ball passes in front of the hoop, so shots from right
    // under the basket (common on narrow phones) are not unfairly blocked.
    for (const ex of b.vy > 0 ? [this.rimL, this.rimR] : []) {
      const dx = b.x - ex;
      const dy = b.y - this.rimY;
      const d = Math.hypot(dx, dy);
      const min = R + RIM_R;
      if (d < min && d > 0.0001) {
        const nx = dx / d;
        const ny = dy / d;
        b.x = ex + nx * min;
        b.y = this.rimY + ny * min;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= 1.55 * vn * nx;
          b.vy -= 1.55 * vn * ny;
          b.vx *= 0.92;
          b.av += (b.vx * ny - b.vy * nx) * 0.01;
        }
      }
    }

    const inSpan = b.x > this.rimL + 2 && b.x < this.rimR - 2;
    if (py < this.rimY && b.y >= this.rimY && b.vy > 0 && inSpan) {
      b.mode = "scored";
      this.layoutSlots();
      this.celebrate();
      this.cb.onScore(b.id, b.dunk);
      return;
    }

    if (b.x < HALF_W) {
      b.x = HALF_W;
      b.vx = Math.abs(b.vx) * 0.6;
    } else if (b.x > this.W - HALF_W) {
      b.x = this.W - HALF_W;
      b.vx = -Math.abs(b.vx) * 0.6;
    }

    const ground = this.groundY();
    if (b.y > ground) {
      b.y = ground;
      if (b.vy > 0) {
        b.vy = -b.vy * 0.42;
        b.vx *= 0.78;
        b.av = b.vx / R;
      }
      if (Math.abs(b.vy) < 140) b.vy = 0;
    }
    if (b.vy === 0 && b.y >= ground - 0.5) {
      b.vx *= 1 - 6 * dt;
      b.av = b.vx / R;
    }
    const settled = b.vy === 0 && Math.abs(b.vx) < 40 && b.y >= ground - 0.5;
    if (settled || b.airTime > 6) {
      this.cb.onMiss(b.id);
      this.sendHome(b);
    }
  }

  private stepScored(b: Ball, dt: number) {
    const cx = (this.rimL + this.rimR) / 2;
    b.vy += G * dt;
    if (b.y < this.rimY + NET_H + 10) {
      // Net friction: slow the drop and funnel toward the centre.
      b.vy = Math.min(b.vy, 420);
      b.vx += (cx - b.x) * 40 * dt;
      b.vx *= 1 - 7 * dt;
      b.av *= 1 - 4 * dt;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.av * dt;
    if (b.y > this.rimY + NET_H + 18) b.opacity -= dt * 3.2;
    if (b.opacity <= 0 || b.y > this.H + 80) {
      b.opacity = 0;
      b.mode = "gone";
      this.cb.onGone(b.id);
    }
  }

  private stepNet(dt: number) {
    const rows = this.net;
    if (!rows.length) return;
    const g = 900 * dt * dt;
    for (const row of rows)
      for (const p of row) {
        if (p.pinned) continue;
        const vx = (p.x - p.px) * 0.93;
        const vy = (p.y - p.py) * 0.93;
        p.px = p.x;
        p.py = p.y;
        p.x += vx + (p.rx - p.x) * 0.05;
        p.y += vy + g + (p.ry - p.y) * 0.05;
      }

    // Balls push the mesh aside.
    for (const b of this.balls.values()) {
      if (b.mode !== "flying" && b.mode !== "scored") continue;
      if (b.y < this.rimY - R || b.y > this.rimY + NET_H + R) continue;
      for (const row of rows)
        for (const p of row) {
          if (p.pinned) continue;
          const dx = p.x - b.x;
          const dy = p.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < R && d > 0.001) {
            p.x = b.x + (dx / d) * R;
            p.y = b.y + (dy / d) * R;
          }
        }
    }

    // Constraint relaxation keeps strands near their rest length.
    for (let it = 0; it < 3; it++) {
      for (let r = 0; r < rows.length; r++)
        for (let c = 0; c < NET_COLS; c++) {
          const p = rows[r][c];
          if (c + 1 < NET_COLS) this.relax(p, rows[r][c + 1]);
          if (r + 1 < rows.length) this.relax(p, rows[r + 1][c]);
        }
    }
  }

  private relax(a: NetPoint, b: NetPoint) {
    const rest = Math.hypot(a.rx - b.rx, a.ry - b.ry);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    const diff = (d - rest) / d;
    if (diff <= 0) return; // strings, not rods: only resist stretching
    const wa = a.pinned ? 0 : b.pinned ? 1 : 0.5;
    const wb = b.pinned ? 0 : a.pinned ? 1 : 0.5;
    a.x += dx * diff * wa;
    a.y += dy * diff * wa;
    b.x -= dx * diff * wb;
    b.y -= dy * diff * wb;
  }

  private celebrate() {
    this.hotUntil = performance.now() + 900;
    const cx = (this.rimL + this.rimR) / 2;
    this.floaters.push({ x: this.rimR + 18, y: this.rimY - 18, t: 0 });
    if (this.reduced) return;
    const colors = ["#e8622c", "#f59e0b", "#ef4444", "#fb923c"];
    for (let i = 0; i < 22; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
      const sp = 220 + Math.random() * 380;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 60,
        y: this.rimY,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0,
        max: 0.6 + Math.random() * 0.5,
        r: 1.5 + Math.random() * 2.5,
        color: colors[i % colors.length],
      });
    }
  }

  private stepParticles(dt: number) {
    for (const p of this.particles) {
      p.life += dt;
      p.vy += 1400 * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    for (const f of this.floaters) f.t += dt;
    this.floaters = this.floaters.filter((f) => f.t < 1);
  }

  // ------------------------------------------------------------------ draw

  private render(b: Ball) {
    b.el.style.transform = `translate3d(${b.x - HALF_W}px, ${b.y - HALF_H}px, 0) rotate(${b.a}rad)`;
    b.el.style.opacity = String(Math.max(0, b.opacity));
    if (b.shownMode !== b.mode) {
      b.el.dataset.mode = b.mode;
      b.shownMode = b.mode;
    }
  }

  private draw() {
    const cx = (this.rimL + this.rimR) / 2;
    const rx = (this.rimR - this.rimL) / 2 + 3;
    let anyNear = false;
    for (const b of this.balls.values()) {
      this.render(b);
      if ((b.mode === "flying" || b.mode === "scored") && Math.hypot(b.x - cx, b.y - this.rimY) < 240) anyNear = true;
    }
    const hot = anyNear || performance.now() < this.hotUntil;
    if (hot !== this.hot) {
      this.hot = hot;
      this.cb.onHot(hot);
    }

    // Back layer: floor shadows + back half of the rim.
    const bc = this.bctx;
    bc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    bc.clearRect(0, 0, this.W, this.H);
    const ground = this.groundY();
    for (const b of this.balls.values()) {
      if (b.mode === "scored" || b.mode === "gone") continue;
      const h = Math.max(0, ground - b.y);
      const s = Math.max(0.25, 1 - h / 500);
      bc.fillStyle = `rgba(15, 23, 42, ${0.1 * s * b.opacity})`;
      bc.beginPath();
      bc.ellipse(b.x, ground + HALF_H + 2, 24 * s, 5 * s, 0, 0, Math.PI * 2);
      bc.fill();
    }
    bc.lineWidth = 5;
    bc.strokeStyle = RIM_DARK;
    bc.beginPath();
    bc.ellipse(cx, this.rimY, rx, 8, 0, Math.PI, Math.PI * 2);
    bc.stroke();

    // Front layer: net, front rim, aim guide, particles, +1.
    const fc = this.fctx;
    fc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    fc.clearRect(0, 0, this.W, this.H);

    const n = this.net;
    if (n.length) {
      fc.strokeStyle = "rgba(148, 156, 170, 0.95)";
      fc.lineWidth = 1.3;
      fc.beginPath();
      for (let r = 0; r < n.length - 1; r++)
        for (let c = 0; c < NET_COLS; c++) {
          const p = n[r][c];
          if (c + 1 < NET_COLS) {
            fc.moveTo(p.x, p.y);
            fc.lineTo(n[r + 1][c + 1].x, n[r + 1][c + 1].y);
          }
          if (c - 1 >= 0) {
            fc.moveTo(p.x, p.y);
            fc.lineTo(n[r + 1][c - 1].x, n[r + 1][c - 1].y);
          }
        }
      const last = n[n.length - 1];
      fc.moveTo(last[0].x, last[0].y);
      for (const p of last) fc.lineTo(p.x, p.y);
      fc.stroke();
    }

    fc.lineCap = "round";
    fc.lineWidth = 5;
    fc.strokeStyle = RIM;
    fc.beginPath();
    fc.ellipse(cx, this.rimY, rx, 8, 0, 0, Math.PI);
    fc.stroke();

    for (const b of this.balls.values()) if (b.mode === "aim" && b.aim) this.drawGuide(b);

    for (const p of this.particles) {
      fc.globalAlpha = Math.max(0, 1 - p.life / p.max);
      fc.fillStyle = p.color;
      fc.beginPath();
      fc.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      fc.fill();
    }
    fc.globalAlpha = 1;

    for (const f of this.floaters) {
      const e = 1 - Math.pow(1 - f.t, 3);
      fc.globalAlpha = f.t < 0.7 ? 1 : 1 - (f.t - 0.7) / 0.3;
      fc.fillStyle = RIM;
      fc.font = "700 22px ui-sans-serif, system-ui, -apple-system, sans-serif";
      fc.fillText("+1", f.x, f.y - e * 34);
    }
    fc.globalAlpha = 1;
  }

  /** Dotted trajectory preview, integrated exactly like the real shot. */
  private drawGuide(b: Ball) {
    const fc = this.fctx;
    const { dx, dy } = b.aim!;
    const pull = Math.hypot(dx, dy);
    if (pull < 12) return;
    let x = b.x;
    let y = b.y;
    let vx = -dx * this.power;
    let vy = -dy * this.power;
    const strength = pull / this.maxPull;
    const steps = 160; // 1.33 s at the physics rate
    for (let i = 0; i < steps; i++) {
      vy += G * STEP;
      x += vx * STEP;
      y += vy * STEP;
      if (y > this.groundY() + HALF_H || x < 0 || x > this.W) break;
      if (i % 4 === 0) {
        const fade = 1 - i / steps;
        fc.fillStyle = `rgba(232, 85, 60, ${0.85 * fade})`;
        fc.beginPath();
        fc.arc(x, y, 1.4 + 1.8 * fade * (0.6 + strength * 0.4), 0, Math.PI * 2);
        fc.fill();
      }
    }
  }
}

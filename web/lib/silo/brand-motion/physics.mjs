// The silo.trading signup page's motion kit (outputs/silo-coming-soon…/public/physics.js), used unchanged by the wallet's
// invitation gate so the two feel the same. Changes: Engine.stop() for unmounting; FlyCoin is left out (unused here).
// Shared motion kit: one gravity, the clock, DOM balls and the wallet/coin renderer.
// Units are CSS px and seconds unless a function says lockup units.
export const G = 2200;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1, x = clamp(t, 0, 1) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
};

/**
 * A point that falls onto a floor at y = 0 and bounces with decaying height.
 * y is the offset from rest (negative = above). Squash and stretch come from
 * speed: stretched while moving fast, squashed for a few frames after impact.
 */
export class Bouncer {
  constructor({ y = 0, vy = 0, restitution = 0.5, minBounce = 70, onLand } = {}) {
    this.y = y;
    this.vy = vy;
    this.e = restitution;
    this.minBounce = minBounce;
    this.onLand = onLand;
    this.squash = 0;
    this.squashV = 0;
    this.resting = y === 0 && vy === 0;
  }

  /** Launch upward to the given apex height (px above the floor). */
  hop(height) {
    this.vy = -Math.sqrt(2 * G * height);
    this.resting = false;
  }

  /** Landing squash grows with impact speed (capped). */
  kick(impact) {
    this.squashV += clamp(impact / 160, 0, 12);
  }

  step(dt) {
    if (!this.resting) {
      this.vy += G * dt;
      this.y += this.vy * dt;
      if (this.y >= 0) {
        const impact = this.vy;
        this.y = 0;
        this.kick(impact);
        if (impact * this.e < this.minBounce) {
          this.vy = 0;
          this.resting = true;
        } else {
          this.vy = -impact * this.e;
        }
        if (this.onLand) this.onLand(impact);
      }
    }
    // damped spring pulls squash back to 0 (slight overshoot)
    const k = 900;
    const c = 2 * Math.sqrt(k) * 0.55;
    this.squashV += (-k * this.squash - c * this.squashV) * dt;
    this.squash += this.squashV * dt;
    this.squash = clamp(this.squash, -0.18, 0.3);
  }

  /** [sx, sy] scale factors, area-preserving. */
  scale() {
    const stretch = this.resting ? 0 : clamp(Math.abs(this.vy) / 9000, 0, 0.16);
    const sy = clamp(1 + stretch - this.squash, 0.6, 1.3);
    return [1 / sy, sy];
  }
}

/** Damped spring toward a target (underdamped by default for a small settle). */
export class Spring {
  constructor(value = 0, { k = 260, damping = 0.62 } = {}) {
    this.x = value;
    this.v = 0;
    this.target = value;
    this.k = k;
    this.c = 2 * Math.sqrt(k) * damping;
  }

  step(dt) {
    this.v += (-this.k * (this.x - this.target) - this.c * this.v) * dt;
    this.x += this.v * dt;
  }
}

/** Ballistic arc between two points under G, apexing `lift` px above the higher end. */
export function arc(x0, y0, x1, y1, lift) {
  const top = Math.min(y0, y1) - lift;
  const vy0 = -Math.sqrt(2 * G * Math.max(1, y0 - top));
  const T = (-vy0 + Math.sqrt(vy0 * vy0 + 2 * G * (y1 - y0))) / G;
  const vx = (x1 - x0) / T;
  return { T, vy0, vx, at: (t) => ({ x: x0 + vx * t, y: y0 + vy0 * t + 0.5 * G * t * t }) };
}

/**
 * The clock. Actors are called with dt each frame and return true when done.
 * An actor can carry a gate; a gated actor only runs (and only keeps the loop
 * alive) while its gate returns true, so off-screen animation costs nothing.
 */
export class Engine {
  constructor({ manual = false } = {}) {
    this.now = 0;
    this.manual = manual;
    this.actors = [];
    this.timers = [];
    this.raf = 0;
    this.last = 0;
    this.frame = this.frame.bind(this);
    this.visible = () => { this.last = 0; this.kick(); };
    document.addEventListener('visibilitychange', this.visible);
    this.stopped = false;
  }

  /** Ends the clock for good: no further frames, timers or listeners (the page left the gate). */
  stop() {
    this.stopped = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.actors = [];
    this.timers = [];
    document.removeEventListener('visibilitychange', this.visible);
  }

  add(fn, gate) {
    const a = { fn, gate };
    this.actors.push(a);
    this.kick();
    return () => { const i = this.actors.indexOf(a); if (i >= 0) this.actors.splice(i, 1); };
  }

  after(sec) {
    return new Promise((res) => { this.timers.push({ t: this.now + sec, res }); this.kick(); });
  }

  tick(dt) {
    this.now += dt;
    for (const a of [...this.actors]) {
      if (a.gate && !a.gate()) continue;
      if (a.fn(dt) === true) { const i = this.actors.indexOf(a); if (i >= 0) this.actors.splice(i, 1); }
    }
    for (let i = this.timers.length - 1; i >= 0; i--) if (this.timers[i].t <= this.now) this.timers.splice(i, 1)[0].res();
  }

  busy() {
    return this.timers.length > 0 || this.actors.some((a) => !a.gate || a.gate());
  }

  frame(t) {
    this.raf = 0;
    if (document.hidden || !this.busy()) { this.last = 0; return; }
    const dt = this.last ? Math.min(0.05, (t - this.last) / 1000) : 1 / 60;
    this.last = t;
    this.tick(dt);
    this.raf = requestAnimationFrame(this.frame);
  }

  kick() {
    if (this.stopped || this.manual || this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(this.frame);
  }
}

/** A round dot in a positioned container; x and y are its centre, relative to the container. */
export class Ball {
  constructor(engine, container, d) {
    this.engine = engine;
    this.d = d;
    this.x = 0;
    this.y = 0;
    this.sq = new Bouncer();
    this.sq.resting = true;
    this.el = document.createElement('div');
    this.el.className = 'ball';
    this.el.style.width = this.el.style.height = `${d}px`;
    container.appendChild(this.el);
    this.stop = engine.add((dt) => this.draw(dt));
  }

  draw(dt) {
    this.sq.step(dt);
    const [sx, sy] = this.sq.scale();
    this.el.style.transform = `translate(${(this.x - this.d / 2).toFixed(2)}px, ${(this.y - this.d / 2).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  }

  /** Fly along a ballistic arc to (x1, y1) and squash on landing. */
  fly(x1, y1, lift) {
    return new Promise((res) => {
      const a = arc(this.x, this.y, x1, y1, lift);
      let t = 0;
      this.engine.add((dt) => {
        t += dt;
        if (t >= a.T) {
          this.x = x1;
          this.y = y1;
          this.sq.kick(G * a.T);
          res(a);
          return true;
        }
        const p = a.at(t);
        this.x = p.x;
        this.y = p.y;
        return false;
      });
    });
  }

  remove() {
    this.stop();
    this.el.remove();
  }
}

/* ---------- coin and wallet ---------- */
const R = 119.36; // coin face radius, lockup units
const T = 0.2 * R; // rim width when the coin is edge-on
export const COIN = { R, T, CX: 290.15, CY: 140.36 };

/**
 * The coin as flat shapes only, turned around its vertical axis: the face is
 * an ellipse whose width follows cos(phi), a darker rim appears beside it with
 * width sin(phi) * T, a lighter line runs along the middle of the rim, and the
 * face darkens a little as it turns away. Past a quarter turn the rim moves to
 * the other side of the face. No perspective.
 */
export class CoinArt {
  constructor(root) {
    this.n = {};
    for (const r of ['cgB', 'cgR', 'cgF', 'cbB', 'cbR', 'cbH', 'cbF', 'cbS', 'sym']) this.n[r] = root.querySelector(`[data-role="${r}"]`);
  }

  /** `morph` (0..1) cross-fades the face into the artwork held by the `sym` group, if any. */
  draw(phi, morph = 0) {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const rx = Math.max(0.01, R * Math.abs(c));
    const ox = (T / 2) * s * (c < 0 ? -1 : 1); // near face offset; the far face sits at -ox
    const a = Math.abs(ox);
    const n = this.n;
    const ell = (e, cx) => { if (!e) return; e.setAttribute('cx', cx); e.setAttribute('rx', rx); e.setAttribute('ry', R); };
    const box = (e) => { if (!e) return; e.setAttribute('x', -a); e.setAttribute('y', -R); e.setAttribute('width', 2 * a); e.setAttribute('height', 2 * R); };
    ell(n.cgB, -ox); box(n.cgR); ell(n.cgF, ox);
    ell(n.cbB, -ox); box(n.cbR); ell(n.cbH, 0); ell(n.cbF, ox); ell(n.cbS, ox);
    if (n.cbS) n.cbS.setAttribute('fill-opacity', (0.22 * (1 - Math.abs(c))).toFixed(3));
    if (n.cbF) n.cbF.setAttribute('fill-opacity', (1 - morph).toFixed(3));
    if (n.sym) {
      n.sym.setAttribute('opacity', morph.toFixed(3));
      n.sym.setAttribute('transform', `translate(${ox.toFixed(2)} 0) scale(${Math.abs(c).toFixed(4)} 1)`); // same art on both faces, never mirrored
    }
    if (n.cbH) n.cbH.setAttribute('stroke-opacity', Math.min(1, Math.abs(s) * 2.4).toFixed(3)); // only while a rim shows
  }
}

/** Transform that scales along `ang` degrees by k (and 1/k across), anchored at the coin's bottom. */
export function anchored(k, ang) {
  return `translate(0 ${R}) rotate(${ang}) scale(${k.toFixed(4)} ${(1 / k).toFixed(4)}) rotate(${-ang}) translate(0 ${-R})`;
}

/**
 * The layered wallet (back, coin, front) rendered into an svg that holds the
 * roles below. Owns the coin physics, the half turn and the idle springs.
 */
export class Wallet {
  constructor(svg, { origin = [0, 0] } = {}) {
    this.svg = svg;
    const q = (r) => svg.querySelector(`[data-role="${r}"]`);
    this.roles = {};
    for (const r of ['wrap', 'back', 'front', 'coinPos', 'coinTilt']) this.roles[r] = q(r);
    this.art = new CoinArt(svg);
    this.origin = origin;
    this.vbw = svg.viewBox.baseVal.width;
    this.vbx = svg.viewBox.baseVal.x;
    this.vby = svg.viewBox.baseVal.y;
    this.coin = new Bouncer({ restitution: 0.42, minBounce: 80, onLand: (v) => { if (this.onLand) this.onLand(v); } });
    this.onLand = null;
    this.phi = Math.PI;
    this.hidden = false;
    this.fallStart = 0;
    this.crouchT = -1;
    this.crouchH = 0;
    this.base = { x: 0, y: 0 }; // where the coin rests, lockup units from its home
    this.sc = 1; // coin scale
    this.morph = 0;
    this.flight = null;
    this.locked = false; // the coin is the finished mark: no idle hops, no peeking
    this.peek = new Spring(0, { k: 220, damping: 0.55 });
    this.tilt = new Spring(0, { k: 200, damping: 0.5 });
    this.back = new Spring(0, { k: 170, damping: 0.5 });
    this.front = new Spring(0, { k: 170, damping: 0.5 });
    this.rock = new Spring(0, { k: 180, damping: 0.3 });
    this.layers = { back: true, front: true };
    this.measure();
  }

  measure() {
    this.rect = this.svg.getBoundingClientRect();
    this.S = (this.rect.width / this.vbw) || 1;
  }

  /** Client position of the coin's resting centre. */
  coinCenter() {
    this.measure();
    return { x: this.rect.left + (COIN.CX + this.origin[0] - this.vbx) * this.S, y: this.rect.top + (COIN.CY + this.origin[1] - this.vby) * this.S };
  }

  /** Start the fall from y0 px above rest with a half turn on the way. */
  drop(y0) {
    this.hidden = false;
    this.phi = 0;
    this.fallStart = y0;
    this.coin.y = y0;
    this.coin.vy = 0;
    this.coin.resting = false;
  }

  /** Continue a fall that began elsewhere (a flying coin handing over). */
  handoff(y0, vy, phi) {
    this.hidden = false;
    this.phi = phi;
    this.fallStart = 0;
    this.coin.y = y0;
    this.coin.vy = vy;
    this.coin.resting = false;
  }

  /** Crouch (squash about 15% for a short beat), then leave the pocket under gravity. */
  hop(h) {
    if (this.coin.resting && this.crouchT < 0 && !this.hidden && !this.locked && !this.flight) { this.crouchT = 0; this.crouchH = h; }
  }

  /**
   * Crouch, leave the pocket on a real ballistic arc (one gravity, constant horizontal
   * speed) to rest at (toX, toY) in lockup units at scale `toScale`, turning half a
   * turn and morphing into the artwork on the way. Resolves at first touchdown; the
   * normal bounce and squash then settle it there.
   */
  launch({ toX, toY, toScale = 1, lift = 170 }) {
    return new Promise((resolve) => {
      this.crouchT = 0.0001;
      this.crouchH = 0;
      this.hidden = false;
      this.locked = true;
      this.peek.target = 0;
      this.tilt.target = 0;
      const a = arc(0, 0, (toX - COIN.CX) * this.S, (toY - COIN.CY) * this.S, lift);
      this.flight = { a, t: -1, toX, toY, toScale, resolve, wait: 0 };
    });
  }

  shake() { this.rock.v = (Math.random() < 0.5 ? -1 : 1) * 140; }

  settle() {
    this.layers = { back: true, front: true };
    this.back.x = this.front.x = this.back.target = this.front.target = 0;
    this.hidden = false;
    this.phi = Math.PI;
    this.coin.y = 0; this.coin.vy = 0; this.coin.resting = true; this.coin.squash = 0; this.coin.squashV = 0;
    this.fallStart = 0;
    this.crouchT = -1;
    this.draw();
  }

  /** Lean the coin toward a pointer and lift it when the pointer is near. */
  point(x, y, range = 420) {
    if (this.locked) return;
    const c = this.coinCenter();
    const near = Math.max(0, 1 - Math.hypot(x - c.x, y - c.y) / range);
    this.peek.target = 34 * near;
    this.tilt.target = clamp((x - c.x) / 360, -1, 1) * 8 * Math.min(1, near * 2);
  }

  step(dt) {
    if (!this.hidden) {
      if (this.crouchT >= 0) {
        this.crouchT += dt;
        const u = clamp(this.crouchT / 0.09, 0, 1);
        this.coin.squash = 0.15 * u * u * (3 - 2 * u);
        this.coin.squashV = 0;
        if (this.crouchT >= 0.09) {
          this.crouchT = -1;
          if (this.flight) this.flight.t = 0; else this.coin.hop(this.crouchH);
        }
      }
      if (this.flight && this.flight.t >= 0) this.fly(dt);
      else if (!this.flight) this.coin.step(dt);
      else { this.coin.squashV = 0; }
      if (this.fallStart && this.coin.y < 0) this.phi = Math.PI * clamp(1 - this.coin.y / this.fallStart, 0, 1);
      else if (this.fallStart && this.coin.resting) this.phi = Math.PI;
    }
    this.peek.step(dt); this.tilt.step(dt); this.back.step(dt); this.front.step(dt); this.rock.step(dt);
    this.draw();
  }

  fly(dt) {
    const f = this.flight;
    f.t += dt;
    const a = f.a;
    const p = clamp(f.t / a.T, 0, 1);
    const pt = a.at(Math.min(f.t, a.T));
    const vy = a.vy0 + G * Math.min(f.t, a.T);
    this.fx = pt.x / this.S;
    this.fy = pt.y / this.S;
    this.sc = 1 + (f.toScale - 1) * p;
    this.phi = Math.PI * p;
    this.morph = clamp((p - 0.3) / 0.45, 0, 1);
    this.fk = 1 + clamp(Math.hypot(a.vx, vy) / 9000, 0, 0.16);
    this.fang = (Math.atan2(vy, a.vx) * 180) / Math.PI;
    this.coin.squash = Math.max(0, this.coin.squash - dt * 2);
    if (p >= 1) {
      this.base = { x: f.toX - COIN.CX, y: f.toY - COIN.CY };
      this.fx = this.fy = 0;
      this.fk = 1;
      this.sc = f.toScale;
      this.phi = Math.PI;
      this.morph = 1;
      this.flight = null;
      this.coin.y = -0.01;
      this.coin.vy = vy; // keep the speed: it lands, squashes and bounces on the spot
      this.coin.resting = false;
      f.resolve({ vy });
    }
  }

  draw() {
    const r = this.roles;
    r.back.setAttribute('transform', `translate(0 ${this.back.x.toFixed(2)})`);
    r.front.setAttribute('transform', `translate(0 ${this.front.x.toFixed(2)})`);
    r.back.style.opacity = this.layers.back ? clamp(1 - this.back.x / 110, 0, 1) : 0;
    r.front.style.opacity = this.layers.front ? clamp(1 - this.front.x / 110, 0, 1) : 0;
    r.wrap.setAttribute('transform', `rotate(${this.rock.x.toFixed(2)} 276 580)`);
    r.coinPos.style.display = this.hidden ? 'none' : '';
    if (this.hidden) return;
    this.art.draw(this.phi, this.morph);
    const fl = this.flight && this.flight.t >= 0;
    const dy = this.coin.y / this.S - this.peek.x + (fl ? this.fy : 0);
    const dx = fl ? this.fx : 0;
    // vertical hop: stretch up while moving, squash on landing, both anchored at the coin's bottom
    const k = fl ? this.fk : this.coin.scale()[1];
    const ang = fl ? this.fang : 90;
    r.coinPos.setAttribute('transform', `translate(${(COIN.CX + this.base.x + dx).toFixed(2)} ${(COIN.CY + this.base.y + dy).toFixed(2)}) scale(${this.sc.toFixed(4)})`);
    r.coinTilt.setAttribute('transform', `rotate(${this.tilt.x.toFixed(2)}) ${anchored(k, ang)}`);
  }
}

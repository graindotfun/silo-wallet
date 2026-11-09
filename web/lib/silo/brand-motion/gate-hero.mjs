// The silo.trading signup hero (outputs/silo-coming-soon…/public/hero.js), hero part only, for the wallet's invitation gate
// (owner, 23 October 2026: "the entrance animation of the signup page, and the black rectangle that moves"). The wallet
// assembles, the coin drops with a half turn, the letters rise, the full stop bounces in, a dot hops over each word of the
// tagline and lands as its full stop, then the dark window drifts over the stage and inverts what it covers.
// Scoped to one root (no ids, no globals) and fully stoppable; reduced motion shows the finished frame with a resting window.
// Decorative only: the invite field and button are outside the stage and work from the first frame.
import {clamp, easeOutCubic, Bouncer, Engine, Ball, Wallet, COIN} from './physics.mjs';

export function startSiloGateHero(root) {
  const $ = (s, r = root) => r.querySelector(s);
  const $$ = (s, r = root) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cleanups = [];
  const listen = (target, type, fn, options) => { target.addEventListener(type, fn, options); cleanups.push(() => target.removeEventListener(type, fn, options)); };
  const engine = new Engine();
  const after = (s) => engine.after(s);
  const hero = root;
  const lockup = $('[data-silo-part="lockup"]');
  const stage = $('[data-silo-part="stage"]');
  hero.classList.add('silo-hero-js');

  const seen = new Map();
  const io = new IntersectionObserver((entries) => { for (const e of entries) seen.set(e.target, e.isIntersecting); engine.last = 0; engine.kick(); });
  cleanups.push(() => io.disconnect());
  const watch = (el) => { seen.set(el, true); io.observe(el); return () => seen.get(el) !== false; };

  /* ---------- wallet ---------- */
  const heroWallet = new Wallet(lockup, { origin: [-21, -21] });
  const heroGate = watch(hero);
  engine.add((dt) => heroWallet.step(dt), heroGate);
  heroWallet.back.x = heroWallet.back.target = heroWallet.front.x = heroWallet.front.target = 150;
  heroWallet.layers = { back: false, front: false };
  heroWallet.hidden = true;

  /* ---------- wordmark ---------- */
  const letters = $$('.ltr', lockup);
  const wDot = $('[data-silo-part="dot"]', lockup);
  const dotBox = wDot.getBBox();
  const dotCX = dotBox.x + dotBox.width / 2, dotCY = dotBox.y + dotBox.height / 2;
  const lp = letters.map(() => ({ t: -1 }));
  engine.add((dt) => {
    letters.forEach((g, i) => {
      const p = lp[i];
      if (p.t < 0) { g.setAttribute('transform', 'translate(0 600)'); return; }
      p.t = Math.min(1, p.t + dt / 0.5);
      g.setAttribute('transform', `translate(0 ${((1 - easeOutCubic(p.t)) * 520).toFixed(2)})`);
    });
  }, heroGate);
  const dot = new Bouncer({ restitution: 0.42, minBounce: 90 });
  let dotHidden = true;
  engine.add((dt) => {
    if (dotHidden) { wDot.style.display = 'none'; return; }
    wDot.style.display = '';
    dot.step(dt);
    const [sx, sy] = dot.scale();
    wDot.setAttribute('transform', `translate(${dotCX} ${dotCY + dot.y / heroWallet.S}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-dotCX} ${-dotCY})`);
  }, heroGate);

  /* ---------- tagline: a dot hops over each word and lands as the full stop ---------- */
  const tag = $('[data-silo-part="tag"]');
  const lines = $$('.line', tag);
  function dotMetrics(el) {
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx.measureText('.');
    return { fs: parseFloat(cs.fontSize), d: Math.max(m.actualBoundingBoxLeft + m.actualBoundingBoxRight, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent), dx: (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, dy: (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 };
  }
  function lineTargets(line, mt) {
    const h = hero.getBoundingClientRect();
    const base = $('.bl', line).getBoundingClientRect().bottom - h.top;
    const landY = base - mt.fs * 0.74 - mt.d / 2 - mt.fs * 0.05;
    const words = $$('.w', line).map((w) => { const r = $('.wt', w).getBoundingClientRect(); return { w, x: r.left + r.width / 2 - h.left, y: landY }; });
    const pdEl = $('.pd', line), pd = pdEl.getBoundingClientRect();
    return { words, pd: pdEl, px: pd.left + mt.dx - h.left, py: base - mt.dy };
  }
  async function runTagline() {
    const mt = dotMetrics(tag);
    for (const line of lines) {
      if (engine.stopped) return;
      const tg = lineTargets(line, mt);
      const ball = new Ball(engine, hero, mt.d);
      ball.x = tg.words[0].x;
      ball.y = Math.max(-mt.d * 3, tg.words[0].y - 300);
      await ball.fly(tg.words[0].x, tg.words[0].y, 0);
      tg.words[0].w.classList.add('on');
      for (let i = 1; i < tg.words.length; i++) { await ball.fly(tg.words[i].x, tg.words[i].y, mt.fs * 0.22); tg.words[i].w.classList.add('on'); }
      await ball.fly(tg.px, tg.py, mt.fs * 0.2);
      await after(0.08);
      tg.pd.classList.add('on');
      ball.remove();
      await after(0.05);
    }
  }

  /* ---------- sequence ---------- */
  let finished = false;
  async function intro() {
    await after(0.15);
    hero.classList.add('started');
    await after(0.2);
    heroWallet.layers.back = true; heroWallet.back.target = 0;
    await after(0.18);
    heroWallet.layers.front = true; heroWallet.front.target = 0;
    await after(0.45);
    heroWallet.measure();
    const y0 = -Math.max(420, heroWallet.rect.top + (COIN.CY + 140 + 20) * heroWallet.S);
    await new Promise((res) => { heroWallet.onLand = (v) => { if (v > 200) { heroWallet.onLand = null; res(); } }; heroWallet.drop(y0); });
    await after(0.05);
    for (let i = 0; i < letters.length; i++) { await after(0.075); lp[i].t = 0; }
    await after(0.3);
    dotHidden = false;
    dot.y = -Math.max(300, heroWallet.rect.top + 200); dot.vy = 0; dot.resting = false;
    await after(0.2);
    await runTagline();
    if (engine.stopped) return;
    finished = true;
    hero.dataset.done = '1';
    await after(0.6);
    privacyWindow(stage, { margin: 24 });
  }
  function finishHero() {
    finished = true;
    heroWallet.settle();
    lp.forEach((p) => (p.t = 1));
    dotHidden = false; dot.y = 0; dot.resting = true; dot.squash = dot.squashV = 0;
    $$('.w', tag).forEach((w) => w.classList.add('on'));
    $$('.pd', tag).forEach((p) => p.classList.add('on'));
    hero.classList.add('started');
    hero.dataset.done = '1';
    privacyWindow(stage, { margin: 24 });
  }

  /* ---------- the window: a dark rectangle that drifts at random over the stage and inverts what it covers ---------- */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => { let t = x; for (let i = 0; i < 8; i++) { const e = X(t) - x; if (Math.abs(e) < 1e-5) break; const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= e / d; } return Y(clamp(t, 0, 1)); };
  }
  const EASES = [bezier(0.65, 0, 0.2, 1), bezier(0.2, 0.75, 0.2, 1), bezier(0.8, 0, 0.15, 1), bezier(0.45, 0, 0.25, 1), bezier(0.3, 0.9, 0.1, 1)];
  const rnd = (a, b) => a + Math.random() * (b - a), chance = (p) => Math.random() < p;
  const windowRadius = () => clamp(innerWidth * 0.024, 14, 36);
  let windowOnLogo = false;
  function privacyWindow(box, { margin = 16 } = {}) {
    if (box._win || engine.stopped) return;
    const els = $$('.w, .silo-hero-lockup', box);
    const clone = box.cloneNode(true);
    const twins = [];
    const liveSvgs = $$('svg', box), cloneSvgs = $$('svg', clone);
    liveSvgs.forEach((svg, i) => { const a = [svg, ...svg.querySelectorAll('*')], b = [cloneSvgs[i], ...cloneSvgs[i].querySelectorAll('*')]; a.forEach((n, j) => { if (b[j] && b[j].tagName === n.tagName) twins.push([n, b[j]]); }); });
    const POSE = ['transform', 'opacity', 'cx', 'cy', 'rx', 'ry', 'x', 'y', 'width', 'height', 'd'];
    const mirror = () => { for (const [n, c] of twins) { for (const k of POSE) { const v = n.getAttribute(k); if (v !== c.getAttribute(k)) { if (v === null) c.removeAttribute(k); else c.setAttribute(k, v); } } if (n.style.cssText !== c.style.cssText) c.style.cssText = n.style.cssText; } };
    mirror();
    clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    clone.removeAttribute('data-silo-part');
    clone.style.width = '100%'; clone.style.height = '100%';
    const el = document.createElement('div');
    el.className = 'win';
    el.style.setProperty('--m', `${margin}px`);
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    const inner = document.createElement('div');
    inner.className = 'win-in';
    inner.append(clone);
    el.append(inner);
    box.append(el);
    box._win = el;
    cleanups.push(() => { el.remove(); box._win = null; });
    const fsOf = () => parseFloat(getComputedStyle($('.w', box) || box).fontSize) || 40;
    let B = { w: 0, h: 0 }, content = [], logo = null;
    const measure = () => {
      const o = box.getBoundingClientRect();
      B = { w: o.width, h: o.height };
      content = els.map((n) => { const r = n.getBoundingClientRect(); return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height, logo: n.classList.contains('silo-hero-lockup'), word: n.classList.contains('w') }; }).filter((c) => c.w > 4 && c.h > 4);
      logo = content.find((c) => c.logo) || null;
    };
    const touches = (r) => { let best = 0; for (const c of content) { const ix = Math.max(0, Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x)), iy = Math.max(0, Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y)), covered = ix * iy; best = Math.max(best, c.word || c.logo ? covered / Math.min(r.w * r.h, c.w * c.h) : (covered / (r.w * r.h)) * 1.4); } return best >= 0.4; };
    const pick = (from) => {
      measure();
      const fs = fsOf(), cx0 = from ? from.x + from.w / 2 : B.w / 2, cy0 = from ? from.y + from.h / 2 : B.h / 2;
      let fallback = null;
      for (let tries = 0; tries < 80; tries++) {
        const kind = Math.random() * 0.93;
        let w, h;
        if (kind < 0.2) { w = rnd(1.2, 3.2) * fs; h = rnd(0.7, 1.6) * fs; }
        else if (kind < 0.42) { w = rnd(4, 9) * fs; h = rnd(0.55, 1.1) * fs; }
        else if (kind < 0.6) { w = rnd(0.7, 1.6) * fs; h = rnd(1.8, 4.5) * fs; }
        else if (kind < 0.82) { w = rnd(2.5, 6) * fs; h = rnd(1.2, 2.6) * fs; }
        else { w = rnd(6, 12) * fs; h = rnd(2.2, 4.5) * fs; }
        w = Math.min(w, B.w * 0.85); h = Math.min(h, B.h * 0.75);
        let x, y;
        const a = content[(Math.random() * content.length) | 0];
        if (a && chance(0.7)) { const useRight = chance(0.3), useBottom = chance(0.25), ox = rnd(-0.16, 0.08) * fs, oy = rnd(-0.1, 0.16) * fs; x = (useRight ? a.x + a.w - w : a.x) + (useRight ? -ox : ox); y = (useBottom ? a.y + a.h - h : a.y) + (useBottom ? -oy : oy); }
        else { x = rnd(-margin + 2, B.w + margin - 2 - w); y = rnd(-margin + 2, B.h + margin - 2 - h); }
        x = clamp(x, -margin + 2, B.w + margin - 2 - w); y = clamp(y, -margin + 2, B.h + margin - 2 - h);
        const r = { x, y, w, h };
        if (!touches(r)) continue;
        fallback = fallback || r;
        const dist = Math.hypot(x + w / 2 - cx0, y + h / 2 - cy0);
        if (from && (dist > 0.5 * B.w + 0.25 * B.h || dist < 0.1 * B.w)) continue;
        if (from && Math.abs(w - from.w) < 0.15 * fs && Math.abs(h - from.h) < 0.15 * fs) continue;
        return r;
      }
      return fallback || { x: B.w * 0.3, y: B.h * 0.3, w: 4 * fs, h: 1.2 * fs };
    };
    const paint = (c) => {
      const Wo = B.w + 2 * margin, Ho = B.h + 2 * margin, rad = Math.min(windowRadius(), c.w / 2, c.h / 2);
      el.style.clipPath = `inset(${(c.y + margin).toFixed(1)}px ${(Wo - (c.x + margin + c.w)).toFixed(1)}px ${(Ho - (c.y + margin + c.h)).toFixed(1)}px ${(c.x + margin).toFixed(1)}px round ${rad.toFixed(1)}px)`;
      windowOnLogo = !!logo && c.w > 2 && c.x < logo.x + logo.w && c.x + c.w > logo.x && c.y < logo.y + logo.h && c.y + c.h > logo.y;
    };
    let cur = pick(null);
    if (reduce) { paint(cur); return; }
    let from = { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2, w: 0, h: 0 }, to = cur;
    let state = 'move', t = -rnd(0.1, 0.5), dur = rnd(0.8, 1.3), wait = 0, bend = 0, ease = EASES[0], ctrl = { x: 0, y: 0 };
    const plan = () => { const c0 = { x: from.x + from.w / 2, y: from.y + from.h / 2 }, c1 = { x: to.x + to.w / 2, y: to.y + to.h / 2 }; ctrl = { x: (c0.x + c1.x) / 2 - (c1.y - c0.y) * bend, y: (c0.y + c1.y) / 2 + (c1.x - c0.x) * bend }; };
    plan();
    const gate = watch(box);
    engine.add((dt) => {
      mirror();
      if (state === 'rest') {
        wait -= dt;
        if (wait > 0) return;
        from = { ...to }; to = pick(from);
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        dur = clamp(0.5 + (dist / Math.max(B.w, 1)) * rnd(1.6, 3.2), 0.6, 2.4);
        bend = (chance(0.5) ? 1 : -1) * rnd(0.15, 0.6);
        ease = EASES[(Math.random() * EASES.length) | 0];
        plan(); t = 0; state = 'move';
        return;
      }
      t += dt;
      if (t < 0) return;
      const p = ease(clamp(t / dur, 0, 1)), u = 1 - p;
      const c0 = { x: from.x + from.w / 2, y: from.y + from.h / 2 }, c1 = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
      const cx = u * u * c0.x + 2 * u * p * ctrl.x + p * p * c1.x, cy = u * u * c0.y + 2 * u * p * ctrl.y + p * p * c1.y;
      const w = from.w + (to.w - from.w) * p, hh = from.h + (to.h - from.h) * p;
      paint({ x: cx - w / 2, y: cy - hh / 2, w, h: hh });
      if (t >= dur) { state = 'rest'; wait = chance(0.3) ? 0 : chance(0.65) ? rnd(0.15, 0.9) : rnd(1, 2.4); }
    }, gate);
    let rz;
    listen(window, 'resize', () => { clearTimeout(rz); rz = setTimeout(() => { to = pick(to); paint(to); state = 'rest'; wait = 0.2; }, 150); });
  }

  /* ---------- idle life: the coin breathes, peeks at the pointer, hops when tapped ---------- */
  let nextBreath = 0;
  engine.add(() => {
    if (!finished || reduce) return;
    if (engine.now >= nextBreath) { nextBreath = engine.now + 3.4 + Math.random() * 2.4; if (heroWallet.peek.x < 4 && !windowOnLogo) heroWallet.hop(30 + Math.random() * 14); }
  }, heroGate);
  listen(window, 'pointermove', (e) => { if (!reduce && finished && !windowOnLogo) heroWallet.point(e.clientX, e.clientY); }, { passive: true });
  listen($('[data-silo-part="lockup-wrap"]'), 'click', () => { if (finished && !reduce) heroWallet.hop(70); });
  let resizeTimer;
  listen(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { heroWallet.measure(); if (!finished) finishHero(); }, 120); });

  /* ---------- start ---------- */
  const start = () => {
    if (engine.stopped) return;
    if (reduce) { finishHero(); return; }
    heroWallet.draw();
    engine.tick(0);
    void intro();
    engine.kick();
  };
  const fontsReady = document.fonts ? document.fonts.load('600 40px "Silo Albert Sans"').then(() => document.fonts.ready) : Promise.resolve();
  fontsReady.then(start, start);

  return () => { engine.stop(); for (const fn of cleanups.splice(0)) fn(); $$('.ball', hero).forEach((b) => b.remove()); };
}

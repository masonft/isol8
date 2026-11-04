/* How it works: scroll reveals and the animated diagrams. Everything is drawn locally. */
(() => {
  "use strict";
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let running = false;
  /** Palette ("r,g,b" strings) read from the theme's CSS variables; refreshed on theme change. */
  const C = {};
  function readPalette() {
    const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(`--rgb-${k}`).trim().replace(/\s+/g, "");
    Object.assign(C, { amber: v("amber"), cyan: v("cyan"), lilac: v("lilac"), mint: v("mint"), grid: v("ink"), muted: v("muted"), danger: v("danger") });
  }
  readPalette();
  const rgba = (c, a) => `rgba(${c},${a})`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeIO = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

  // ------------------------------------------------------------ reveals
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); }
  }, { threshold: 0.18 });
  document.querySelectorAll(".in-view").forEach((el) => io.observe(el));

  const top = document.querySelector(".top");
  const onScroll = () => top.style.setProperty("--scrolled", String(Math.min(1, scrollY / 40)));
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  // -------------------------------------------------------- signal model
  /** A smooth stand-in for a bar of music, in pixel units. */
  const song = (x) => 0.5 * Math.sin(x * 0.045) + 0.28 * Math.sin(x * 0.11 + 1.3) + 0.16 * Math.sin(x * 0.23 + 0.4) + 0.08 * Math.sin(x * 0.51 + 2);
  /** The hidden sound: only in the twin. */
  const blip = (x, at, width) => { const u = (x - at) / width; return Math.exp(-u * u * 4) * Math.sin(x * 0.55) * 0.55; };

  function sizeCanvas(c) {
    const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, dpr };
  }
  function grid(g, w, h, dpr) {
    g.strokeStyle = rgba(C.grid, 0.035); g.lineWidth = 1;
    const step = 40 * dpr;
    g.beginPath();
    for (let x = (w % step) / 2; x < w; x += step) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, h); }
    for (let y = (h / 2) % step; y < h; y += step) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(w, Math.round(y) + 0.5); }
    g.stroke();
  }
  /** Strokes y = mid + f(x) * amp across the canvas, x in CSS pixels. */
  function line(g, w, dpr, mid, amp, f, color, alpha = 1, width = 2, glow = 10, x0 = 0, x1 = w) {
    g.save();
    g.strokeStyle = rgba(color, alpha); g.lineWidth = width * dpr; g.lineJoin = "round";
    g.shadowBlur = glow * dpr; g.shadowColor = rgba(color, alpha * 0.8);
    g.beginPath();
    let first = true;
    for (let x = x0; x <= x1; x += 2 * dpr) {
      const y = mid + f(x / dpr) * amp;
      if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
    }
    g.stroke();
    g.restore();
  }
  function label(g, dpr, text, x, y, color, alpha = 1) {
    g.save();
    g.font = `500 ${11 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`;
    g.fillStyle = rgba(color, alpha); g.textBaseline = "middle";
    g.fillText(text, x, y);
    g.restore();
  }

  // ------------------------------------------------------------- demos
  const demos = {
    hero(g, w, h, dpr, t) {
      const cyc = 7, p = (t % cyc) / cyc;
      const mis = 60 * (1 - easeIO(p / 0.45)) * (p < 0.85 ? 1 : 0) + (p >= 0.85 ? 60 * easeIO((p - 0.85) / 0.15) : 0);
      const W = w / dpr, at = W * 0.62;
      const mid = h * 0.36, amp = h * 0.17, fade = (x) => Math.min(1, x / 80, (W - x) / 80);
      const twin = (x) => (song((x + t * 30) * 0.55) + blip(x, at, 40)) * fade(x);
      const copy = (x) => -song((x + mis + t * 30) * 0.55) * fade(x);
      line(g, w, dpr, mid, amp, twin, C.cyan, 0.85);
      line(g, w, dpr, mid, amp, copy, C.amber, 0.85);
      const ry = h * 0.78;
      line(g, w, dpr, ry, amp, (x) => twin(x) + copy(x), C.lilac, 0.95, 2, 16);
      const aligned = mis < 1;
      if (aligned) {
        const a = Math.min(1, (0.85 - p) * 8);
        g.save();
        g.fillStyle = rgba(C.lilac, 0.06 * a);
        g.fillRect((at - 70) * dpr, ry - amp, 140 * dpr, amp * 2);
        g.restore();
        label(g, dpr, "hidden sound", (at - 42) * dpr, ry - amp - 8 * dpr, C.lilac, 0.8 * a);
      }
      label(g, dpr, "twin + inverted copy", 20 * dpr, 22 * dpr, C.grid, 0.35);
      label(g, dpr, "sum", 20 * dpr, ry - amp - 8 * dpr, C.grid, 0.35);
    },

    find(g, w, h, dpr, t) {
      const cyc = 6.5, p = (t % cyc) / cyc;
      const N = Math.floor(w / (5 * dpr)), bw = w / N;
      const A = [0.1, 0.3], B = [0.6, 0.8];
      const base = h * 0.72, H = h * 0.32;
      const env = (i) => {
        let u = i / N;
        if (u >= B[0] && u < B[1]) u = u - B[0] + A[0];                 // the twin is a copy
        const k = Math.floor(u * N * 1.0);
        return 0.25 + 0.55 * Math.abs(Math.sin(k * 1.7) * Math.cos(k * 0.37)) + 0.2 * Math.sin(u * 20) ** 2;
      };
      const scan = ease(p / 0.45);
      const show = clamp((scan - B[0]) / 0.1, 0, 1) * (p < 0.9 ? 1 : 1 - (p - 0.9) / 0.1);
      for (let i = 0; i < N; i++) {
        const u = i / N, v = env(i);
        let col = rgba(C.muted, 0.28);
        if (u >= A[0] && u < A[1]) col = `rgba(${mix(C.muted, C.amber, show)},${0.28 + 0.6 * show})`;
        if (u >= B[0] && u < B[1]) col = `rgba(${mix(C.muted, C.cyan, show)},${0.28 + 0.6 * show})`;
        g.fillStyle = col;
        g.fillRect(i * bw, base - v * H, Math.max(1, bw - 1.5 * dpr), v * H * 2 * 0.5);
        g.fillRect(i * bw, base, Math.max(1, bw - 1.5 * dpr), v * H * 0.5);
      }
      // scanning cursor
      if (p < 0.5) {
        const x = scan * w;
        const gr = g.createLinearGradient(x - 60 * dpr, 0, x, 0);
        gr.addColorStop(0, rgba(C.lilac, 0)); gr.addColorStop(1, rgba(C.lilac, 0.15));
        g.fillStyle = gr; g.fillRect(x - 60 * dpr, 0, 60 * dpr, h);
        g.fillStyle = rgba(C.lilac, 0.9); g.fillRect(x - dpr, 0, 2 * dpr, h);
      }
      // arc
      const arc = ease((p - 0.45) / 0.2) * show;
      if (arc > 0) {
        const x1 = ((A[0] + A[1]) / 2) * w, x2 = ((B[0] + B[1]) / 2) * w, y = base - H * 1.05;
        const ah = (y - 20 * dpr) * arc;
        const gr = g.createLinearGradient(x1, 0, x2, 0);
        gr.addColorStop(0, rgba(C.amber, 1)); gr.addColorStop(1, rgba(C.cyan, 1));
        g.save();
        g.strokeStyle = gr; g.lineWidth = 2.2 * dpr; g.shadowBlur = 12 * dpr; g.shadowColor = rgba(C.lilac, 0.5);
        g.beginPath(); g.moveTo(x1, y); g.bezierCurveTo(x1, y - ah * 1.33, x2, y - ah * 1.33, x2, y); g.stroke();
        g.restore();
        g.fillStyle = rgba(C.amber, 1); g.beginPath(); g.arc(x1, y, 3.5 * dpr, 0, 7); g.fill();
        g.fillStyle = rgba(C.cyan, 1); g.beginPath(); g.arc(x2, y, 3.5 * dpr, 0, 7); g.fill();
        label(g, dpr, "identical", (x1 + x2) / 2 - 30 * dpr, y - ah - 12 * dpr, C.lilac, arc);
      }
    },

    align(g, w, h, dpr, t, el) {
      const cyc = 5.5, p = (t % cyc) / cyc;
      const off = 120 * (1 - ease(p / 0.5)) * (p < 0.92 ? 1 : 0) + (p >= 0.92 ? 120 * ease((p - 0.92) / 0.08) : 0);
      const amp = h * 0.15;
      line(g, w, dpr, h * 0.32, amp, (x) => song(x), C.cyan, 0.9);
      line(g, w, dpr, h * 0.7, amp, (x) => song(x + off), C.amber, 0.9);
      // reference peak markers
      const peakX = 140;
      for (const [y, o, col] of [[h * 0.32, 0, C.cyan], [h * 0.7, -off, C.amber]]) {
        const x = (peakX + o) * dpr;
        g.fillStyle = rgba(col, 0.25); g.fillRect(x - 0.5 * dpr, y - amp * 1.4, 1 * dpr, amp * 2.8);
      }
      const locked = off < 0.5;
      if (locked) {
        const a = Math.min(1, (0.92 - p) * 10);
        g.fillStyle = rgba(C.lilac, 0.6 * a); g.fillRect(peakX * dpr - dpr, h * 0.1, 2 * dpr, h * 0.8);
      }
      label(g, dpr, "twin", 14 * dpr, h * 0.1, C.cyan, 0.7);
      label(g, dpr, "copy", 14 * dpr, h * 0.92, C.amber, 0.7);
      const ro = document.querySelector('[data-readout="align"]');
      if (ro) ro.textContent = locked ? "offset: 0 samples · locked" : `offset: ${Math.round(off * 37).toLocaleString("en-US")} samples`;
    },

    flip(g, w, h, dpr, t) {
      const cyc = 4.5, p = (t % cyc) / cyc;
      const s = Math.cos(Math.PI * (easeIO(p / 0.35) - easeIO((p - 0.6) / 0.35)));   // +1 → −1 → +1
      const mid = h * 0.5, amp = h * 0.28;
      line(g, w, dpr, mid, amp, (x) => song(x), C.amber, 0.14, 2, 0);
      line(g, w, dpr, mid, amp * s, (x) => song(x), C.amber, 0.95);
      g.strokeStyle = rgba(C.grid, 0.12); g.lineWidth = dpr; g.setLineDash([4 * dpr, 6 * dpr]);
      g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke(); g.setLineDash([]);
      const pol = s >= 0 ? "+" : "−";
      g.save();
      g.font = `600 ${22 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`;
      g.fillStyle = rgba(C.amber, 0.4 + 0.6 * Math.abs(s)); g.textBaseline = "top";
      g.fillText(pol, 16 * dpr, 12 * dpr);
      g.restore();
      label(g, dpr, "polarity", 36 * dpr, 24 * dpr, C.grid, 0.35);
    },

    sum(g, w, h, dpr, t) {
      const cyc = 6, p = (t % cyc) / cyc;
      const W = w / dpr, at = W * 0.6;
      const amp = h * 0.13, top = h * 0.28, bot = h * 0.76;
      const twin = (x) => song(x) + blip(x, at, 36);
      const inv = (x) => -song(x);
      line(g, w, dpr, top, amp, twin, C.cyan, 0.8, 1.8, 6);
      line(g, w, dpr, top, amp, inv, C.amber, 0.8, 1.8, 6);
      const sweep = ease((p - 0.1) / 0.45) * w * (p < 0.92 ? 1 : 0);
      g.strokeStyle = rgba(C.grid, 0.1); g.lineWidth = dpr;
      g.beginPath(); g.moveTo(0, bot); g.lineTo(w, bot); g.stroke();
      if (sweep > 0) {
        line(g, w, dpr, bot, amp * 1.6, (x) => twin(x) + inv(x), C.lilac, 1, 2.2, 18, 0, sweep);
        if (sweep < w) { g.fillStyle = rgba(C.lilac, 0.8); g.fillRect(sweep - dpr, top - amp * 1.5, 2 * dpr, bot - top + amp * 3); }
      }
      label(g, dpr, "+", 12 * dpr, top, C.grid, 0.4);
      label(g, dpr, "=", 12 * dpr, bot, C.grid, 0.4);
    },

    inverse(g, w, h, dpr, t) {
      const cyc = 6, p = (t % cyc) / cyc;
      const W = w / dpr, at = W * 0.55;
      const amp = h * 0.1, r1 = h * 0.2, r2 = h * 0.48, r3 = h * 0.8;
      const twin = (x) => song(x * 0.9) + blip(x, at, 36);
      const isoInv = (x) => -blip(x, at, 36);
      line(g, w, dpr, r1, amp, twin, C.cyan, 0.85, 1.8, 6);
      line(g, w, dpr, r2, amp, isoInv, C.lilac, 0.95, 1.8, 12);
      const sweep = ease((p - 0.1) / 0.45) * w * (p < 0.92 ? 1 : 0);
      if (sweep > 0) line(g, w, dpr, r3, amp, (x) => twin(x) + isoInv(x), C.mint, 0.95, 2, 12, 0, sweep);
      if (sweep > 0 && sweep < w) { g.fillStyle = rgba(C.mint, 0.7); g.fillRect(sweep - dpr, r1 - amp * 1.4, 2 * dpr, r3 - r1 + amp * 2.8); }
      g.fillStyle = rgba(C.lilac, 0.05); g.fillRect((at - 50) * dpr, 0, 100 * dpr, h);
      label(g, dpr, "+", 12 * dpr, r2, C.grid, 0.4);
      label(g, dpr, "=", 12 * dpr, r3, C.grid, 0.4);
    },
  };
  function mix(a, b, t) { const A = a.split(",").map(Number), B = b.split(",").map(Number); return A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(","); }

  // ---------------------------------------------------- misalign playground
  // A pseudo-random "mix" with a realistic, high-frequency-light spectrum at 44.1 kHz.
  const SR = 44100, N = 4096;
  const partials = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const f = 60 * Math.pow(16000 / 60, rnd());
    partials.push({ w: (2 * Math.PI * f) / SR, a: 1 / Math.pow(f / 60, 0.75), ph: rnd() * 6.283 });
  }
  const mixAt = (n) => { let s = 0; for (const q of partials) s += q.a * Math.sin(q.w * n + q.ph); return s; };
  const MIX = new Float32Array(N + 64);
  for (let i = 0; i < MIX.length; i++) MIX[i] = mixAt(i);
  let peakMix = 0; for (const v of MIX) peakMix = Math.max(peakMix, Math.abs(v));
  const HID = new Float32Array(N + 64);           // the hidden sound, 30 dB below the mix
  for (let i = 0; i < HID.length; i++) { const u = (i - 2600) / 260; HID[i] = Math.exp(-u * u) * Math.sin(i * 0.09) * peakMix * 0.12; }
  let energy = 0; for (let i = 32; i < N + 32; i++) energy += MIX[i] * MIX[i];
  const misState = { d: 0 };
  const residue = (i, d) => MIX[i] + HID[i] - MIX[i - d];

  function misalignDb(d) {
    if (d === 0) return -Infinity;
    let e = 0; for (let i = 32; i < N + 32; i++) { const r = MIX[i] - MIX[i - d]; e += r * r; }
    return 10 * Math.log10(e / energy);
  }
  demos.misalign = (g, w, h, dpr) => {
    const d = misState.d, mid = h / 2, amp = (h * 0.42) / peakMix;
    const n0 = 1800, n1 = 3400, span = n1 - n0;
    g.save();
    // faint original for scale
    g.strokeStyle = rgba(C.cyan, 0.16); g.lineWidth = dpr;
    g.beginPath();
    for (let x = 0; x <= w; x += dpr) { const i = n0 + Math.floor((x / w) * span) + 32; const y = mid - MIX[i] * amp; x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    // residue
    g.strokeStyle = rgba(d === 0 ? C.lilac : d < 3 ? C.lilac : C.danger, 0.95);
    g.shadowBlur = 10 * dpr; g.shadowColor = g.strokeStyle;
    g.lineWidth = 1.4 * dpr;
    g.beginPath();
    for (let x = 0; x <= w; x += dpr) { const i = n0 + Math.floor((x / w) * span) + 32; const y = mid - residue(i, d) * amp; x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    g.restore();
    label(g, dpr, d === 0 ? "only the hidden sound is left" : d < 3 ? "highs leak through" : "the mix bleeds back in", 14 * dpr, 18 * dpr, C.grid, 0.5);
  };
  const mis = document.getElementById("mis");
  if (mis) {
    const upd = () => {
      misState.d = Number(mis.value);
      mis.style.setProperty("--p", `${(misState.d / Number(mis.max)) * 100}%`);
      document.getElementById("misOut").textContent = `${misState.d} sample${misState.d === 1 ? "" : "s"}`;
      const db = misalignDb(misState.d);
      document.getElementById("misDb").textContent = Number.isFinite(db) ? db.toFixed(1).replace("-", "−") : "−∞";
      document.querySelector(".pg-db").classList.toggle("bad", db > -6);
      wake();
    };
    mis.addEventListener("input", upd);
    upd();
  }

  // ------------------------------------------------------------ loop
  const canvases = [...document.querySelectorAll("canvas.demo")].map((el) => ({ el, name: el.dataset.demo, visible: false, t0: 0 }));
  const vis = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const c = canvases.find((c) => c.el === e.target);
      if (!c) continue;
      if (e.isIntersecting && !c.visible) c.t0 = performance.now();
      c.visible = e.isIntersecting;
    }
    wake();
  }, { threshold: 0.05 });
  canvases.forEach((c) => vis.observe(c.el));

  function frame(now) {
    let any = false;
    for (const c of canvases) {
      if (!c.visible) continue;
      const { w, h, dpr } = sizeCanvas(c.el);
      const g = c.el.getContext("2d");
      g.clearRect(0, 0, w, h);
      grid(g, w, h, dpr);
      // with reduced motion, freeze each demo on its most telling frame
      const still = { hero: 3.5, find: 4.5, align: 3.5, flip: 2, sum: 4.5, inverse: 4.5 };
      const t = reduceMotion ? (still[c.name] || 0) : (now - c.t0) / 1000;
      demos[c.name] && demos[c.name](g, w, h, dpr, t, c.el);
      if (!reduceMotion && c.name !== "misalign") any = true;
    }
    if (any) requestAnimationFrame(frame); else running = false;
  }
  function wake() { if (!running) { running = true; requestAnimationFrame(frame); } }
  addEventListener("resize", wake);
  addEventListener("isol8:theme", () => requestAnimationFrame(() => { readPalette(); wake(); }));
  wake();
})();

/*
 * isol8 engine — finds sample-identical "twin" sections in a song and isolates
 * what differs between them by phase cancellation:  result[t] = x[t] - x[t - lag].
 *
 * Pure JavaScript, no dependencies. Runs in a Web Worker, on the main thread, or
 * in Node (for tests).
 *
 * Audio is passed as an array of Float32Array channels at the file's NATIVE
 * sample rate. Nothing here resamples: a resampled copy would turn the integer
 * offset between twins into a fractional one and ruin the cancellation.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Isol8Engine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------ FFT
  // Iterative radix-2 complex FFT on split re/im Float64Arrays, plus a real FFT
  // built on a half-size complex FFT.
  const fftCache = new Map();

  function ComplexFFT(n) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    this.n = n;
    const rev = new Uint32Array(n);
    let bits = 0;
    while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    this.rev = rev;
    const half = n >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  // inverse=false: X[k] = sum x[t] e^{-2 pi i k t / n}; inverse=true: unnormalised e^{+...}
  ComplexFFT.prototype.transform = function (re, im, inverse) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let a = 0; a < n; a += 2) { // size-2 stage, no twiddles
      const b = a + 1, xr = re[b], xi = im[b];
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
    if (n <= 16384) {
      // small (cache-resident) sizes: twiddle-outer order, each twiddle loaded once per stage
      for (let size = 4; size <= n; size <<= 1) {
        const halfSize = size >> 1, step = n / size;
        for (let k = 0; k < halfSize; k++) {
          const wr = cs[k * step], wi = sgn * sn[k * step];
          for (let a = k; a < n; a += size) {
            const b = a + halfSize;
            const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          }
        }
      }
      return;
    }
    // large sizes: block-outer order keeps memory access sequential
    for (let size = 4; size <= n; size <<= 1) {
      const halfSize = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, ti = 0; k < halfSize; k++, ti += step) {
          const wr = cs[ti], wi = sgn * sn[ti];
          const a = start + k, b = a + halfSize;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };

  function RealFFT(n) {
    this.n = n;
    this.h = n >> 1;
    this.c = new ComplexFFT(this.h);
    this.zr = new Float64Array(this.h);
    this.zi = new Float64Array(this.h);
    this.wr = new Float64Array(this.h + 1);
    this.wi = new Float64Array(this.h + 1);
    for (let k = 0; k <= this.h; k++) {
      this.wr[k] = Math.cos((2 * Math.PI * k) / n);
      this.wi[k] = -Math.sin((2 * Math.PI * k) / n);
    }
  }
  function rfftFor(n) {
    let f = fftCache.get(n);
    if (!f) { f = new RealFFT(n); fftCache.set(n, f); }
    return f;
  }
  /** Forward real FFT of x (length <= n, zero padded) -> outRe/outIm length n/2+1. */
  RealFFT.prototype.forward = function (x, outRe, outIm, offset, length) {
    const h = this.h, zr = this.zr, zi = this.zi;
    offset = offset || 0;
    const len = length === undefined ? x.length - offset : length;
    for (let k = 0; k < h; k++) {
      const i0 = 2 * k, i1 = i0 + 1;
      zr[k] = i0 < len ? x[offset + i0] : 0;
      zi[k] = i1 < len ? x[offset + i1] : 0;
    }
    this.c.transform(zr, zi, false);
    for (let k = 0; k <= h; k++) {
      const k1 = k % h, k2 = (h - k) % h;
      const ar = zr[k1], ai = zi[k1], br = zr[k2], bi = -zi[k2]; // Z[k], conj(Z[h-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);           // even part
      const or_ = 0.5 * (ai - bi), oi = -0.5 * (ar - br);         // odd part: (Z - conj)/(2i)
      const wr = this.wr[k], wi = this.wi[k];
      outRe[k] = er + wr * or_ - wi * oi;
      outIm[k] = ei + wr * oi + wi * or_;
    }
  };
  /** Inverse real FFT (normalised) of half spectrum -> out (length n). */
  RealFFT.prototype.inverse = function (inRe, inIm, out) {
    const h = this.h, zr = this.zr, zi = this.zi, n = this.n;
    for (let k = 0; k < h; k++) {
      const ar = inRe[k], ai = inIm[k], br = inRe[h - k], bi = -inIm[h - k]; // X[k], conj(X[h-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      const wr = this.wr[k], wi = -this.wi[k];                   // e^{+2 pi i k/n}
      const or_ = dr * wr - di * wi, oi = dr * wi + di * wr;
      zr[k] = er - oi; zi[k] = ei + or_;                          // Fe + i*Fo
    }
    this.c.transform(zr, zi, true);
    const s = 1 / h;
    for (let k = 0; k < h; k++) { out[2 * k] = zr[k] * s; out[2 * k + 1] = zi[k] * s; }
    return out;
  };

  const hannCache = new Map();
  function hann(n) { // periodic Hann (scipy get_window('hann', n))
    let w = hannCache.get(n);
    if (!w) {
      w = new Float64Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      hannCache.set(n, w);
    }
    return w;
  }

  // ------------------------------------------------------------- helpers
  function nextPow2(v) { let n = 1; while (n < v) n <<= 1; return n; }

  /** scipy.ndimage.uniform_filter1d(x, size) with mode='reflect'. */
  function uniformFilter1d(x, size) {
    const n = x.length, out = new Float64Array(n);
    if (size <= 1) { out.set(x); return out; }
    const left = size >> 1;
    const at = (i) => {
      // 'reflect' (d c b a | a b c d | d c b a)
      while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1;
      return x[i];
    };
    let acc = 0;
    for (let j = 0; j < size; j++) acc += at(j - left);
    out[0] = acc / size;
    for (let i = 1; i < n; i++) {
      acc += at(i - left + size - 1) - at(i - left - 1);
      out[i] = acc / size;
    }
    return out;
  }

  /** Fill False gaps shorter than `gap` that lie between True runs; returns [start,end) runs. */
  function runsWithGapFill(on, gap) {
    const runs = [];
    let i = 0;
    const n = on.length;
    while (i < n) {
      if (!on[i]) { i++; continue; }
      let j = i;
      while (j < n && on[j]) j++;
      runs.push([i, j]);
      i = j;
    }
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] < gap) last[1] = r[1];
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  function mono(channels) {
    const n = channels[0].length, c = channels.length, m = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) m[i] += ch[i];
    if (c > 1) for (let i = 0; i < n; i++) m[i] /= c;
    return m;
  }

  /** Level of a section minus level of its isolation, dB (both twins averaged). */
  function cancelDb(channels, lag, a, b) {
    // the copy can't start before the song does, nor the twin run past its end
    a = Math.max(a, lag); b = Math.min(b, channels[0].length);
    if (b <= a) return 0;
    let e1 = 0, e2 = 0, er = 0;
    for (const ch of channels) {
      for (let i = a; i < b; i++) {
        const s1 = ch[i], s2 = ch[i - lag], r = s1 - s2;
        e1 += s1 * s1; e2 += s2 * s2; er += r * r;
      }
    }
    const db = 10 * Math.log10((e1 + e2) / 2 / (er + 1e-20));
    return Number.isFinite(db) ? db : 0;               // silence on both sides, or bad samples
  }

  function hopFor(sr) { return Math.pow(2, Math.round(Math.log2(sr * 0.0464))); }

  // ------------------------------------------------------ coarse search
  function coarseFeatures(m, sr) {
    const hop = hopFor(sr), nper = 2 * hop;
    const nFrames = m.length >= nper ? 1 + Math.floor((m.length - nper) / hop) : 0;
    const maxBin = Math.floor(11000 / (sr / nper));
    // band edges: np.unique(np.geomspace(2, maxBin, 129).astype(int))
    const raw = [];
    for (let i = 0; i <= 128; i++) {
      const v = i === 128 ? maxBin : 2 * Math.pow(maxBin / 2, i / 128);
      raw.push(Math.floor(v + 1e-9));
    }
    const edges = [...new Set(raw)];
    const D = edges.length - 1;
    const F = new Float32Array(nFrames * D);
    const fft = rfftFor(nper), w = hann(nper), scale = 1 / (nper / 2);
    const buf = new Float64Array(nper), re = new Float64Array(nper / 2 + 1), im = new Float64Array(nper / 2 + 1);
    const mag = new Float64Array(maxBin);
    for (let f = 0; f < nFrames; f++) {
      const off = f * hop;
      for (let i = 0; i < nper; i++) buf[i] = m[off + i] * w[i];
      fft.forward(buf, re, im);
      for (let k = 0; k < maxBin; k++) mag[k] = Math.hypot(re[k], im[k]) * scale;
      let mean = 0;
      const row = f * D;
      for (let d = 0; d < D; d++) {
        let s = 0;
        for (let k = edges[d]; k < edges[d + 1]; k++) s += mag[k];
        const v = Math.log1p(100 * s);
        F[row + d] = v; mean += v;
      }
      mean /= D;
      let norm = 0;
      for (let d = 0; d < D; d++) { F[row + d] -= mean; norm += F[row + d] * F[row + d]; }
      norm = Math.sqrt(norm) + 1e-9;
      for (let d = 0; d < D; d++) F[row + d] /= norm;
    }
    return { F, D, n: nFrames, hop };
  }

  /** Raw coarse candidates for lags in [lagFrom, lagTo) (frames). Separate so it can be split across workers. */
  function coarseScan(feat, sr, opt, lagFrom, lagTo, progress) {
    const { F, D, n, hop } = feat;
    const fps = sr / hop;
    const minLag = Math.floor(opt.minLagS * fps), minLen = Math.floor(opt.minLenS * fps);
    const win = Math.max(1, Math.floor(opt.smoothS * fps));
    lagFrom = Math.max(lagFrom === undefined ? 0 : lagFrom, minLag);
    lagTo = Math.min(lagTo === undefined ? n : lagTo, n - minLen);
    const cands = [];
    const d4 = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const on = new Uint8Array(n);
    const total = Math.max(1, lagTo - lagFrom);
    for (let lag0 = lagFrom; lag0 < lagTo; lag0 += 4) {
      const nl = Math.min(4, lagTo - lag0);
      const len0 = n - lag0;
      // 4 diagonals at once: row t is shared by the four products
      for (let t = 0; t < len0; t++) {
        const a = t * D, b = (t + lag0) * D;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        const avail = Math.min(nl, n - t - lag0);
        if (avail === 4) {
          for (let k = 0; k < D; k++) {
            const f = F[a + k];
            s0 += f * F[b + k]; s1 += f * F[b + D + k]; s2 += f * F[b + 2 * D + k]; s3 += f * F[b + 3 * D + k];
          }
        } else {
          for (let k = 0; k < D; k++) {
            const f = F[a + k];
            s0 += f * F[b + k];
            if (avail > 1) s1 += f * F[b + D + k];
            if (avail > 2) s2 += f * F[b + 2 * D + k];
          }
        }
        d4[0][t] = s0; d4[1][t] = s1; d4[2][t] = s2; d4[3][t] = s3;
      }
      for (let j = 0; j < nl; j++) {
        const lag = lag0 + j, len = n - lag;
        const sm = uniformFilter1d(d4[j].subarray(0, len), win);
        const strong = [];
        const collect = (thr, weak) => {
          let any = false;
          for (let t = 0; t < len; t++) { const v = sm[t] > thr; on[t] = v ? 1 : 0; if (v) any = true; }
          if (!any) return false;
          for (const [t0, t1] of runsWithGapFill(on.subarray(0, len), win)) {
            if (t1 - t0 < minLen) continue;
            // a weak run that is mostly a strong run is the same candidate again
            if (weak && strong.some(([s0, s1]) => Math.min(t1, s1) - Math.max(t0, s0) > 0.5 * (t1 - t0))) continue;
            let s = 0;
            for (let t = t0; t < t1; t++) s += sm[t];
            const mean = s / (t1 - t0);
            if (weak) cands.push({ score: mean * (t1 - t0), lag, t0, t1, sim: mean, weak: true });
            else { strong.push([t0, t1]); cands.push({ score: mean * (t1 - t0), lag, t0, t1, sim: mean }); }
          }
          return true;
        };
        // passages that share only a layer (same backing, different lead) look less alike
        const weakThr = opt.shareThr > 0 && opt.weakSimThr < opt.simThr ? opt.weakSimThr : 0;
        collect(opt.simThr, false);
        if (weakThr) collect(weakThr, true);
      }
      if (progress && ((lag0 - lagFrom) & 63) === 0) progress((lag0 - lagFrom) / total);
    }
    return cands;
  }

  /** Non-maximum suppression over raw candidates -> candidate list in samples. */
  function selectCandidates(raw, hop, opt, sr) {
    const order = (p, q) => q.score - p.score || p.lag - q.lag || p.t0 - q.t0;
    const kept = [];
    const pick = (cands, radius, limit) => {
      let n = 0;
      for (const c of cands) {
        if (n >= limit) break;
        let dup = false;
        for (const k of kept) {
          if (Math.abs(k.lag - c.lag) <= radius) {
            const ov = Math.min(c.t1, k.t1) - Math.max(c.t0, k.t0);
            if (ov > 0.5 * Math.min(c.t1 - c.t0, k.t1 - k.t0)) { dup = true; break; }
          }
        }
        if (!dup) { kept.push(c); n++; }
      }
    };
    pick(raw.filter((c) => !c.weak).sort(order), 3, opt.maxCandidates);
    // weak candidates smear over many neighbouring offsets: keep the best of each cluster
    pick(raw.filter((c) => c.weak).sort(order), Math.max(3, Math.round((opt.weakLagNmsS * (sr || 44100)) / hop)), opt.maxWeakCandidates);
    return kept.map((c) => {
      const o = { lag: c.lag * hop, a: (c.t0 + c.lag) * hop, b: (c.t1 + c.lag) * hop, sim: c.sim };
      if (c.weak) o.weak = true;
      return o;
    });
  }

  // ------------------------------------------------- sample-exact lag
  /** Candidate lags from PHAT-whitened and plain cross-correlation of m[a:b] vs m[a-L:b-L]. */
  function xcorrLagPeaks(m, a, b, lagGuess, search, nPeaks) {
    let lo = a - lagGuess - search;
    if (lo < 0) { a -= lo; lo = 0; }
    const segLen = b - a, refLen = b - lagGuess + search - lo;
    const N = nextPow2(segLen + refLen);
    const fft = rfftFor(N), H = N / 2 + 1;
    const sr_ = new Float64Array(H), si = new Float64Array(H), rr = new Float64Array(H), ri = new Float64Array(H);
    fft.forward(m, sr_, si, a, segLen);
    fft.forward(m, rr, ri, lo, refLen);
    const gr = new Float64Array(H), gi = new Float64Array(H), pr = new Float64Array(H), pi = new Float64Array(H);
    for (let k = 0; k < H; k++) { // seg * conj(ref)
      const r = sr_[k] * rr[k] + si[k] * ri[k];
      const i = si[k] * rr[k] - sr_[k] * ri[k];
      gr[k] = r; gi[k] = i;
      const mag = Math.hypot(r, i) + 1e-12;
      pr[k] = r / mag; pi[k] = i / mag;
    }
    const out = [];
    const cc = new Float64Array(N);
    for (const [R, I] of [[pr, pi], [gr, gi]]) {
      fft.inverse(R, I, cc);
      const vals = new Float64Array(2 * search + 1);
      for (let k = 0; k <= 2 * search; k++) vals[k] = cc[((-k % N) + N) % N];
      const order = Array.from(vals.keys()).sort((x, y) => vals[y] - vals[x]);
      const picked = [];
      for (const k of order) {
        if (picked.every((p) => Math.abs(k - p) > 8)) picked.push(k);
        if (picked.length >= nPeaks) break;
      }
      for (const k of picked) out.push(lagGuess + search - k);
    }
    return [...new Set(out)];
  }

  function refineLag(ch, m, sr, lagGuess, a, b, hop, opt) {
    const search = 2 * hop;
    // correlation on a short central chunk, scoring on a longer one
    const mid = (a + b) >> 1;
    // correlation chunk sized so seg + ref fit one FFT of xcorrFftSize
    const xc = Math.floor(Math.min(opt.xcorrChunkS * sr, (opt.xcorrFftSize - 2 * search - 16) / 2) / 2);
    const sc = Math.floor(opt.scoreChunkS * sr / 2);
    const xa = Math.max(a, mid - xc), xb = Math.min(b, mid + xc);
    const shortlist = xcorrLagPeaks(m, xa, xb, lagGuess, search, 5);
    let sa = Math.max(a, mid - sc, lagGuess + search + 8);
    const sb = Math.min(b, mid + sc);
    const scores = new Map();
    const score = (L) => { if (!scores.has(L)) scores.set(L, cancelDb(ch, L, sa, sb)); return scores.get(L); };
    for (const L0 of shortlist) for (let L = L0 - 1; L <= L0 + 1; L++) score(L);
    let best = null;
    for (const [L, v] of scores) if (best === null || v > scores.get(best)) best = L;
    // polish further around the winner
    for (let L = best - 2; L <= best + 2; L++) score(L);
    for (const [L, v] of scores) if (v > scores.get(best)) best = L;
    const sharp = score(best) - 0.5 * (score(best - 1) + score(best + 1));
    return { lag: best, sharpness: sharp };
  }

  /**
   * Lag lock for a weak candidate. Where only a layer is shared, the full-band level barely
   * moves between neighbouring offsets, so cancellation can't pick the sample. The shared-layer
   * measure can: it drops sharply one sample off. Scored on frames spread over the whole span.
   */
  function refineLagShared(ch, m, sr, lagGuess, a, b, hop, opt) {
    const search = 2 * hop, mid = (a + b) >> 1;
    const xc = Math.floor(Math.min(opt.xcorrChunkS * sr, (opt.xcorrFftSize - 2 * search - 16) / 2) / 2);
    const shortlist = xcorrLagPeaks(m, Math.max(a, mid - xc), Math.min(b, mid + xc), lagGuess, search, 3);
    const scores = new Map();
    const score = (L) => {
      if (!scores.has(L)) {
        const prof = new Profile(ch, sr, L, opt.nullDb);
        const f0 = Math.max(0, prof.frameOf(Math.max(a, L) + prof.hop - 1)), f1 = Math.min(prof.T, prof.frameOf(b - prof.nper) + 1);
        const stride = Math.max(1, Math.ceil((f1 - f0) / 48));
        let sum = 0, cnt = 0;
        for (let t = f0; t < f1; t += stride) { prof.compute(t, t + 1); sum += prof.share[t]; cnt++; }
        scores.set(L, cnt ? sum / cnt : 0);
      }
      return scores.get(L);
    };
    for (const L0 of shortlist) score(L0);
    let best = shortlist[0];
    for (const [L, v] of scores) if (v > scores.get(best)) best = L;
    for (let step = 0; step < 4; step++) {               // walk to the local peak
      const up = score(best + 1), down = score(best - 1), here = score(best);
      if (up > here && up >= down) best += 1; else if (down > here) best -= 1; else break;
    }
    return { lag: best, sharpness: score(best) - 0.5 * (score(best - 1) + score(best + 1)), share: score(best) };
  }

  // ---------------------------------------------------- region finding
  const BANDS = [[0, 200], [200, 1000], [1000, 4000], [4000, 20000]];

  /**
   * Lazily computed per-frame cancellation profile for one lag, on a fixed frame grid
   * (frame t starts at sample lag + t*hop). For each frame: energy fraction of TF bins
   * cancelling by >= nullDb, plus per-band energy sums. Frames are computed once even
   * when the analysis window grows.
   *
   * `share` measures something weaker: how much of the frame is the same recording at all,
   * even when it doesn't cancel deeply. It is the level-weighted mean, over the bins above
   * SHARE_MIN_HZ, of 1 - |X1 - X2|^2 / (|X1|^2 + |X2|^2): 1 where the two passages are
   * identical, about 0 where they are unrelated. Weighting by level rather than energy keeps
   * a loud unrelated part (a different bass line, a different vocal) from hiding a shared layer.
   */
  const SHARE_MIN_HZ = 100;
  function Profile(ch, sr, lag, nullDb) {
    this.ch = ch; this.sr = sr; this.lag = lag;
    this.nper = sr <= 48000 ? 2048 : 4096; this.hop = this.nper; // ~46 ms, non-overlapping
    const n = ch[0].length;
    this.T = n - lag >= this.nper ? 1 + Math.floor((n - lag - this.nper) / this.hop) : 0;
    this.frac = new Float64Array(this.T);
    this.share = new Float64Array(this.T);
    this.kShare = Math.ceil((SHARE_MIN_HZ * this.nper) / sr);
    this.bandP = new Float64Array(this.T * 4); this.bandD = new Float64Array(this.T * 4);
    this.done = new Uint8Array(this.T);
    this.thr = Math.pow(10, -nullDb / 10);
    const H = this.nper / 2 + 1;
    this.bandOf = new Uint8Array(H);
    for (let k = 0; k < H; k++) {
      const f = (k * sr) / this.nper;
      let bi = 3;
      for (let j = 0; j < 4; j++) if (f >= BANDS[j][0] && f < BANDS[j][1]) { bi = j; break; }
      this.bandOf[k] = bi;
    }
    this.b1 = new Float64Array(this.nper); this.b2 = new Float64Array(this.nper);
    this.r1 = new Float64Array(H); this.i1 = new Float64Array(H); this.r2 = new Float64Array(H); this.i2 = new Float64Array(H);
  }
  Profile.prototype.frameOf = function (sample) { return Math.floor((sample - this.lag) / this.hop); };
  Profile.prototype.startOf = function (t) { return this.lag + t * this.hop; };
  Profile.prototype.compute = function (t0, t1) {
    t0 = Math.max(0, t0); t1 = Math.min(this.T, t1);
    const { nper, hop, lag, thr, bandOf, b1, b2, r1, i1, r2, i2, kShare } = this;
    const fft = rfftFor(nper), w = hann(nper), H = nper / 2 + 1, sc2 = Math.pow(1 / (nper / 2), 2);
    for (let t = t0; t < t1; t++) {
      if (this.done[t]) continue;
      const off = lag + t * hop;
      let wsum = 0, dsum = 0, asum = 0, ssum = 0;
      for (const c of this.ch) {
        for (let i = 0; i < nper; i++) { b1[i] = c[off + i] * w[i]; b2[i] = c[off - lag + i] * w[i]; }
        fft.forward(b1, r1, i1);
        fft.forward(b2, r2, i2);
        for (let k = 0; k < H; k++) {
          const P = (r1[k] * r1[k] + i1[k] * i1[k] + r2[k] * r2[k] + i2[k] * i2[k]) * 0.5 * sc2;
          const dr = r1[k] - r2[k], di = i1[k] - i2[k], Dk = (dr * dr + di * di) * sc2;
          wsum += P;
          this.bandP[t * 4 + bandOf[k]] += P;
          if (Dk < P * thr) { dsum += P; this.bandD[t * 4 + bandOf[k]] += P; }
          if (k >= kShare && P > 0) { const a = Math.sqrt(P); asum += a; ssum += a * (1 - Dk / (2 * P)); }
        }
      }
      this.frac[t] = wsum < 1e-7 ? 0 : dsum / (wsum + 1e-12);
      this.share[t] = wsum < 1e-7 || asum <= 0 ? 0 : Math.max(0, ssum / asum);
      this.done[t] = 1;
    }
  };

  function findRegions(ch, sr, lag, a, b, opt, shared, partial) {
    // analyse a small margin first; grow the window while a region touches its edge
    const prof = shared || new Profile(ch, sr, lag, opt.nullDb);
    const n = ch[0].length, step = Math.floor(opt.extendStepS * sr);
    let lo = Math.max(lag, a - step), hi = Math.min(n, b + step);
    let regs;
    for (let iter = 0; iter < 200; iter++) {
      regs = regionsIn(prof, lo, hi, opt, partial);
      const edge = Math.floor(0.5 * sr);
      const growLo = lo > lag && regs.some((r) => r.s - lo < edge);
      const growHi = hi < n && regs.some((r) => hi - r.e < edge);
      if (!growLo && !growHi) break;
      if (growLo) lo = Math.max(lag, lo - step);
      if (growHi) hi = Math.min(n, hi + step);
    }
    return regs;
  }

  /** Zones (dst samples) where the coarse spectra at this lag look alike anywhere in the song. */
  function similarZones(feat, sr, lag, opt) {
    const { F, D, n, hop } = feat;
    const L = Math.round(lag / hop), len = n - L;
    if (len <= 0) return [];
    const d = new Float64Array(len);
    for (let t = 0; t < len; t++) {
      const a = t * D, b = (t + L) * D;
      let s = 0;
      for (let k = 0; k < D; k++) s += F[a + k] * F[b + k];
      d[t] = s;
    }
    const sm = uniformFilter1d(d, Math.max(1, Math.floor(sr / hop)));
    const on = new Uint8Array(len);
    for (let t = 0; t < len; t++) on[t] = sm[t] > opt.zoneThr ? 1 : 0;
    return runsWithGapFill(on, Math.floor(sr / hop))
      .filter(([t0, t1]) => (t1 - t0) * hop >= opt.minZoneS * sr)
      .map(([t0, t1]) => [(t0 + L) * hop, (t1 + L) * hop]);
  }

  /** Every region where the copy at `lag` cancels: the candidate's own zone plus any other
   *  zone the coarse spectra flag, sharing one lazily computed profile. */
  function regionsForLag(ch, sr, lag, a, b, opt, feat, partialOnly) {
    const prof = new Profile(ch, sr, lag, opt.nullDb);
    const zones = partialOnly ? [] : [[a, b]];
    if (feat && !partialOnly) for (const z of similarZones(feat, sr, lag, opt)) zones.push(z);
    const out = [];
    for (const [za, zb] of zones) {
      if (out.some((r) => za >= r.s && zb <= r.e)) continue;     // already covered
      for (const r of findRegions(ch, sr, lag, za, zb, opt, prof)) {
        if (!out.some((q) => Math.min(q.e, r.e) > Math.max(q.s, r.s))) out.push(r);
      }
    }
    // Partial twins: stretches that share a sample-identical layer under different material,
    // so they don't null deeply. (finalize drops the ones that are only a deep result's fringe.)
    if (opt.shareThr > 0) out.push(...findRegions(ch, sr, lag, a, b, opt, prof, true));
    return out;
  }

  function regionsIn(p, a, b, opt, partial) {
    const f0 = Math.max(0, Math.ceil((a - p.lag) / p.hop)), f1 = Math.min(p.T, p.frameOf(b - p.nper) + 1);
    if (f1 - f0 <= 0) return [];
    p.compute(f0, f1);
    const T = f1 - f0, frac = p.frac.subarray(f0, f1), share = p.share.subarray(f0, f1);
    // deep regions follow the cancelling share; partial ones follow the shared-layer measure
    // (a shared layer comes and goes with the arrangement, so it is smoothed and bridged further)
    const val = partial ? share : frac, thr = partial ? opt.shareThr : opt.fracThr;
    const minS = partial ? opt.minPartialS : opt.minRegionS;
    const fps = p.sr / p.hop;
    const sm = uniformFilter1d(val, Math.max(1, Math.floor((partial ? opt.partialSmoothS : opt.regionSmoothS) * fps)));
    const on = new Uint8Array(T);
    for (let t = 0; t < T; t++) on[t] = sm[t] > thr ? 1 : 0;
    const regs = [];
    for (let [t0, t1] of runsWithGapFill(on, Math.max(1, Math.floor((partial ? opt.partialGapS : opt.gapS) * fps)))) {
      if ((t1 - t0) / fps < minS) continue;
      let g0 = -1, g1 = -1; // tighten to raw profile
      for (let t = t0; t < t1; t++) if (val[t] > thr) { if (g0 < 0) g0 = t; g1 = t; }
      if (g0 >= 0) { t0 = g0; t1 = g1 + 1; }
      const s = p.startOf(f0 + t0);
      const e = Math.min(p.startOf(f0 + Math.min(t1, T - 1)) + p.hop, b);
      let fm = 0, sh = 0;
      const bp = [0, 0, 0, 0], bd = [0, 0, 0, 0];
      for (let t = t0; t < t1; t++) {
        fm += frac[t]; sh += share[t];
        const g = (f0 + t) * 4;
        for (let j = 0; j < 4; j++) { bp[j] += p.bandP[g + j]; bd[j] += p.bandD[g + j]; }
      }
      const reg = { s, e, deep: fm / (t1 - t0), share: sh / (t1 - t0), bands: bp.map((v, j) => (v > 0 ? bd[j] / v : 0)) };
      if (partial) reg.partial = true;
      regs.push(reg);
    }
    return regs;
  }

  // ------------------------------------------------------ pairs & dedup
  function makePair(ch, sr, lag, reg, extra) {
    reg = Object.assign({}, reg, { s: Math.max(reg.s, lag) });
    const p = {
      lag, sr,
      dstStart: reg.s, dstEnd: reg.e,
      srcStart: reg.s - lag, srcEnd: reg.e - lag,
      cancelDb: cancelDb(ch, lag, reg.s, reg.e),
      deep: reg.deep,
      share: reg.share,
      partial: !!reg.partial,
      bands: reg.bands,
      sharpness: extra.sharpness,
      coarseSim: extra.sim,
      merged: 0,
    };
    return scorePair(p);
  }
  function scorePair(p) {
    // a partial twin is judged by how much of it is shared, not by how much nulls
    p.breadth = p.partial ? p.share : p.bands.length ? p.bands.reduce((s, v) => s + v, 0) / p.bands.length : p.deep;
    p.lengthS = (p.dstEnd - p.dstStart) / p.sr;
    p.score = p.breadth * Math.sqrt(p.lengthS) * Math.sqrt(Math.max(p.cancelDb, 0.1));
    return p;
  }
  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

  /** How different two results sound over their common span: 10log10(E(a) / E(a - b)). */
  function isolationSdr(ch, p, q) {
    const s = Math.max(p.dstStart, q.dstStart, p.lag, q.lag), e = Math.min(p.dstEnd, q.dstEnd, ch[0].length);
    if (e <= s) return -Infinity;
    let ea = 0, ed = 0;
    for (const c of ch) {
      for (let t = s; t < e; t++) {
        const a = c[t] - c[t - p.lag], d = c[t - q.lag] - c[t - p.lag]; // (a - b) = x[t-Lq] - x[t-Lp]
        ea += a * a; ed += d * d;
      }
    }
    return 10 * Math.log10((ea + 1e-20) / (ed + 1e-20));
  }

  /**
   * Duplicate prevention. A result is a duplicate when it would sound the same as one
   * already listed:
   *  1. same offset (within sameLagSamples) and destination regions overlapping or
   *     touching (< sameGapS apart): merged into one result covering both;
   *  2. different offset but practically identical audio over most of the shorter
   *     result (difference >= identicalSdrDb below the result, e.g. a chorus pasted
   *     three times gives A->C and B->C with the same isolation): dropped.
   * Results that merely overlap in time but sound different are kept.
   */
  const byScore = (p, q) => q.score - p.score || p.lag - q.lag || p.dstStart - q.dstStart || p.dstEnd - q.dstEnd;
  function dedupe(ch, sr, pairs, opt, stats) {
    pairs.sort(byScore);
    const merged = [];
    for (const p of pairs) {
      const gap = opt.sameGapS * sr;
      const q = merged.find((q) => Math.abs(q.lag - p.lag) <= opt.sameLagSamples && !q.partial === !p.partial &&
        Math.min(p.dstEnd, q.dstEnd) - Math.max(p.dstStart, q.dstStart) > -gap);
      if (q) {
        q.merged += 1;
        // the merged twin can't reach back before q's copy starts (offsets differ by a few samples)
        const s = Math.max(q.lag, Math.min(q.dstStart, p.dstStart)), e = Math.min(ch[0].length, Math.max(q.dstEnd, p.dstEnd));
        if (s !== q.dstStart || e !== q.dstEnd) {
          const wq = q.dstEnd - q.dstStart, wp = p.dstEnd - p.dstStart;
          q.deep = (q.deep * wq + p.deep * wp) / (wq + wp);
          if (q.share !== undefined && p.share !== undefined) q.share = (q.share * wq + p.share * wp) / (wq + wp);
          q.bands = q.bands.map((v, j) => (v * wq + p.bands[j] * wp) / (wq + wp));
          q.dstStart = s; q.dstEnd = e; q.srcStart = s - q.lag; q.srcEnd = e - q.lag;
          q.cancelDb = cancelDb(ch, q.lag, s, e);
          scorePair(q);
        }
      } else merged.push(p);
    }
    merged.sort(byScore);
    const out = [];
    for (const p of merged) {
      const twin = out.find((q) => {
        const sh = Math.min(p.dstEnd - p.dstStart, q.dstEnd - q.dstStart);
        return overlap(p.dstStart, p.dstEnd, q.dstStart, q.dstEnd) >= opt.identicalOverlap * sh &&
               isolationSdr(ch, q, p) >= opt.identicalSdrDb;
      });
      if (twin) { twin.merged += 1 + p.merged; if (stats) stats.duplicates.push({ pair: p, of: twin }); }
      else out.push(p);
    }
    return out;
  }

  const DEFAULTS = {
    minLagS: 2, minLenS: 4, simThr: 0.8, smoothS: 2, maxCandidates: 40,
    xcorrChunkS: 4, xcorrFftSize: 262144, scoreChunkS: 6,
    nullDb: 15, fracThr: 0.3, regionSmoothS: 1, minRegionS: 3, gapS: 1.5,
    minDeep: 0.3, sameLagSamples: 32, sameGapS: 1.0, identicalOverlap: 0.5, identicalSdrDb: 15, maxResults: 40,
    extendStepS: 4, zoneThr: 0.7, minZoneS: 1.5,
    // partial twins (a shared layer under different material); shareThr 0 turns them off
    weakSimThr: 0.6, maxWeakCandidates: 20, weakLagNmsS: 1.5,
    shareThr: 0.3, partialSmoothS: 4, partialGapS: 3, minPartialS: 8, minShare: 0.35,
  };

  function options(o) { return Object.assign({}, DEFAULTS, o || {}); }

  /** Analysis context shared by all steps (one per worker). */
  function prepare(channels, sr, o) {
    const ctx = { ch: channels, sr, opt: options(o), m: mono(channels), n: channels[0].length };
    ctx.feat = null;
    return ctx;
  }
  function features(ctx) {
    if (!ctx.feat) ctx.feat = coarseFeatures(ctx.m, ctx.sr);
    return ctx.feat;
  }
  function lagRange(ctx) {
    const f = features(ctx), fps = ctx.sr / f.hop;
    return [Math.floor(ctx.opt.minLagS * fps), f.n - Math.floor(ctx.opt.minLenS * fps)];
  }
  /** Would candidate c only rediscover material an already-found pair explains? */
  function explained(found, c, hop) {
    return found.some((p) => Math.abs(p.lag - c.lag) <= 3 * hop && c.a >= p.dstStart - hop && c.b <= p.dstEnd + hop);
  }
  /** Sample-exact lag + cancelling regions for one coarse candidate. */
  function analyseCandidate(ctx, c) {
    const { ch, m, sr, opt } = ctx, hop = features(ctx).hop;
    if (c.a - c.lag - 2 * hop - 8 < 0) {               // too close to the start for the search window
      c = Object.assign({}, c, { a: c.lag + 2 * hop + 8 });
      if (c.b - c.a < opt.minRegionS * sr) return [];
    }
    let r;
    if (c.weak) {
      r = refineLagShared(ch, m, sr, c.lag, c.a, c.b, hop, opt);
      if (r.share < 0.5 * opt.shareThr) return [];      // nothing sample-identical at this offset
    } else r = refineLag(ch, m, sr, c.lag, c.a, c.b, hop, opt);
    // a weak candidate only ever yields partial twins: the strong ones own the deep regions
    return regionsForLag(ch, sr, r.lag, c.a, c.b, opt, features(ctx), !!c.weak)
      .map((reg) => makePair(ch, sr, r.lag, reg, { sharpness: r.sharpness, sim: c.sim }));
  }
  /**
   * Filter, de-duplicate and rank. With `stats`, also records what each stage dropped
   * (for the app's debug view): rejected by the filters, merged as duplicates, cut by maxResults.
   */
  function finalize(ctx, found, stats) {
    const { ch, sr, opt } = ctx;
    const kept = [], rejected = [], fringe = [];
    const gap = opt.sameGapS * sr;
    for (const p of found) {
      if (!p.partial) { (p.deep >= opt.minDeep && p.cancelDb > 0 ? kept : rejected).push(p); continue; }
      // a partial twin touching a deep result at the same offset is that result's fringe
      const of = found.find((q) => !q.partial && Math.abs(q.lag - p.lag) <= opt.sameLagSamples &&
        Math.min(p.dstEnd, q.dstEnd) - Math.max(p.dstStart, q.dstStart) > -gap);
      if (of) fringe.push({ pair: p, of });
      else (p.share >= opt.minShare ? kept : rejected).push(p);
    }
    if (stats) Object.assign(stats, { found: found.length - fringe.length, rejected, fringe, afterFilter: kept.length, duplicates: [] });
    const all = dedupe(ch, sr, kept, opt, stats);
    const res = all.slice(0, opt.maxResults);
    if (stats) { stats.afterDedupe = all.length; stats.cut = all.slice(opt.maxResults); }
    res.forEach((p, i) => { p.rank = i + 1; p.id = `${p.lag}:${p.dstStart}`; });
    return res;
  }

  /**
   * Debug probe for a pair the user knows about: aligns copy (at sample `src`) onto twin
   * (at `dst`) for `len` samples, searching +-searchS seconds around the guess, and reports
   * what each stage of the pipeline sees there.
   */
  function probePair(ctx, src, dst, len, searchS) {
    const { ch, m, sr, opt, n } = ctx, f = features(ctx), hop = f.hop;
    const guess = dst - src;
    if (guess <= 0) throw new Error("The twin has to start after the copy.");
    const search = Math.max(2 * hop, Math.round((searchS || 1) * sr));
    const a = Math.max(dst, guess + search + 8), b = Math.min(n, dst + len);
    if (b - a < 0.5 * sr) throw new Error("That span is too short, too close to the start, or runs past the end of the song.");
    // wide search around the guess, scored by how deep each peak cancels
    const BIG = 1 << 21, mid = (a + b) >> 1;
    const xc = Math.floor(Math.min(opt.xcorrChunkS * sr, (BIG - 2 * search - 16) / 2) / 2);
    const shortlist = xcorrLagPeaks(m, Math.max(a, mid - xc), Math.min(b, mid + xc), guess, search, 6);
    const sc = Math.floor((opt.scoreChunkS * sr) / 2), sa = Math.max(a, mid - sc), sb = Math.min(b, mid + sc);
    let coarse = guess, bestDb = -Infinity;
    for (const L of shortlist) { if (sa - L < 0) continue; const v = cancelDb(ch, L, sa, sb); if (v > bestDb) { bestDb = v; coarse = L; } }
    let r = refineLag(ch, m, sr, coarse, a, b, hop, opt);
    let regs = regionsForLag(ch, sr, r.lag, a, b, opt, null);
    if (opt.shareThr > 0 && !regs.some((g) => !g.partial)) {
      // nothing nulls deeply: lock the offset on the shared layer instead, as the search does
      const rs = refineLagShared(ch, m, sr, coarse, a, b, hop, opt);
      if (rs.lag !== r.lag && rs.share >= 0.5 * opt.shareThr) { r = rs; regs = regionsForLag(ch, sr, r.lag, a, b, opt, null); }
    }
    const lag = r.lag;

    // what the coarse scan sees along this diagonal (same smoothing and threshold)
    const F = f.F, D = f.D, Lf = Math.round(lag / hop), win = Math.max(1, Math.floor((opt.smoothS * sr) / hop));
    const t0 = Math.max(0, Math.floor(a / hop) - Lf), t1 = Math.max(t0, Math.min(f.n - Lf, Math.ceil(b / hop) - Lf));
    const m0 = Math.max(0, t0 - win), m1 = Math.min(f.n - Lf, t1 + win);
    const diag = new Float64Array(Math.max(0, m1 - m0));
    for (let t = m0; t < m1; t++) { let v = 0; const x = t * D, y = (t + Lf) * D; for (let k = 0; k < D; k++) v += F[x + k] * F[y + k]; diag[t - m0] = v; }
    const sm = uniformFilter1d(diag, win).subarray(t0 - m0, t1 - m0);
    let sum = 0, max = -Infinity, run = 0, longest = 0;
    for (const v of sm) { sum += v; if (v > max) max = v; run = v > opt.simThr ? run + 1 : 0; if (run > longest) longest = run; }
    const sim = { mean: sm.length ? sum / sm.length : 0, max: sm.length ? max : 0, longestS: (longest * hop) / sr, thr: opt.simThr, hop, start: (t0 + Lf) * hop, values: Array.from(sm) };

    // cancellation profile over the span
    const prof = new Profile(ch, sr, lag, opt.nullDb);
    const pa = Math.max(0, prof.frameOf(a)), pb = Math.max(pa, Math.min(prof.T, prof.frameOf(b)));
    prof.compute(pa, pb);
    const profile = { start: prof.startOf(pa), hop: prof.hop, frac: Array.from(prof.frac.subarray(pa, pb)), share: Array.from(prof.share.subarray(pa, pb)) };
    const regions = regs
      .map((reg) => makePair(ch, sr, lag, reg, { sharpness: r.sharpness, sim: sim.mean }));
    return { guess, lag, sharpness: r.sharpness, a, b, sr, cancelDb: cancelDb(ch, lag, a, b), sim, profile, regions, opt };
  }

  /**
   * Full automatic search on one thread (Node tests / fallback). The browser app runs
   * the same steps spread over a worker pool.
   */
  function detectTwins(channels, sr, onProgress, o) {
    const prog = onProgress || (() => {});
    const t0 = Date.now();
    const ctx = prepare(channels, sr, o);
    prog("map", 0);
    const f = features(ctx);
    const [l0, l1] = lagRange(ctx);
    const raw = coarseScan(f, sr, ctx.opt, l0, l1, (x) => prog("map", x));
    const cands = selectCandidates(raw, f.hop, ctx.opt, sr);
    const found = [];
    cands.forEach((c, i) => {
      prog("lock", i / cands.length);
      found.push(...analyseCandidate(ctx, c));   // every candidate: results must not depend on order
    });
    prog("dedupe", 0);
    const res = finalize(ctx, found);
    prog("done", 1);
    res.elapsedMs = Date.now() - t0;
    return res;
  }

  /** The manual technique: x[start:end] - x[start-lag:end-lag], per channel. */
  function isolate(channels, lag, start, end) {
    end = Math.min(end, channels[0].length);
    start = Math.max(start, lag);
    return channels.map((c) => {
      const out = new Float32Array(end - start);
      for (let i = start; i < end; i++) out[i - start] = c[i] - c[i - lag];
      return out;
    });
  }

  /**
   * Keep only part of the stereo image (mid/side). "center" is (L+R)/2 in both channels:
   * whatever is panned to the middle, like most lead vocals. "sides" is (L-R)/2, written as
   * +S on the left and -S on the right so it still sounds wide: whatever differs between the
   * channels, like stereo effects and hard-panned parts. Center + sides adds back up to the
   * original. Mono input, or "full", is returned unchanged.
   */
  function stereoPart(channels, part) {
    if (channels.length < 2 || (part !== "center" && part !== "sides")) return channels;
    const L = channels[0], R = channels[1], n = L.length, a = new Float32Array(n);
    if (part === "center") {
      for (let i = 0; i < n; i++) a[i] = 0.5 * (L[i] + R[i]);
      return [a, a.slice()];
    }
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) { const s = 0.5 * (L[i] - R[i]); a[i] = s; b[i] = -s; }
    return [a, b];
  }

  /**
   * Blend the center against the sides. balance 0 is the center alone, 0.5 the untouched
   * original and 1 the sides alone: below 0.5 the sides are turned down and above it the center
   * is, so one of the two always stays at full level. Mono input is returned unchanged.
   */
  function stereoMix(channels, balance) {
    if (channels.length < 2) return channels;
    const b = Math.max(0, Math.min(1, balance)), gm = Math.min(1, 2 * (1 - b)), gs = Math.min(1, 2 * b);
    if (gm === 1 && gs === 1) return channels;
    const L = channels[0], R = channels[1], n = L.length, a = new Float32Array(n), c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const m = gm * 0.5 * (L[i] + R[i]), s = gs * 0.5 * (L[i] - R[i]);
      a[i] = m + s; c[i] = m - s;
    }
    return [a, c];
  }

  /**
   * Low-cut and/or high-cut, zero phase (each 2nd-order Butterworth runs forwards then
   * backwards, so 24 dB/octave and no time shift: the filtered isolation still lines up with
   * the song, which "Song without this sound" relies on). lowHz/highHz of 0 or null = off.
   */
  function bandLimit(channels, sr, lowHz, highHz) {
    const nyq = sr / 2;
    const stages = [];
    if (lowHz > 0 && lowHz < nyq * 0.95) stages.push(biquad("hp", lowHz, sr));
    if (highHz > 0 && highHz < nyq * 0.95) stages.push(biquad("lp", highHz, sr));
    if (!stages.length) return channels;
    return channels.map((c) => {
      const n = c.length, pad = Math.min(n - 1, Math.round(sr * 0.05));
      // mirror the ends so the filters start and stop without a thump
      const x = new Float64Array(n + 2 * pad);
      for (let i = 0; i < pad; i++) { x[pad - 1 - i] = 2 * c[0] - c[i + 1]; x[pad + n + i] = 2 * c[n - 1] - c[n - 2 - i]; }
      for (let i = 0; i < n; i++) x[pad + i] = c[i];
      for (const f of stages) { runBiquad(f, x, false); runBiquad(f, x, true); }
      return Float32Array.from(x.subarray(pad, pad + n));
    });
  }
  function biquad(type, f, sr) {             // RBJ cookbook, Q = 1/sqrt(2)
    const w = (2 * Math.PI * f) / sr, cw = Math.cos(w), al = Math.sin(w) / Math.SQRT2, a0 = 1 + al;
    const b = type === "lp" ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0 };
  }
  function runBiquad(f, x, reverse) {
    const n = x.length;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k, v = x[i];
      const y = f.b0 * v + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y;
    }
  }

  /** Shared STFT over a stereo pair; calls visit(frameIndex, Lre, Lim, Rre, Rim) per frame. */
  function stereoStft(channels, sr) {
    const n = channels[0].length;
    const N = Math.max(512, nextPow2(Math.round(sr * 0.046))), hop = N >> 2, K = N / 2 + 1;
    const pad = N, F = Math.ceil((n + N) / hop) + 1;
    return { n, N, hop, K, pad, F, win: hann(N), fft: rfftFor(N) };
  }
  /** Per-bin pan (-1 hard left .. +1 hard right) and how much the bin acts like one panned source. */
  function binPan(lr, li, rr, ri) {
    const pl = lr * lr + li * li, pr = rr * rr + ri * ri, tot = pl + pr;
    if (tot < 1e-18) return null;
    const pan = (pr - pl) / tot;
    // out-of-phase content (reverb, stereo wideners) has no single position; down-weight it
    const cross = (lr * rr + li * ri) / Math.sqrt(pl * pr + 1e-30);
    const coherent = Math.min(1, Math.max(0, (1 + cross) / 2 + Math.abs(pan)));
    return { pan, coherent, tot };
  }

  /**
   * Keep only what sits at one position in the stereo field. Each frequency bin of each
   * frame is assigned a pan from the left/right level difference; bins near `target`
   * (-1..1) pass and the rest fade out over `width`. The kept part keeps its own stereo image.
   */
  function panExtract(channels, sr, target, width) {
    if (channels.length < 2) return channels;
    const g = stereoStft(channels, sr), { n, N, hop, K, pad, F, win, fft } = g;
    const [L, R] = channels, w = Math.max(0.03, width || 0.25), floor = 0.03;
    const Lre = new Float64Array(K), Lim = new Float64Array(K), Rre = new Float64Array(K), Rim = new Float64Array(K);
    const frame = new Float64Array(N);
    const cut = (x, f) => { const o = f * hop - pad; for (let i = 0; i < N; i++) { const j = o + i; frame[i] = j >= 0 && j < n ? x[j] * win[i] : 0; } };
    // pass 1: the mask
    const M = new Float32Array(F * K);
    for (let f = 0; f < F; f++) {
      cut(L, f); fft.forward(frame, Lre, Lim);
      cut(R, f); fft.forward(frame, Rre, Rim);
      for (let k = 0; k < K; k++) {
        const b = binPan(Lre[k], Lim[k], Rre[k], Rim[k]);
        if (!b) { M[f * K + k] = floor; continue; }
        const d = (b.pan - target) / w;
        M[f * K + k] = Math.max(floor, Math.exp(-d * d) * b.coherent);
      }
    }
    // pass 2: smooth the mask (3x3) and resynthesise both channels with it
    const S = new Float32Array(F * K);
    for (let f = 0; f < F; f++) for (let k = 0; k < K; k++) {
      let sum = 0, cnt = 0;
      for (let df = -1; df <= 1; df++) { const ff = f + df; if (ff < 0 || ff >= F) continue;
        for (let dk = -1; dk <= 1; dk++) { const kk = k + dk; if (kk < 0 || kk >= K) continue; sum += M[ff * K + kk]; cnt++; } }
      S[f * K + k] = sum / cnt;
    }
    const norm = new Float64Array(n);
    for (let f = 0; f < F; f++) { const o = f * hop - pad; for (let i = 0; i < N; i++) { const j = o + i; if (j >= 0 && j < n) norm[j] += win[i] * win[i]; } }
    const out = new Float64Array(N);
    return [L, R].map((x) => {
      const y = new Float32Array(n);
      for (let f = 0; f < F; f++) {
        cut(x, f); fft.forward(frame, Lre, Lim);
        for (let k = 0; k < K; k++) { const m = S[f * K + k]; Lre[k] *= m; Lim[k] *= m; }
        fft.inverse(Lre, Lim, out);
        const o = f * hop - pad;
        for (let i = 0; i < N; i++) { const j = o + i; if (j >= 0 && j < n) y[j] += out[i] * win[i]; }
      }
      for (let i = 0; i < n; i++) y[i] = norm[i] > 1e-9 ? y[i] / norm[i] : 0;
      return y;
    });
  }

  /** Where the energy sits across the stereo field: `bins` buckets from hard left to hard right. */
  function panMap(channels, sr, bins) {
    bins = bins || 41;
    const hist = new Float64Array(bins);
    if (channels.length < 2) return hist;
    const g = stereoStft(channels, sr), { n, N, hop, K, pad, F, win, fft } = g;
    const [L, R] = channels;
    const Lre = new Float64Array(K), Lim = new Float64Array(K), Rre = new Float64Array(K), Rim = new Float64Array(K), frame = new Float64Array(N);
    const cut = (x, f) => { const o = f * hop - pad; for (let i = 0; i < N; i++) { const j = o + i; frame[i] = j >= 0 && j < n ? x[j] * win[i] : 0; } };
    const step = Math.max(1, Math.floor(F / 400));           // a few hundred frames is plenty for a picture
    for (let f = 0; f < F; f += step) {
      cut(L, f); fft.forward(frame, Lre, Lim);
      cut(R, f); fft.forward(frame, Rre, Rim);
      for (let k = 1; k < K; k++) {
        const b = binPan(Lre[k], Lim[k], Rre[k], Rim[k]);
        if (b) hist[Math.min(bins - 1, Math.floor(((b.pan + 1) / 2) * bins))] += b.tot * b.coherent;
      }
    }
    return hist;
  }

  /** Cancellation in dB from already-cut sections: level of the twins over level of the isolation. */
  function cancelDbOf(dst, src, iso) {
    let e1 = 0, e2 = 0, er = 0;
    for (let c = 0; c < dst.length; c++) {
      const a = dst[c], b = src[c], r = iso[c];
      for (let i = 0; i < r.length; i++) { e1 += a[i] * a[i]; e2 += b[i] * b[i]; er += r[i] * r[i]; }
    }
    const db = 10 * Math.log10((e1 + e2) / 2 / (er + 1e-20));
    return Number.isFinite(db) ? db : 0;
  }

  /**
   * Reduce what's left of the shared music in an isolation. Imperfect cancellation (lossy
   * codecs, dither, mastering) leaves a residue that follows the twin's spectrum. Per frequency
   * bin, estimate how strongly the twin leaks through, then apply a smoothed spectral gate. One mask for all channels keeps the stereo image.
   */
  function denoise(iso, dst, sr, amount) {
    // amount 0..1: how hard to subtract (alpha) and how far gated bins may drop (gMin, -6 to -30 dB)
    const a = Math.max(0, Math.min(1, amount === undefined ? 0.5 : amount));
    const alpha = 0.5 + 3.5 * a, gMin = Math.pow(10, -(6 + 24 * a) / 20);
    const n = iso[0].length;
    const N = Math.max(512, nextPow2(Math.round(sr * 0.046))), hop = N >> 2, K = N / 2 + 1;
    if (n < N * 2) return iso;
    const F = Math.ceil((n + N) / hop) + 1, pad = N;          // frames cover [-N, n + N)
    const win = hann(N), fft = rfftFor(N);
    const re = new Float64Array(K), im = new Float64Array(K), frame = new Float64Array(N);
    const monoOf = (chs) => { const m = new Float32Array(n); for (const c of chs) for (let i = 0; i < n; i++) m[i] += c[i] / chs.length; return m; };
    const cut = (x, f) => {
      const o = f * hop - pad;
      for (let i = 0; i < N; i++) { const j = o + i; frame[i] = j >= 0 && j < n ? x[j] * win[i] : 0; }
    };
    const mags = (x) => {
      const M = new Float32Array(F * K);
      for (let f = 0; f < F; f++) {
        cut(x, f); fft.forward(frame, re, im);
        for (let k = 0; k < K; k++) M[f * K + k] = Math.hypot(re[k], im[k]);
      }
      return M;
    };
    const MI = mags(monoOf(iso)), MD = mags(monoOf(dst));
    // per bin: how much of the twin leaks into the isolation. Use the frames where it leaks
    // least, and cap each bin near the typical leak across all bins, so a hidden sound that
    // sits in a few bins for the whole section isn't mistaken for leakage.
    const col = new Float32Array(F), beta = new Float32Array(K);
    const pctl = (arr, q) => { const x = Float32Array.from(arr).sort(); return x[Math.min(x.length - 1, Math.floor(q * x.length))]; };
    for (let k = 0; k < K; k++) {
      let m = 0;
      for (let f = 0; f < F; f++) { const d = MD[f * K + k]; if (d > 1e-9) col[m++] = MI[f * K + k] / d; }
      beta[k] = m ? pctl(col.subarray(0, m), 0.25) : 0;
    }
    const cap = 2 * pctl(beta, 0.5);
    for (let k = 0; k < K; k++) beta[k] = Math.min(beta[k], cap);
    const G = new Float32Array(F * K);
    for (let f = 0; f < F; f++) {
      for (let k = 0; k < K; k++) {
        const x = MI[f * K + k], nz = beta[k] * MD[f * K + k];
        G[f * K + k] = x > 1e-12 ? Math.max(gMin, 1 - (alpha * nz * nz) / (x * x)) : gMin;
      }
    }
    // smooth the mask over time and frequency so it doesn't warble ("musical noise")
    const S = new Float32Array(F * K);
    for (let f = 0; f < F; f++) {
      for (let k = 0; k < K; k++) {
        let sum = 0, cnt = 0;
        for (let df = -1; df <= 1; df++) {
          const ff = f + df; if (ff < 0 || ff >= F) continue;
          for (let dk = -1; dk <= 1; dk++) { const kk = k + dk; if (kk < 0 || kk >= K) continue; sum += G[ff * K + kk]; cnt++; }
        }
        S[f * K + k] = Math.sqrt(sum / cnt);                  // power gain -> amplitude gain
      }
    }
    // apply per channel, overlap-add with the same window
    const norm = new Float64Array(n);
    for (let f = 0; f < F; f++) { const o = f * hop - pad; for (let i = 0; i < N; i++) { const j = o + i; if (j >= 0 && j < n) norm[j] += win[i] * win[i]; } }
    const out = new Float64Array(N);
    return iso.map((x) => {
      const y = new Float32Array(n);
      for (let f = 0; f < F; f++) {
        cut(x, f); fft.forward(frame, re, im);
        for (let k = 0; k < K; k++) { const gk = S[f * K + k]; re[k] *= gk; im[k] *= gk; }
        fft.inverse(re, im, out);
        const o = f * hop - pad;
        for (let i = 0; i < N; i++) { const j = o + i; if (j >= 0 && j < n) y[j] += out[i] * win[i]; }
      }
      for (let i = 0; i < n; i++) y[i] = norm[i] > 1e-9 ? y[i] / norm[i] : 0;
      return y;
    });
  }

  return {
    detectTwins, isolate, cancelDb, mono, DEFAULTS, probePair, cancelDbOf, denoise, stereoPart, stereoMix, bandLimit, panExtract, panMap,
    // pipeline steps (worker pool)
    prepare, features, lagRange, coarseScan, selectCandidates, analyseCandidate, explained, finalize,
    // internals exposed for tests
    RealFFT, rfftFor, uniformFilter1d, isolationSdr, _internal: { refineLag, findRegions, dedupe, xcorrLagPeaks },
  };
});

/*
 * Isolation clean-up: noise reduction.
 *   node tests/cleanup.test.js
 * Builds a song whose pasted copy leaks a little of the music into the isolation (as lossy
 * codecs and mastering do), adds a hidden sound to one copy, and checks that noise reduction
 * brings the isolation closer to the hidden sound without removing it.
 */
const assert = require("assert");
const E = require("../src/engine.js");

const sr = 44100, n = sr * 30;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);

// "music": a few drifting partials plus noise
const music = new Float32Array(n);
for (let i = 0; i < n; i++) {
  const t = i / sr;
  music[i] = 0.25 * Math.sin(2 * Math.PI * 220 * t + 2 * Math.sin(t)) + 0.15 * Math.sin(2 * Math.PI * 660 * t) + 0.12 * rnd();
}
const ch = new Float32Array(music);
const lag = sr * 12, a = sr * 15, b = sr * 25;
const hidden = new Float32Array(n);
for (let i = sr * 18; i < sr * 20; i++) hidden[i] = 0.1 * Math.sin(2 * Math.PI * 1500 * (i / sr)) * Math.sin(Math.PI * (i - sr * 18) / (2 * sr));
// twin = copy + leaked music that follows the copy (codec-like) + a little hiss + the hidden sound
for (let i = a; i < b; i++) {
  const leak = 0.03 * music[i - lag] * Math.sin(2 * Math.PI * 0.7 * (i / sr));
  ch[i] = music[i - lag] + leak + 0.002 * rnd() + hidden[i];
}
const chs = [ch];

const truth = hidden.subarray(a, b);
const sdr = (est) => {
  let s = 0, e = 0;
  for (let i = 0; i < truth.length; i++) { s += truth[i] * truth[i]; const d = est[i] - truth[i]; e += d * d; }
  return 10 * Math.log10(s / e);
};

const plain = E.isolate(chs, lag, a, b);
const dst = [ch.subarray(a, b)], src = [ch.subarray(a - lag, b - lag)];
const s0 = sdr(plain[0]);
for (const amount of [0.25, 0.5, 0.9]) {
  const cleaned = E.denoise(plain, dst, sr, amount);
  const s1 = sdr(cleaned[0]);
  console.log(`  amount ${amount}: ${s0.toFixed(1)} dB plain -> ${s1.toFixed(1)} dB denoised (cancellation ${E.cancelDbOf(dst, src, cleaned).toFixed(1)} dB)`);
  assert(s1 > s0 + 1, `noise reduction at ${amount} should improve the isolation`);
}
assert(E.cancelDbOf(dst, src, plain) > 0, "cancellation should be positive");

// a hidden sound that plays through the whole section must survive, while leaked music goes
const len = sr * 8, tone = new Float32Array(len), leakIso = new Float32Array(len), twinM = new Float32Array(len);
for (let i = 0; i < len; i++) {
  tone[i] = 0.1 * Math.sin(2 * Math.PI * 1500 * i / sr);
  twinM[i] = music[i + sr];
  leakIso[i] = tone[i] + 0.03 * twinM[i] * (1 + 0.5 * Math.sin(i / 3000));
}
const kept = E.denoise([leakIso], [twinM], sr)[0];
const sdrTone = (x) => { let s = 0, e = 0; for (let i = sr; i < len - sr; i++) { s += tone[i] ** 2; e += (x[i] - tone[i]) ** 2; } return 10 * Math.log10(s / e); };
const t0 = sdrTone(leakIso), t1 = sdrTone(kept);
console.log(`  sustained hidden tone: ${t0.toFixed(1)} dB before, ${t1.toFixed(1)} dB after`);
assert(t1 > t0, "a sustained hidden sound should come out cleaner, not be removed");


// stereo parts: center + sides add back up to the original, and each keeps the right sound
{
  const m = 2000, Lc = new Float32Array(m), Rc = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const mid = Math.sin(i * 0.05), wide = 0.5 * Math.sin(i * 0.13);
    Lc[i] = mid + wide; Rc[i] = mid - wide;                    // a centered tone plus an out-of-phase one
  }
  const [cL, cR] = E.stereoPart([Lc, Rc], "center"), [sL, sR] = E.stereoPart([Lc, Rc], "sides");
  let err = 0, midErr = 0, sideErr = 0;
  for (let i = 0; i < m; i++) {
    err = Math.max(err, Math.abs(cL[i] + sL[i] - Lc[i]), Math.abs(cR[i] + sR[i] - Rc[i]));
    midErr = Math.max(midErr, Math.abs(cL[i] - Math.sin(i * 0.05)), Math.abs(cR[i] - cL[i]));
    sideErr = Math.max(sideErr, Math.abs(sL[i] - 0.5 * Math.sin(i * 0.13)), Math.abs(sR[i] + sL[i]));
  }
  assert(err < 1e-6, "center + sides should rebuild the original");
  assert(midErr < 1e-6, "center should hold just the centered tone, the same in both channels");
  assert(sideErr < 1e-6, "sides should hold just the out-of-phase tone, inverted on the right");
  const mono = [new Float32Array(10)];
  assert(E.stereoPart(mono, "center") === mono, "mono passes through untouched");
  console.log("  stereo center/sides split checks out");

  // mixing the two: the ends match the split, the middle is the original, in between one side is turned down
  const [m0L, m0R] = E.stereoMix([Lc, Rc], 0), [m1L, m1R] = E.stereoMix([Lc, Rc], 1), [qL, qR] = E.stereoMix([Lc, Rc], 0.25), [hL, hR] = E.stereoMix([Lc, Rc], 0.75);
  let endErr = 0, quarterErr = 0;
  for (let i = 0; i < m; i++) {
    endErr = Math.max(endErr, Math.abs(m0L[i] - cL[i]), Math.abs(m0R[i] - cR[i]), Math.abs(m1L[i] - sL[i]), Math.abs(m1R[i] - sR[i]));
    quarterErr = Math.max(quarterErr, Math.abs(qL[i] - (cL[i] + 0.5 * sL[i])), Math.abs(qR[i] - (cR[i] + 0.5 * sR[i])),
      Math.abs(hL[i] - (0.5 * cL[i] + sL[i])), Math.abs(hR[i] - (0.5 * cR[i] + sR[i])));
  }
  assert(endErr < 1e-6, "mix at 0 is the center alone and at 1 the sides alone");
  assert(quarterErr < 1e-6, "below the middle the sides are turned down, above it the center is");
  const pair = [Lc, Rc];
  assert(E.stereoMix(pair, 0.5) === pair, "mix in the middle leaves the original untouched");
  assert(E.stereoMix(mono, 0.2) === mono, "mono passes through the mix untouched");
  console.log("  stereo center/sides mix checks out");
}

console.log("cleanup tests passed");

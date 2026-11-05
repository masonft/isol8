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

console.log("cleanup tests passed");

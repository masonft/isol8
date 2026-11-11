/*
 * Partial twins (no example songs or ffmpeg needed): two passages that share one layer
 * sample for sample, each under its own different lead. Nothing cancels deeply, so the
 * engine has to find the pair by the shared layer and lock the offset to the sample.
 *   node tests/partial.test.js
 */
const E = require("../src/engine.js");

const sr = 44100, n = 70 * sr, LAG = 32 * sr + 777, START = 10 * sr, LEN = 16 * sr;
let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
// a random three-note chord on every half-second beat, so no two passages match by chance
function part(len, level) {
  const out = [new Float32Array(len), new Float32Array(len)], B = sr / 2;
  for (let b = 0; b * B < len; b++) {
    const f = [0, 1, 2].map(() => 110 * 2 ** (Math.floor((rnd() + 1) * 24) / 12));
    for (let i = b * B; i < Math.min(len, (b + 1) * B); i++) {
      const t = (i - b * B) / sr, env = level * Math.exp(-t * 4);
      for (let c = 0; c < 2; c++) out[c][i] = env * f.reduce((v, x, k) => v + Math.sin(2 * Math.PI * x * t + k + c), 0) / 3 + 0.04 * level * rnd();
    }
  }
  return out;
}
const ch = part(n, 0.25);
// the shared layer, pasted twice; each paste gets its own lead on top
const layer = part(LEN, 0.25), leadA = part(LEN, 0.15), leadB = part(LEN, 0.15);
for (let c = 0; c < 2; c++) for (let i = 0; i < LEN; i++) {
  ch[c][START + i] = layer[c][i] + leadA[c][i];
  ch[c][START + LAG + i] = layer[c][i] + leadB[c][i];
}

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? "✓" : "✗ FAIL"} ${m}`); if (!c) fails++; };
const t0 = Date.now();
const res = E.detectTwins(ch, sr);
const hit = res.find((p) => p.lag === LAG);
check(hit, `shared layer found at the exact offset (${res.length} result${res.length === 1 ? "" : "s"}, ${Date.now() - t0} ms)`);
if (hit) {
  check(hit.partial, `listed as a shared-layer result (cancels ${hit.cancelDb.toFixed(1)} dB, shares ${(hit.share * 100).toFixed(0)}%)`);
  const cov = (Math.min(hit.dstEnd, START + LAG + LEN) - Math.max(hit.dstStart, START + LAG)) / LEN;
  check(cov > 0.8, `section covered: ${(cov * 100).toFixed(0)}%`);
  // the isolation is the two leads with the shared layer gone
  const s = Math.max(hit.dstStart, START + LAG), iso = E.isolate(ch, LAG, s, s + sr);
  let err = 0;
  for (let i = 0; i < sr; i++) { const k = s - START - LAG + i; err = Math.max(err, Math.abs(iso[0][i] - (leadB[0][k] - leadA[0][k]))); }
  check(err < 1e-6, `isolation is the two leads without the shared layer (max error ${err.toExponential(1)})`);
}
check(E.detectTwins(ch, sr, null, { shareThr: 0 }).every((p) => !p.partial), "turned off with shareThr 0");
console.log(fails ? `\n${fails} failures` : "\npartial tests passed");
process.exit(fails ? 1 : 0);

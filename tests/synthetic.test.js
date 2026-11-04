/*
 * Self-contained engine test (no example songs or ffmpeg needed): builds a song in which
 * one passage repeats sample for sample with a quiet tone hidden in the repeat, then checks
 * the engine finds the exact offset and that the isolation is the hidden tone.
 *   node tests/synthetic.test.js
 */
const E = require("../src/engine.js");

const sr = 44100, n = 60 * sr, LAG = 30 * sr + 1234, START = 9 * sr, LEN = 10 * sr;
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
// "music": a random three-note chord on every half-second beat, so no two passages match by chance
const ch = [new Float32Array(n), new Float32Array(n)], B = sr / 2;
for (let b = 0; b * B < n; b++) {
  const f = [0, 1, 2].map(() => 110 * 2 ** (Math.floor((rnd() + 1) * 24) / 12));
  for (let i = b * B; i < Math.min(n, (b + 1) * B); i++) {
    const t = (i - b * B) / sr, env = 0.25 * Math.exp(-t * 4);
    for (let c = 0; c < 2; c++) ch[c][i] = env * f.reduce((v, x, k) => v + Math.sin(2 * Math.PI * x * t + k + c), 0) / 3 + 0.01 * rnd();
  }
}
// the twin: an exact copy of [START, START+LEN) placed LAG later, plus a hidden tone
const tone = (i) => 0.02 * Math.sin((2 * Math.PI * 660 * i) / sr);
for (let c = 0; c < 2; c++) for (let i = 0; i < LEN; i++) ch[c][START + LAG + i] = ch[c][START + i] + tone(i);

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? "✓" : "✗ FAIL"} ${m}`); if (!c) fails++; };
const t0 = Date.now();
const res = E.detectTwins(ch, sr);
const hit = res.find((p) => p.lag === LAG);
check(hit, `repeat found at the exact offset (${res.length} result${res.length === 1 ? "" : "s"}, ${Date.now() - t0} ms)`);
if (hit) {
  const cov = (Math.min(hit.dstEnd, START + LAG + LEN) - Math.max(hit.dstStart, START + LAG)) / LEN;
  check(cov > 0.9, `section covered: ${(cov * 100).toFixed(0)}%`);
  const s = Math.max(hit.dstStart, START + LAG), iso = E.isolate(ch, LAG, s, s + sr);
  let err = 0;
  for (let i = 0; i < sr; i++) err = Math.max(err, Math.abs(iso[0][i] - tone(s - START - LAG + i)));
  check(err < 1e-6, `isolation is the hidden tone (max error ${err.toExponential(1)})`);
}
console.log(fails ? `\n${fails} failures` : "\nsynthetic tests passed");
process.exit(fails ? 1 : 0);

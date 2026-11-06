/*
 * Shaping the isolation: low/high-cut filter and pan-position extraction.
 *   node tests/shaping.test.js
 */
const assert = require("assert");
const E = require("../src/engine.js");

const sr = 44100, n = sr * 4;
const tone = (f, amp) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr); return x; };
/** Amplitude of frequency f in x, measured away from the edges. */
const level = (x, f) => {
  let re = 0, im = 0; const a = sr, b = n - sr;
  for (let i = a; i < b; i++) { re += x[i] * Math.cos(2 * Math.PI * f * i / sr); im += x[i] * Math.sin(2 * Math.PI * f * i / sr); }
  return (2 * Math.hypot(re, im)) / (b - a);
};
const db = (v) => 20 * Math.log10(v + 1e-12);

// ---- filter: 60 Hz rumble, 1 kHz voice, 12 kHz hiss; cut below 200 Hz and above 5 kHz
{
  const x = new Float32Array(n), parts = [[60, 0.5], [1000, 0.3], [12000, 0.2]];
  for (const [f, a] of parts) { const t = tone(f, a); for (let i = 0; i < n; i++) x[i] += t[i]; }
  const [y] = E.bandLimit([x], sr, 200, 5000);
  const keep = db(level(y, 1000) / 0.3), low = db(level(y, 60) / 0.5), high = db(level(y, 12000) / 0.2);
  console.log(`  filter: 1 kHz ${keep.toFixed(2)} dB, 60 Hz ${low.toFixed(1)} dB, 12 kHz ${high.toFixed(1)} dB`);
  assert(Math.abs(keep) < 0.5, "the passband is left alone");
  assert(low < -35 && high < -25, "both cut bands are strongly reduced");
  // zero phase: the kept tone lines up with the input sample for sample
  const ref = tone(1000, 0.3); let err = 0, pow = 0;
  for (let i = sr; i < n - sr; i++) { err += (y[i] - ref[i]) ** 2; pow += ref[i] ** 2; }
  assert(10 * Math.log10(pow / err) > 20, "no time shift in the kept band");
  assert.strictEqual(E.bandLimit([x], sr, 0, 0)[0], x, "both off = untouched");
}

// ---- pan: 440 Hz panned 60% left, 1 kHz in the center, 2.5 kHz hard right
{
  const a = tone(440, 0.3), c = tone(1000, 0.3), r = tone(2500, 0.3);
  const gl = Math.cos((0.2) * Math.PI / 2), gr = Math.sin((0.2) * Math.PI / 2);   // equal-power pan toward the left
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = gl * a[i] + c[i]; R[i] = gr * a[i] + c[i] + r[i]; }
  const target = (gr * gr - gl * gl) / (gr * gr + gl * gl);
  const map = E.panMap([L, R], sr, 41);
  const peaks = [...map].map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]).slice(0, 3).map(([, i]) => i).sort((p, q) => p - q);
  console.log(`  pan map peaks at buckets ${peaks.join(", ")} (left source at pan ${target.toFixed(2)})`);
  assert(peaks.includes(20) && peaks.includes(40), "the map shows the center and hard-right sources");

  const [eL, eR] = E.panExtract([L, R], sr, target, 0.2);
  const kept = db(level(eL, 440) / (gl * 0.3)), center = db(level(eL, 1000) / 0.3), right = db(level(eR, 2500) / 0.3);
  console.log(`  extract at ${target.toFixed(2)}: left source ${kept.toFixed(1)} dB, center ${center.toFixed(1)} dB, hard right ${right.toFixed(1)} dB`);
  assert(kept > -2, "the source at the chosen position is kept");
  assert(center < -15 && right < -15, "sources elsewhere are pushed down");
  const [cL] = E.panExtract([L, R], sr, 0, 0.2);
  assert(db(level(cL, 1000) / 0.3) > -2 && db(level(cL, 440) / (gl * 0.3)) < -12, "aiming at the center keeps the center source instead");
  const mono = [new Float32Array(10)];
  assert.strictEqual(E.panExtract(mono, sr, 0, 0.2), mono, "mono passes through");
}
console.log("shaping tests passed");

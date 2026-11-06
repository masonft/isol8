/*
 * Edge cases in pair geometry.
 *   node tests/regions.test.js
 * Regression: two detections of a copy that starts at 0:00, a few samples apart in offset,
 * were merged into a twin reaching back before the song began, which measured as "NaN dB".
 */
const assert = require("assert");
const E = require("../src/engine.js");

const sr = 44100, n = sr * 20, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.01) + Math.sin(i * 0.037);
const L = sr * 5;
const pair = (lag, s, e, score) => ({ lag, sr, dstStart: s, dstEnd: e, srcStart: s - lag, srcEnd: e - lag,
  cancelDb: E.cancelDb([x], lag, s, e), deep: 0.9, bands: [1, 1, 1, 1], merged: 0, score });

const out = E._internal.dedupe([x], sr, [pair(L + 20, L + 20, L + sr * 4, 2), pair(L, L, L + sr * 3, 1)], Object.assign({}, E.DEFAULTS));
assert.strictEqual(out.length, 1, "the two detections merge into one result");
assert(Number.isFinite(out[0].cancelDb), `merged result must have a real dB value, got ${out[0].cancelDb}`);
assert(out[0].srcStart >= 0, `copy can't start before the song (srcStart ${out[0].srcStart})`);

// measuring a span that runs off either end of the song is clamped, never NaN
assert(Number.isFinite(E.cancelDb([x], L, 0, sr * 8)), "span starting before the copy exists");
assert(Number.isFinite(E.cancelDb([x], L, L, n + sr)), "span running past the end");
assert.strictEqual(E.cancelDb([x], L, 10, 20), 0, "an empty span measures 0 dB");
const silent = [new Float32Array(sr)];
assert.strictEqual(E.cancelDbOf(silent, silent, silent), 0, "silence measures 0 dB, not NaN");

console.log("regions tests passed");

/*
 * Debug probe test: given a rough position for a known pair, probePair must lock onto the
 * exact offset and find the cancelling region, even when the guess is a fraction of a second off.
 *   node tests/probe.test.js [path/to/examples]
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const E = require("../src/engine.js");

const EX = require("./examples.js")(process.argv[2]);
if (!EX || !fs.existsSync(path.join(EX, "the band"))) { console.log("probe tests skipped: example songs not found (see tests/examples.js)"); process.exit(0); }
const dir = path.join(EX, "the band");
const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".flac")));
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "2", "-"], { maxBuffer: 1 << 30 });
const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const n = inter.length / 2, ch = [new Float32Array(n), new Float32Array(n)];
for (let i = 0; i < n; i++) { ch[0][i] = inter[2 * i]; ch[1][i] = inter[2 * i + 1]; }
const sr = 44100, LAG = 3050648, DST = 3946627;

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? "✓" : "✗ FAIL"} ${m}`); if (!c) fails++; };
const ctx = E.prepare(ch, sr);
for (const off of [0, 0.3, -0.7]) {
  const t0 = Date.now();
  const r = E.probePair(ctx, DST - LAG, DST + Math.round(off * sr), 20 * sr, 1);
  const best = r.regions.reduce((a, b) => (a && a.dstEnd - a.dstStart > b.dstEnd - b.dstStart ? a : b), null);
  check(Math.abs(r.lag - LAG) <= 1 && best && best.lengthS > 15,
    `guess ${off >= 0 ? "+" : ""}${off}s off: lag ${r.lag} (true ${LAG}), cancels ${r.cancelDb.toFixed(1)} dB, sim max ${r.sim.max.toFixed(2)}, ` +
    `region ${best ? best.lengthS.toFixed(1) + " s" : "none"} (${Date.now() - t0} ms)`);
}
let threw = false;
try { E.probePair(ctx, DST, DST - LAG, 10 * sr, 1); } catch { threw = true; }
check(threw, "twin before copy is rejected with an error");
console.log(fails ? `\n${fails} failures` : "\nprobe tests passed");
process.exit(fails ? 1 : 0);

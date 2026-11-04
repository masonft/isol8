/*
 * Engine regression test against the hand-made examples.
 *   node tests/engine.test.js [path/to/examples]
 * Needs ffmpeg on PATH (only to decode audio in Node; the browser uses Web Audio).
 * Ground truth = offsets/regions reverse-engineered from the hand-made step files.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const E = require("../src/engine.js");

const GROUND_TRUTH = [
  { song: "dont panic", lag: 2399040, resStart: 4095417, resLen: 1243620 },
  { song: "dont panic", lag: 1128960, resStart: 6845159, resLen: 1128960 },
  { song: "nobody", lag: 3444559, resStart: 4428764, resLen: 1474945 },
  { song: "the band", lag: 3050648, resStart: 3946627, resLen: 1126785, lagTolerance: 1 }, // true optimum sits between samples
];

function decode(file) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries",
    "stream=sample_rate,channels", "-of", "json", file]).toString()).streams[0];
  const sr = +probe.sample_rate, nch = +probe.channels;
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
    { maxBuffer: 1 << 30 });
  const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const n = inter.length / nch;
  const ch = Array.from({ length: nch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) ch[c][i] = inter[i * nch + c];
  return { ch, sr };
}

const root = require("./examples.js")(process.argv[2]);
if (!root) { console.log("engine tests skipped: example songs not found (see tests/examples.js)"); process.exit(0); }
let fails = 0;
const fail = (m) => { fails++; console.log("  FAIL", m); };
for (const song of [...new Set(GROUND_TRUTH.map((g) => g.song))]) {
  const dir = path.join(root, song);
  if (!fs.existsSync(dir)) { console.log(`skip ${song} (not found)`); continue; }
  const file = fs.readdirSync(dir).find((f) => /\.(mp3|flac|wav|m4a|ogg|aiff?)$/i.test(f));
  const { ch, sr } = decode(path.join(dir, file));
  const t = Date.now();
  const res = E.detectTwins(ch, sr);
  console.log(`\n${song}: ${res.length} results in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const all = res;
  res.forEach((p) => console.log(`  #${p.rank} src ${(p.srcStart / sr).toFixed(2)}-${(p.srcEnd / sr).toFixed(2)}s -> dst ${(p.dstStart / sr).toFixed(2)}-${(p.dstEnd / sr).toFixed(2)}s lag ${p.lag} cancel ${p.cancelDb.toFixed(1)}dB bands ${p.bands.map((b) => b.toFixed(2)).join("/")} score ${p.score.toFixed(2)}${p.merged ? `  (merged ${p.merged} duplicate${p.merged > 1 ? "s" : ""})` : ""}`));
  // duplicates check: no two listed results share lag (±32) with overlapping regions
  for (let i = 0; i < res.length; i++) for (let j = i + 1; j < res.length; j++) {
    const a = res[i], b = res[j];
    if (Math.abs(a.lag - b.lag) <= 32 && Math.min(a.dstEnd, b.dstEnd) > Math.max(a.dstStart, b.dstStart)) fail(`duplicate results #${a.rank} and #${b.rank}`);
  }
  for (const g of GROUND_TRUTH.filter((g) => g.song === song)) {
    const tol = g.lagTolerance || 0;
    const m = all.find((p) => Math.abs(p.lag - g.lag) <= tol &&
      Math.min(p.dstEnd, g.resStart + g.resLen) > Math.max(p.dstStart, g.resStart));
    if (!m) { fail(`ground truth lag ${g.lag} not found`); continue; }
    const cov = (Math.min(m.dstEnd, g.resStart + g.resLen) - Math.max(m.dstStart, g.resStart)) / g.resLen;
    console.log(`  ✓ your example lag ${g.lag}: found as #${m.rank} lag ${m.lag} (err ${m.lag - g.lag}) coverage ${(cov * 100).toFixed(0)}%`);
  }
  // isolate() equals the technique
  const p = res[0], iso = E.isolate(ch, p.lag, p.dstStart, p.dstStart + 1000);
  if (Math.abs(iso[0][500] - (ch[0][p.dstStart + 500] - ch[0][p.dstStart + 500 - p.lag])) > 1e-7) fail("isolate mismatch");
}
console.log(fails ? `\n${fails} failures` : "\nengine tests passed");
process.exit(fails ? 1 : 0);

/*
 * Sample-rate sniffing test: generates short files in many formats/rates with ffmpeg and
 * checks the header parser reads the native rate. Needs ffmpeg on PATH.
 *   node tests/decode.test.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("../src/decode.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isol8-fmt-"));
const cases = [
  ["wav", 48000, ["-c:a", "pcm_s16le"]], ["wav", 96000, ["-c:a", "pcm_f32le"]], ["wav", 22050, ["-c:a", "pcm_s24le"]],
  ["flac", 44100, ["-c:a", "flac"]], ["flac", 88200, ["-c:a", "flac"]],
  ["mp3", 44100, ["-c:a", "libmp3lame", "-id3v2_version", "3", "-metadata", "title=x"]], ["mp3", 32000, ["-c:a", "libmp3lame"]],
  ["mp3", 22050, ["-c:a", "libmp3lame"]], ["ogg", 44100, ["-c:a", "libvorbis"]], ["opus", 48000, ["-c:a", "libopus"], 24000],
  ["m4a", 48000, ["-c:a", "aac"]], ["m4a", 96000, ["-c:a", "alac"]], ["aiff", 32000, ["-c:a", "pcm_s16be"]],
];
let fails = 0;
for (const [ext, expect, codec, genRate] of cases) {
  const f = path.join(dir, `t_${expect}.${ext}`);
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=440:d=1:sample_rate=${genRate || expect}`, "-ac", "2", ...codec, f], { stdio: "ignore" });
  } catch { console.log(`skip ${ext} (encoder missing)`); continue; }
  const b = fs.readFileSync(f);
  const r = D.sniff(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const ok = r.sampleRate === expect;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗"} ${ext.padEnd(5)} ${String(expect).padEnd(6)} -> ${r.format} ${r.sampleRate}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failures` : "decode tests passed");
process.exit(fails ? 1 : 0);

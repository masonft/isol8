/*
 * End-to-end test in a real browser (Playwright + Chromium).
 *   node tests/e2e.js [path/to/examples] [--shots dir]
 * Serves the app on localhost, loads songs through the UI and checks:
 *  - every hand-made example offset is found (sample exact)
 *  - native-rate decoding is bit-exact vs ffmpeg (FLAC)
 *  - loading the same song twice doesn't duplicate it
 *  - the downloaded WAV equals song[dst] - song[dst - lag]
 *  - "song without this sound" = the song with twin + inverted isolation spliced in
 *  - MP3 is the default format (encoded with the vendored LAME when present)
 *  - the How it works page renders without errors
 *  - low-quality files are flagged; results play when clicked
 *  - debug tools: pipeline, song picker, pair probe, adding hidden results, settings + re-analyse
 *  - no network request leaves localhost except the GitHub star count (mocked here),
 *    no console errors
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const APP = path.join(__dirname, "..", "src");
const args = process.argv.slice(2);
const shotsIdx = args.indexOf("--shots");
const SHOTS = shotsIdx >= 0 ? args[shotsIdx + 1] : null;
const EX = require("./examples.js")(args.find((a, i) => !a.startsWith("--") && i !== shotsIdx + 1));
if (!EX) { console.error("e2e needs the example songs (see tests/examples.js)"); process.exit(1); }
const GT = {
  "dont panic": [{ lag: 2399040, tol: 0 }, { lag: 1128960, tol: 0 }],
  "nobody": [{ lag: 3444559, tol: 0 }],
  "the band": [{ lag: 3050648, tol: 1 }],
};
// The only request allowed off-site: the star count. Mocked so the tests never touch the network.
const GH_API = "https://api.github.com/repos/masonft/isol8";
const mockGitHub = (pg, status, stars) => pg.route(`${GH_API}*`, (r) => r.fulfill({
  status, contentType: "application/json", body: JSON.stringify(status === 200 ? { stargazers_count: stars } : { message: "Not Found" }) }));
const offsite = (url, base) => !url.startsWith(base) && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith(GH_API);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? "✓" : "✗ FAIL"} ${m}`); if (!c) fails++; };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(APP, decodeURIComponent(req.url.split("?")[0]).replace(/^\/$/, "/index.html"));
      if (!p.startsWith(APP) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(res);
    }).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const external = [], errors = [];
  page.on("request", (r) => { if (offsite(r.url(), base)) external.push(r.url()); });
  await mockGitHub(page, 200, 1234);
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  if (SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: path.join(SHOTS, "desktop-empty.png") }); }

  const songs = Object.keys(GT).filter((s) => fs.existsSync(path.join(EX, s)));
  for (const song of songs) {
    const dir = path.join(EX, song);
    const file = path.join(dir, fs.readdirSync(dir).find((f) => /\.(mp3|flac|wav|m4a)$/i.test(f)));
    console.log(`\n${song}`);
    const t0 = Date.now();
    await page.setInputFiles("#fileInput", file);
    if (SHOTS && song === songs[0]) { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(SHOTS, "desktop-busy.png") }); }
    await page.waitForFunction((n) => { const t = window.__isol8.state.tracks.find((t) => t.name === n); return t && (t.status === "done" || t.status === "error"); },
      path.basename(file), { timeout: 240000 });
    const info = await page.evaluate((n) => {
      const t = window.__isol8.state.tracks.find((t) => t.name === n);
      return { status: t.status, sr: t.sr, n: t.length, elapsed: t.elapsed, error: t.error,
        results: t.results.map((r) => ({ lag: r.lag, dstStart: r.dstStart, dstEnd: r.dstEnd, rank: r.rank, id: r.id })) };
    }, path.basename(file));
    check(info.status === "done", `analysed in ${((Date.now() - t0) / 1000).toFixed(1)}s wall (${(info.elapsed / 1000).toFixed(1)}s analysis), ${info.results.length} results, ${info.sr} Hz`);
    for (const g of GT[song]) {
      const m = info.results.find((r) => Math.abs(r.lag - g.lag) <= g.tol);
      check(!!m, `your offset ${g.lag} found${m ? ` as #${m.rank} (lag ${m.lag})` : ""}`);
    }
    // duplicates among listed results
    let dup = 0;
    for (let i = 0; i < info.results.length; i++) for (let j = i + 1; j < info.results.length; j++) {
      const a = info.results[i], b = info.results[j];
      if (Math.abs(a.lag - b.lag) <= 32 && Math.min(a.dstEnd, b.dstEnd) > Math.max(a.dstStart, b.dstStart)) dup++;
    }
    check(dup === 0, "no duplicate results");
    const warned = await page.evaluate(() => !document.getElementById("quality").hidden);
    check(!warned, "no low-quality warning for a lossless or 320 kbps file");

    if (song === "the band") {
      // lossless native-rate decode: every browser sample must map back to the exact 16-bit
      // integer in the file. (Chromium scales positive samples by 1/32767 and negative by
      // 1/32768; the mapping is one-to-one, so identical samples still cancel exactly.)
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "s16le", "-ac", "2", "-"], { maxBuffer: 1 << 30 });
      const ints = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
      const toF = (q) => Math.fround(q > 0 ? q / 32767 : q / 32768);
      const ref = { length: ints.length };
      const probe = Array.from({ length: 400 }, (_, i) => 1000 + i * 19531);
      const got = await page.evaluate(async ({ n, idx }) => {
        const t = window.__isol8.state.tracks.find((t) => t.name === n);
        const ab = await t.file.arrayBuffer();
        const d = await Isol8Decode.decodeNative(ab);
        return { len: d.channels[0].length, sr: d.sampleRate, v: idx.map((i) => [d.channels[0][i], d.channels[1][i]]) };
      }, { n: path.basename(file), idx: probe });
      const back = (v) => (v > 0 ? v * 32767 : v * 32768);
      const same = (v, q) => Math.abs(back(v) - q) < 1e-3;           // within float32 rounding of the integer
      const exact = got.len === ints.length / 2 && probe.every((i, k) => same(got.v[k][0], ints[2 * i]) && same(got.v[k][1], ints[2 * i + 1]));
      check(exact, `browser decode is lossless at native ${got.sr} Hz, not resampled (${got.len} samples, each maps back to its 16-bit value)`);

      // export: select the result matching the example, download float WAV, compare
      const m = info.results.find((r) => Math.abs(r.lag - 3050648) <= 1);
      await page.click(`.result[data-id="${m.id}"]`);
      await page.waitForTimeout(600);
      check(await page.getAttribute("#playBtn", "aria-label") === "Pause", "clicking a result starts playing it");
      check(await page.inputValue("#exportFormat") === "mp3", "MP3 is the default download format");
      const grab = async (what, fmt) => {
        await page.selectOption("#exportWhat", what);
        await page.selectOption("#exportFormat", fmt);
        const [d] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click("#download")]);
        const out = path.join(require("os").tmpdir(), `isol8-e2e-${what}.${fmt === "mp3" ? "mp3" : "wav"}`);
        await d.saveAs(out);
        await page.waitForFunction(() => !document.getElementById("download").disabled);
        return { file: out, name: d.suggestedFilename() };
      };
      const readF32 = (f) => { const b = fs.readFileSync(f); const at = b.indexOf("data") + 8; return new Float32Array(b.buffer.slice(b.byteOffset + at, b.byteOffset + b.length)); };
      const isoDl = await grab("iso", "f32");
      const dl = { suggestedFilename: () => isoDl.name };
      const pcm = readF32(isoDl.file);
      let maxErr = 0;
      const s = Math.max(m.dstStart, m.lag);
      for (let i = 0; i < pcm.length / 2; i += 97) {
        for (let c = 0; c < 2; c++) {
          const exp = toF(ints[2 * (s + i) + c]) - toF(ints[2 * (s + i - m.lag) + c]);
          maxErr = Math.max(maxErr, Math.abs(pcm[2 * i + c] - Math.fround(exp)));
        }
      }
      check(pcm.length / 2 === m.dstEnd - s && maxErr < 1e-6, `downloaded WAV = song[t] - song[t - ${m.lag}] (${pcm.length / 2} frames, max error ${maxErr.toExponential(1)}) — ${dl.suggestedFilename()}`);

      check((await page.$$eval("#exportWhat option", (o) => o.map((x) => x.value))).join() === "iso,invSong" && !(await page.$('.modes button[data-mode="inv"]')),
        "no separate inverse mode or section export (it equals the copy)");

      // song without this sound: the full track with twin + inverted isolation (= the copy) in the section
      const full = readF32((await grab("invSong", "f32")).file);
      let outErr = 0, inErr = 0;
      for (let i = 0; i < full.length / 2; i += 211) for (let c = 0; c < 2; c++) {
        const inside = i >= s && i < m.dstEnd;
        const exp = inside ? toF(ints[2 * (i - m.lag) + c]) : toF(ints[2 * i + c]);
        const e = Math.abs(full[2 * i + c] - exp);
        if (inside) inErr = Math.max(inErr, e); else outErr = Math.max(outErr, e);
      }
      check(full.length / 2 === ints.length / 2 && outErr < 1e-6 && inErr < 1e-6, `"song without this sound" keeps the song outside the section (err ${outErr.toExponential(1)}) and removes the isolation inside it (err ${inErr.toExponential(1)})`);

      // MP3 (default format)
      const hasLame = fs.existsSync(path.join(APP, "vendor", "lame.min.js"));
      const mp3 = await grab("iso", "mp3");
      if (hasLame) {
        const dec = execFileSync("ffmpeg", ["-v", "error", "-i", mp3.file, "-f", "f32le", "-ac", "2", "-"], { maxBuffer: 1 << 30 });
        const mf = new Float32Array(dec.buffer, dec.byteOffset, dec.length / 4);
        const probeRate = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,bit_rate", "-of", "csv=p=0", mp3.file]).toString().trim();
        // find the encoder delay, then measure how closely the MP3 follows the exact result
        let best = { lag: 0, snr: -Infinity };
        for (let d = 0; d <= 3000; d += 1) {
          let sig = 0, err = 0;
          for (let i = 20000; i < 220000; i += 7) { const a = pcm[2 * i], b = mf[2 * (i + d)]; sig += a * a; err += (a - b) * (a - b); }
          const snr = 10 * Math.log10(sig / Math.max(err, 1e-20));
          if (snr > best.snr) best = { lag: d, snr };
        }
        // peaks above full scale are turned down before encoding, so compare after a best-fit gain
        let ab = 0, bb = 0, aa = 0;
        for (let i = 20000; i < pcm.length / 2 - 4000; i += 3) for (let c = 0; c < 2; c++) { const x = pcm[2 * i + c], y = mf[2 * (i + best.lag) + c]; ab += x * y; bb += y * y; aa += x * x; }
        const gfit = ab / bb;
        let err = 0;
        for (let i = 20000; i < pcm.length / 2 - 4000; i += 3) for (let c = 0; c < 2; c++) { const r = pcm[2 * i + c] - gfit * mf[2 * (i + best.lag) + c]; err += r * r; }
        const snr = 10 * Math.log10(aa / err);
        let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
        const expGain = peak > 0.999 ? 0.999 / peak : 1;
        check(mp3.name.endsWith(".mp3") && mp3.name.startsWith("isol8.it - ") && Math.abs(mf.length / 2 - pcm.length / 2) < 4000 && snr > 20 && Math.abs(1 / gfit - expGain) < 0.02,
          `MP3 export (${probeRate}) matches the exact result to ${snr.toFixed(1)} dB SNR (${best.lag}-sample encoder delay, turned down ${(-20 * Math.log10(expGain)).toFixed(1)} dB to avoid clipping)`);
      } else {
        check(mp3.name.endsWith(".wav") && /MP3 encoder isn't installed/.test(await page.textContent("#toast")), "without vendor/lame.min.js, MP3 falls back to WAV with a notice");
      }

      // same song again -> no duplicate track
      const before = await page.evaluate(() => window.__isol8.state.tracks.length);
      await page.setInputFiles("#fileInput", file);
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => window.__isol8.state.tracks.length);
      const toast = await page.textContent("#toast");
      check(after === before, `same song loaded twice is not added again ("${toast.trim()}")`);
    }
  }

  // playback smoke test + screenshots
  if (await page.getAttribute("#playBtn", "aria-label") !== "Pause") await page.click("#playBtn");
  await page.waitForTimeout(700);
  const playing = await page.evaluate(() => document.getElementById("playBtn").getAttribute("aria-label") === "Pause");
  check(playing, "playback starts");
  await page.keyboard.press("2");
  await page.waitForTimeout(300);
  check(await page.getAttribute('.modes button[data-mode="dst"]', "aria-pressed") === "true", "key 2 switches to the twin");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "desktop-results.png"), fullPage: true });
  await page.click("#playBtn");

  if (SHOTS) {
    const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    mob.on("pageerror", (e) => errors.push(String(e)));
    await mockGitHub(mob, 404);
    await mob.goto(base);
    await mob.waitForTimeout(500);
    await mob.screenshot({ path: path.join(SHOTS, "mobile-empty.png") });
    const f = path.join(EX, "dont panic", fs.readdirSync(path.join(EX, "dont panic")).find((f) => f.endsWith(".mp3")));
    await mob.setInputFiles("#fileInput", f);
    await mob.waitForFunction(() => window.__isol8.state.tracks[0]?.status === "done", null, { timeout: 240000 });
    await mob.waitForTimeout(1200);
    await mob.screenshot({ path: path.join(SHOTS, "mobile-results.png"), fullPage: true });
  }

  // debug tools on The Band: pipeline, probing your example, adding a hidden result
  if (fs.existsSync(path.join(EX, "the band"))) {
    await page.click('.chip:has-text("The Band")');
    await page.waitForTimeout(300);
    await page.click("#debug summary");
    const steps = await page.$$eval("#pipeline li", (v) => v.length);
    check(steps === 6, `debug pipeline shows ${steps} stages`);
    // mark the pair by hand on the song picker: drag the copy, click the twin's start
    await page.locator("#pickWrap").scrollIntoViewIfNeeded();
    const pb = await page.locator("#pickWrap").boundingBox();
    const dur = await page.evaluate(() => { const t = window.__isol8.state.tracks.find((t) => /Band/.test(t.name)); return t.length / t.sr; });
    const X = (sec) => pb.x + (sec / dur) * pb.width, Y = pb.y + pb.height / 2;
    await page.mouse.click(X(60), Y); await page.waitForTimeout(400);
    check(await page.getAttribute("#pickPlay", "aria-label") === "Pause", "clicking the song picker in Listen mode plays from there");
    await page.click('[data-pick="src"]');
    await page.mouse.move(X(20.3), Y); await page.mouse.down(); await page.mouse.move(X(45), Y, { steps: 12 }); await page.mouse.up();
    await page.mouse.click(X(89.5), Y);
    const src = await page.inputValue("#probeSrc"), dst = await page.inputValue("#probeDst"), len = Number(await page.inputValue("#probeLen"));
    const near = (str, sec) => { const [m, x] = str.split(":").map(Number); return Math.abs(m * 60 + x - sec) < 0.6; };
    check(near(src, 20.3) && near(dst, 89.5) && Math.abs(len - 24.7) < 0.8, `dragging marks the copy (${src}, ${len} s) and a click places the twin (${dst})`);
    await page.click("#probeBtn");
    await page.waitForSelector(".verdict", { timeout: 60000 });
    const v = await page.$$eval(".verdict", (x) => x.map((e) => e.textContent));
    const lagTxt = await page.textContent(".probe-facts dd");
    check(/Already in the results as #\d+/.test(v[0]) && Math.abs(Number(lagTxt.replace(/,/g, "")) - 3050648) <= 1, `probe of your example locks lag ${lagTxt} and reports "${v[0]}"`);
    const before = await page.evaluate(() => window.__isol8.state.tracks.find((t) => /Band/.test(t.name)).results.length);
    const hasHidden = await page.$("#hiddenList .btn");
    if (hasHidden) {
      await hasHidden.click(); await page.waitForTimeout(500);
      const after = await page.evaluate(() => window.__isol8.state.tracks.find((t) => /Band/.test(t.name)).results.length);
      check(after === before + 1 && await page.getAttribute("#playBtn", "aria-label") === "Pause", "adding a hidden result lists it and plays it");
    }
    // settings reach the analysis: re-analyse with a lower result limit
    await page.click("#settingsBtn");
    await page.fill("#set-maxResults", "10"); await page.dispatchEvent("#set-maxResults", "input");
    await page.click("#reanalyse");
    await page.waitForFunction(() => { const t = window.__isol8.state.tracks.find((t) => /Band/.test(t.name)); return t.status === "done" && t.debug && t.debug.opt.maxResults === 10; }, null, { timeout: 240000 });
    const re = await page.evaluate(() => { const t = window.__isol8.state.tracks.find((t) => /Band/.test(t.name)); return { n: t.results.length, max: t.debug.opt.maxResults, lag: t.results.some((r) => Math.abs(r.lag - 3050648) <= 1) }; });
    check(re.n === 10 && re.max === 10 && re.lag, `re-analysing with Max results 10 gives ${re.n} results, your example still among them`);
    await page.click("#settingsReset"); await page.click("#settingsClose");
  }

  // low-quality warning: a 128 kbps MP3 made from one of the lossless examples
  const flac = path.join(EX, "nobody", fs.readdirSync(path.join(EX, "nobody")).find((f) => f.endsWith(".flac")));
  const lq = path.join(require("os").tmpdir(), "isol8 low quality.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-t", "60", "-i", flac, "-b:a", "128k", lq]);
  await page.setInputFiles("#fileInput", lq);
  await page.waitForFunction(() => { const t = window.__isol8.state.tracks.find((t) => t.name === "isol8 low quality.mp3"); return t && t.status === "done"; }, null, { timeout: 240000 });
  await page.click('.chip:has-text("isol8 low quality")');
  await page.waitForTimeout(300);
  const q = await page.evaluate(() => ({ hidden: document.getElementById("quality").hidden, text: document.getElementById("qualityText").textContent }));
  check(!q.hidden && /12\d kbps MP3/.test(q.text), `128 kbps MP3 shows a low-quality warning ("${q.text}")`);
  check(await page.$("#privacyBtn") === null && !(await page.textContent("body")).includes("Phase-cancellation isolator"), "privacy pill and eyebrow are gone");

  // a song with no repeats: the "not every song works" message, full width, no player
  {
    const noise = path.join(require("os").tmpdir(), "isol8 no repeats.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=30:seed=7", "-ac", "2", "-ar", "44100", noise]);
    await page.setInputFiles("#fileInput", noise);
    await page.waitForFunction(() => { const t = window.__isol8.state.tracks.find((t) => t.name === "isol8 no repeats.wav"); return t && t.status === "done"; }, null, { timeout: 120000 });
    await page.click('.chip:has-text("isol8 no repeats")');
    await page.waitForTimeout(400);
    const e = await page.evaluate(() => ({
      shown: !document.getElementById("noResults").hidden, text: document.getElementById("noResults").textContent,
      player: !document.getElementById("player").hidden, solo: document.querySelector(".bench").classList.contains("solo"),
      n: window.__isol8.state.tracks.find((t) => t.name === "isol8 no repeats.wav").results.length }));
    check(e.n === 0 && e.shown && /Not every song works/.test(e.text) && !e.player && e.solo, `no repeats: 0 results, "Not every song works" shown full width, no player`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "no-results.png"), fullPage: true });
    await page.click('.chip:has-text("The Band")'); await page.waitForTimeout(300);
  }

  // regression: clicking the waveform during the isolation sequence must not freeze it
  {
    const ids = await page.$$eval(".result", (r) => r.map((x) => x.dataset.id));
    await page.click(`.result[data-id="${ids[1] || ids[0]}"]`);
    await page.waitForTimeout(350);
    const wb = await page.locator("#waveWrap").boundingBox();
    await page.mouse.click(wb.x + wb.width * 0.3, wb.y + wb.height / 2);
    await page.waitForTimeout(2600);                 // past the sequence's own end, so only a real freeze fails
    const snap = () => page.evaluate(() => document.getElementById("waveCanvas").toDataURL());
    const a1 = await snap(); await page.waitForTimeout(500); const a2 = await snap();
    const playing = await page.getAttribute("#playBtn", "aria-label") === "Pause";
    check(playing && a1 !== a2, "seeking during the isolation sequence goes straight to the live waveform (playhead keeps moving)");
    if (playing) await page.click("#playBtn");
  }

  // light/dark toggle: flips the theme, recolours the canvases and is remembered
  {
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.click("[data-theme-toggle]");
    await page.waitForTimeout(700);                     // let the 0.45 s cross-fade finish
    const after = await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem("isol8-theme"),
      getComputedStyle(document.body).backgroundColor]);
    await page.reload();
    const kept = await page.evaluate(() => document.documentElement.dataset.theme);
    check(before !== after[0] && after[1] === after[0] && kept === after[0] && bgBefore !== after[2], `theme toggle ${before} → ${after[0]} (background ${bgBefore} → ${after[2]}), kept after reload`);
    await page.evaluate(() => localStorage.removeItem("isol8-theme"));
  }

  // GitHub star count (mocked: 1,234 stars on the app page)
  {
    await page.waitForFunction(() => !document.querySelector(".gh-stars").hidden, null, { timeout: 10000 }).catch(() => {});
    const gh = await page.evaluate(() => ({ text: document.querySelector(".gh-stars").textContent, hidden: document.querySelector(".gh-stars").hidden,
      label: document.querySelector("[data-gh-stars]").getAttribute("aria-label"), cached: sessionStorage.getItem("isol8-gh-stars") }));
    check(!gh.hidden && gh.text.trim() === "1.2k" && /1,234 stars/.test(gh.label) && /1234/.test(gh.cached), `GitHub button shows the star count ("${gh.text.trim()}", "${gh.label}")`);
  }

  // How it works page
  const how = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  how.on("pageerror", (e) => errors.push(String(e)));
  // the browser itself logs GitHub's 404 (repo not created yet); that one line is expected
  how.on("console", (m) => { if (m.type() === "error" && !(m.location().url || "").startsWith(GH_API)) errors.push(m.text()); });
  how.on("request", (r) => { if (offsite(r.url(), base)) external.push(r.url()); });
  await mockGitHub(how, 404);                        // what GitHub says until the repo exists
  await how.goto(base + "how.html");
  await how.waitForTimeout(800);
  await how.fill("#mis", "3"); await how.dispatchEvent("#mis", "input");
  const howInfo = await how.evaluate(() => ({ demos: document.querySelectorAll("canvas.demo").length, db: document.getElementById("misDb").textContent }));
  await how.waitForTimeout(1500);
  const ghMissing = await how.evaluate(() => ({ hidden: document.querySelector(".gh-stars").hidden, pill: document.querySelector("[data-gh-stars]").classList.contains("has-stars") }));
  check(ghMissing.hidden && !ghMissing.pill, "repo not found yet: GitHub button stays a plain icon");
  check(howInfo.demos >= 7 && /−\d/.test(howInfo.db), `How it works page renders ${howInfo.demos} demos, 3-sample offset leaves ${howInfo.db} dB`);
  if (SHOTS) await how.screenshot({ path: path.join(SHOTS, "how.png"), fullPage: true });

  check(external.length === 0, `no requests outside the app${external.length ? ": " + external.join(", ") : ""}`);
  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await browser.close();
  srv.close();
  console.log(fails ? `\n${fails} failures` : "\ne2e tests passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

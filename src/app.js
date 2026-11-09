/* isol8 app: UI, session, worker pool, playback and export. All processing is local. */
/* global Isol8Engine, Isol8Decode, Isol8Export */
(() => {
  "use strict";
  const E = Isol8Engine;
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Canvas palette ("r,g,b" strings) read from the theme's CSS variables. */
  const P = {};
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["bg", "ink", "muted", "faint", "amber", "cyan", "lilac", "mint", "danger"]) P[k] = cs.getPropertyValue(`--rgb-${k}`).trim().replace(/\s+/g, "");
  }
  readPalette();

  // ---------------------------------------------------------------- state
  const state = {
    tracks: [],          // {id, name, file, hash, status, sr, length, format, rateKnown, quality, opt, results, debug, probe, pick, error, errorStage, stageText, progress}
    current: null,       // track id
    selected: null,      // result id
    showAll: false,
    queue: [],
    busy: false,
  };
  const audioCache = new Map(); // track id -> channels (LRU, max 2)
  const CACHE_MAX = 2;

  // ---------------------------------------------------------------- utils
  function fmtTime(s, digits = 1) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60), r = s - m * 60;
    const sec = r.toFixed(digits).padStart(digits ? 3 + digits : 2, "0");
    return `${m}:${sec}`;
  }
  const fmtInt = (n) => n.toLocaleString("en-US");
  /** dB with one decimal; never prints NaN or Infinity. */
  const fmtDb = (v) => (Number.isFinite(v) ? v.toFixed(1) : "–");
  const baseName = (name) => name.replace(/\.[^.]+$/, "");

  /** Content hash (two FNV-1a passes) used to recognise a song already in the session. */
  function hashBuffer(buf) {
    const b = new Uint8Array(buf);
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ b.length;
    for (let i = 0; i < b.length; i++) {
      h1 ^= b[i]; h1 = Math.imul(h1, 0x01000193);
      h2 ^= b[b.length - 1 - i]; h2 = Math.imul(h2, 0x01000193);
    }
    return `${b.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
  }

  let toastTimer = null;
  function toast(msg, kind = "") {
    const t = $("toast");
    t.textContent = msg;
    t.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), kind === "error" ? 7000 : 4200);
  }

  function kindOf(p) {
    const upper = (p.bands[1] + p.bands[2] + p.bands[3]) / 3;
    if (p.bands[1] < 0.15 && p.bands[2] < 0.15 && p.bands[3] < 0.15) return "Cancels the low end";
    if (upper >= 0.4) return "Cancels most of the mix";
    return "Cancels part of the mix";
  }

  // -------------------------------------------------------- file quality
  const QUALITY_DETAIL = "Lossy compression encodes each copy of a section a little differently, so the copies no longer cancel perfectly and leave a hiss behind. A lossless file (FLAC, WAV, ALAC) gives cleaner isolations.";
  function hasBytes(b, text, from = 0, to = b.length) {
    const c = [...text].map((ch) => ch.charCodeAt(0));
    outer: for (let i = from; i <= Math.min(to, b.length) - c.length; i++) {
      for (let k = 0; k < c.length; k++) if (b[i + k] !== c[k]) continue outer;
      return true;
    }
    return false;
  }
  /** File size minus tags and cover art, so the bitrate estimate reflects the audio. */
  function audioBytes(b, format, size) {
    let n = size;
    if (format === "mp3") {
      let o = 0;
      while (b[o] === 0x49 && b[o + 1] === 0x44 && b[o + 2] === 0x33) {        // "ID3" (may repeat)
        const tag = ((b[o + 6] & 127) << 21) | ((b[o + 7] & 127) << 14) | ((b[o + 8] & 127) << 7) | (b[o + 9] & 127);
        o += 10 + tag + (b[o + 5] & 0x10 ? 10 : 0);
      }
      n -= o;
      if (b.length > 128 && b[b.length - 128] === 0x54 && b[b.length - 127] === 0x41 && b[b.length - 126] === 0x47) n -= 128; // "TAG"
    } else if (format === "mp4") {
      for (let i = 4; i < b.length - 4; i++) {                                   // "covr" atom (artwork)
        if (b[i] === 0x63 && b[i + 1] === 0x6f && b[i + 2] === 0x76 && b[i + 3] === 0x72) {
          const len = ((b[i - 4] << 24) | (b[i - 3] << 16) | (b[i - 2] << 8) | b[i - 1]) >>> 0;
          if (len > 8 && len < n) { n -= len; break; }
        }
      }
    }
    return Math.max(1, n);
  }
  /** Flags lossy files under 256 kbps and low sample rates, which both weaken the cancellation. */
  function assessQuality(b, dec, size) {
    const dur = dec.channels[0].length / dec.sampleRate;
    const kbps = dur > 0 ? (audioBytes(b, dec.format, size) * 8) / dur / 1000 : Infinity;
    let codec = null;                                           // null = lossless
    if (dec.format === "mp3") codec = "MP3";
    else if (dec.format === "mp4") codec = hasBytes(b, "alac") ? null : "AAC";
    else if (dec.format === "ogg") codec = hasBytes(b, "\x7fFLAC", 0, 256) ? null : hasBytes(b, "OpusHead", 0, 256) ? "Opus" : "Vorbis";
    else if (dec.format === "webm") codec = "WebM";
    const parts = [];
    if (codec && kbps < 256) parts.push(`${Math.round(kbps)} kbps ${codec}`);
    if (dec.sampleRate < 32000) parts.push(`${(dec.sampleRate / 1000).toFixed(dec.sampleRate % 1000 ? 1 : 0)} kHz`);
    return parts.length ? { label: parts.join(", "), kbps: Math.round(kbps), codec } : null;
  }

  // ------------------------------------------------------- saved sessions
  // Songs and their results are kept in this browser (IndexedDB) so a reload, or the phone
  // dropping the tab, doesn't mean analysing everything again. Nothing leaves the device.
  const store = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("isol8", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("tracks", { keyPath: "id" });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }).catch(() => null));
    const tx = async (mode, fn) => {
      const db = await open();
      if (!db) return null;
      return new Promise((res, rej) => {
        const t = db.transaction("tracks", mode), req = fn(t.objectStore("tracks"));
        t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    };
    return {
      put: (rec) => tx("readwrite", (st) => st.put(rec)),
      del: (id) => tx("readwrite", (st) => st.delete(id)),
      all: () => tx("readonly", (st) => st.getAll()),
    };
  })();
  const SAVED_FIELDS = ["id", "name", "file", "hash", "added", "status", "sr", "length", "format", "rateKnown", "quality", "opt",
    "results", "debug", "elapsed", "error", "errorStage", "pick"];
  let saveWarned = false;
  function saveTrack(t) {
    if (!t || t.removed || !window.indexedDB) return;
    const rec = {};
    for (const k of SAVED_FIELDS) if (t[k] !== undefined) rec[k] = t[k];
    rec.results = (t.results || []).slice();       // the array itself (debug info is saved separately)
    if (rec.status === "busy") rec.status = "queued";
    store.put(rec).catch((err) => {
      console.warn("Couldn't save", t.name, err);
      if (!saveWarned) { saveWarned = true; toast("This browser is out of storage space, so some songs won't be kept after you close the page.", "warn"); }
    });
  }
  function forgetTrack(id) { if (window.indexedDB) store.del(id).catch(() => {}); }
  /* ---- star reminder: shown once, after someone has had real use out of the app ---- */
  const STAR_KEY = "isol8-star", STAR_AFTER = { exports: 2, songs: 3 };
  function starState() {
    try { return JSON.parse(localStorage.getItem(STAR_KEY) || "null") || { songs: 0, exports: 0 }; }
    catch { return null; } // no storage: never show it, or it would come back every visit
  }
  function noteUse(kind) {
    const s = starState();
    if (!s || s.done) return;
    s[kind] = (s[kind] || 0) + 1;
    const due = s.exports >= STAR_AFTER.exports || s.songs >= STAR_AFTER.songs;
    if (due) s.done = true; // counts as shown even if they ignore it
    try { localStorage.setItem(STAR_KEY, JSON.stringify(s)); } catch { return; }
    if (due) setTimeout(showStarNudge, 4500); // after the "Saved." toast has gone
  }
  function showStarNudge() {
    const n = $("starNudge");
    n.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => n.classList.add("show")));
  }
  function hideStarNudge() {
    const n = $("starNudge");
    if (n.hidden) return;
    n.classList.remove("show");
    setTimeout(() => { n.hidden = true; }, 320);
  }
  function bindStarNudge() {
    $("starNudgeClose").addEventListener("click", hideStarNudge);
    $("starNudgeLater").addEventListener("click", hideStarNudge);
    $("starNudgeGo").addEventListener("click", () => setTimeout(hideStarNudge, 200));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideStarNudge(); });
  }

  /* ---- warn before the page is closed with songs open ---- */
  let inAppNavAt = 0;
  function bindLeaveWarning() {
    // a link to another isol8 page (How it works) isn't a real exit: songs come back on return
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[href]");
      if (a && a.origin === location.origin && !a.target && !a.hasAttribute("download")) inAppNavAt = Date.now();
    }, true);
    window.addEventListener("beforeunload", (e) => {
      if (!state.tracks.length) return;
      const working = state.tracks.some((t) => t.status === "busy" || t.status === "queued");
      if (!working && Date.now() - inAppNavAt < 1500) return;
      e.preventDefault();
      e.returnValue = ""; // older browsers need this to show the prompt
    });
  }

  function saveCurrent() { try { localStorage.setItem("isol8-current", state.current || ""); } catch { /* storage off */ } }

  async function restoreSession() {
    let recs;
    try { recs = await store.all(); } catch { return; }
    if (!recs || !recs.length || state.tracks.length) return;
    recs.sort((a, b) => (a.added || 0) - (b.added || 0));
    for (const r of recs) {
      if (!r.file || state.tracks.some((t) => t.hash === r.hash)) continue;
      const t = Object.assign({ results: [], progress: 0, stageText: "Waiting" }, r);
      if (t.status === "queued") {
        let buf;
        try { buf = await t.file.arrayBuffer(); } catch { forgetTrack(t.id); continue; }
        state.queue.push({ t, buf });
      } else t.progress = 1;
      state.tracks.push(t);
    }
    if (!state.tracks.length) return;
    let want = null;
    try { want = localStorage.getItem("isol8-current"); } catch { /* storage off */ }
    const cur = state.tracks.find((t) => t.id === want) || state.tracks[state.tracks.length - 1];
    state.current = cur.id;
    state.selected = cur.status === "done" && cur.results.length ? cur.results[0].id : null;
    renderAll();
    if (cur.status === "done") ensureAudio(cur).then(() => { if (state.current === cur.id) { mapCache = null; renderAll(); } }, () => {});
    pump();
  }

  // ------------------------------------------------------------ session UI
  const track = () => state.tracks.find((t) => t.id === state.current);
  const result = () => track()?.results?.find((r) => r.id === state.selected);

  let tabsShown = null;   // track id last scrolled into view
  /** Close every song. First click asks ("Close 3 songs?"), a second click within 4 s does it. */
  let closeAllTimer = null;
  function disarmCloseAll() {
    const b = $("closeAll");
    clearTimeout(closeAllTimer); closeAllTimer = null;
    b.classList.remove("armed");
    b.querySelector(".lbl").textContent = "Close all";
    b.title = "Close all songs";
    b.setAttribute("aria-label", "Close all songs");
  }
  function armedLabel() {
    const b = $("closeAll"), n = state.tracks.length;
    b.querySelector(".lbl").textContent = `Close ${n} songs?`;
    b.setAttribute("aria-label", `Click again to close all ${n} songs`);
  }
  function closeAllClick() {
    const b = $("closeAll");
    if (state.tracks.length < 2) return;
    if (!closeAllTimer) {
      b.classList.add("armed");
      b.title = "Click again to close every song";
      armedLabel();
      closeAllTimer = setTimeout(disarmCloseAll, 4000);
      return;
    }
    disarmCloseAll();
    const all = state.tracks.slice();
    const working = all.some((t) => t.status === "busy");
    for (const t of all) { t.removed = true; forgetTrack(t.id); audioCache.delete(t.id); probeCtx.delete(t.id); }
    state.tracks.splice(0);
    state.queue = [];
    if (working && state.abortAnalysis) state.abortAnalysis();
    stopPlayback(); pickStop();
    pick.buf = null; pick.bufFor = null;
    state.current = null; state.selected = null; state.showAll = false;
    mapCache = null;
    renderAll();
  }

  function renderSession() {
    const nav = $("session"), ul = $("sessionList");
    saveCurrent();
    nav.hidden = state.tracks.length === 0;
    $("closeAll").hidden = state.tracks.length < 2;
    if (closeAllTimer) { if (state.tracks.length < 2) disarmCloseAll(); else armedLabel(); }
    ul.replaceChildren(...state.tracks.map((t) => {
      const li = document.createElement("li");
      li.dataset.id = t.id;
      const b = document.createElement("button");
      b.type = "button";
      b.className = `chip ${t.status}`;
      b.setAttribute("aria-current", t.id === state.current ? "true" : "false");
      b.title = baseName(t.name);
      const led = document.createElement("span"); led.className = "led";
      const name = document.createElement("span"); name.className = "name"; name.textContent = baseName(t.name);
      const st = document.createElement("span"); st.className = "state";
      st.textContent = t.status === "done" ? `${t.results.length} twin${t.results.length === 1 ? "" : "s"}`
        : t.status === "error" ? (t.errorStage === "analyse" ? "Failed" : "Couldn't read") : t.status === "queued" ? "Waiting" : "Analysing";
      b.append(led, name, st);
      b.addEventListener("click", () => selectTrack(t.id));
      // middle-click closes, like a browser tab
      b.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); removeTrack(t.id); } });
      const x = document.createElement("button");
      x.type = "button"; x.className = "chip-close";
      x.setAttribute("aria-label", `Remove ${baseName(t.name)}`); x.title = "Remove";
      x.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      x.addEventListener("click", (e) => { e.stopPropagation(); removeTrack(t.id, li); });
      li.append(b, x);
      return li;
    }));
    if (state.current !== tabsShown) {
      tabsShown = state.current;
      const cur = ul.querySelector('[aria-current="true"]');
      if (cur) requestAnimationFrame(() => scrollTabIntoView(cur.parentElement));
    }
    updateTabArrows();
  }

  // ---------------------------------------------------- song tab scrolling
  function scrollTabIntoView(li) {
    const ul = $("sessionList"), pad = 44;
    const l = li.offsetLeft - ul.offsetLeft, r = l + li.offsetWidth;
    let to = null;
    if (l < ul.scrollLeft + pad) to = l - pad;
    else if (r > ul.scrollLeft + ul.clientWidth - pad) to = r - ul.clientWidth + pad;
    if (to !== null) ul.scrollTo({ left: Math.max(0, to), behavior: reduceMotion ? "auto" : "smooth" });
  }
  function updateTabArrows() {
    const ul = $("sessionList"), tabs = $("sessionTabs");
    const max = ul.scrollWidth - ul.clientWidth;
    const canL = max > 4 && ul.scrollLeft > 4, canR = max > 4 && ul.scrollLeft < max - 4;
    tabs.classList.toggle("can-l", canL); tabs.classList.toggle("can-r", canR);
    $("tabsPrev").hidden = !canL; $("tabsNext").hidden = !canR;
  }
  function bindTabScroller() {
    const ul = $("sessionList");
    const page = (dir) => ul.scrollBy({ left: dir * Math.max(120, ul.clientWidth * 0.7), behavior: reduceMotion ? "auto" : "smooth" });
    $("tabsPrev").addEventListener("click", () => page(-1));
    $("tabsNext").addEventListener("click", () => page(+1));
    ul.addEventListener("scroll", updateTabArrows, { passive: true });
    // a plain vertical wheel scrolls the strip sideways, but only while it can still move,
    // so the page keeps scrolling once the strip hits either end
    ul.addEventListener("wheel", (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = ul.scrollWidth - ul.clientWidth;
      if (max <= 1) return;
      const d = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * ul.clientWidth : e.deltaY;
      if ((d < 0 && ul.scrollLeft <= 0) || (d > 0 && ul.scrollLeft >= max - 1)) return;
      e.preventDefault();
      ul.scrollLeft += d;
    }, { passive: false });
    // mouse drag to scroll (touch already pans natively)
    let drag = null;
    ul.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || ul.scrollWidth <= ul.clientWidth) return;
      drag = { x: e.clientX, left: ul.scrollLeft, moved: false, id: e.pointerId };
    });
    ul.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 5) return;
      if (!drag.moved) { drag.moved = true; ul.setPointerCapture(e.pointerId); }
      ul.scrollLeft = drag.left - dx;
    });
    const end = () => {
      if (!drag) return;
      if (drag.moved) {
        // swallow the click that ends a drag so it doesn't switch songs
        ul.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
      }
      drag = null;
    };
    ul.addEventListener("pointerup", end);
    ul.addEventListener("pointercancel", end);
    if (window.ResizeObserver) new ResizeObserver(updateTabArrows).observe(ul);
    window.addEventListener("resize", updateTabArrows);
  }

  function removeTrack(id, li) {
    const i = state.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = state.tracks[i];
    const finish = () => {
      const j = state.tracks.indexOf(t);
      if (j < 0) return;
      t.removed = true;
      state.tracks.splice(j, 1);
      forgetTrack(t.id);
      state.queue = state.queue.filter((q) => q.t !== t);
      if (t.status === "busy" && state.abortAnalysis) state.abortAnalysis();
      audioCache.delete(t.id);
      probeCtx.delete(t.id);
      if (state.current === t.id) {
        stopPlayback(); pickStop();
        pick.buf = null; pick.bufFor = null;
        const next = state.tracks[j] || state.tracks[j - 1] || null;
        state.current = next ? next.id : null;
        state.selected = next && next.status === "done" && next.results.length ? next.results[0].id : null;
        state.showAll = false;
        mapCache = null;
        renderAll();
        if (next && next.status === "done") ensureAudio(next).then(() => { if (state.current === next.id) { mapCache = null; renderAll(); } });
      } else {
        renderAll();
      }
    };
    if (li && !reduceMotion) { li.classList.add("leaving"); setTimeout(finish, 200); } else finish();
  }

  function selectTrack(id) {
    if (state.current === id) return;
    stopPlayback();
    pickStop();
    pick.buf = null; pick.bufFor = null;              // free the previous song's playback copy
    state.current = id;
    state.selected = null;
    state.showAll = false;
    const t = track();
    if (t.status === "done" && t.results.length) state.selected = t.results[0].id;
    renderAll();
    if (t.status === "done") ensureAudio(t).then(() => { mapCache = null; renderAll(); });
  }

  // ------------------------------------------------------------ file input
  async function addFiles(files) {
    for (const file of files) {
      let buf;
      try { buf = await file.arrayBuffer(); } catch { toast(`Couldn't open ${file.name}.`, "error"); continue; }
      const hash = hashBuffer(buf);
      const existing = state.tracks.find((t) => t.hash === hash);
      if (existing) {
        toast(`${baseName(file.name)} is already in this session, so it wasn't added again.`);
        selectTrack(existing.id);
        continue;
      }
      const t = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: file.name, file, hash,
        status: "queued", results: [], progress: 0, stageText: "Waiting", opt: Object.assign({}, settings), added: Date.now() };
      state.tracks.push(t);
      saveTrack(t);
      state.queue.push({ t, buf });
      // show the new song unless the user is busy listening to a finished one
      const cur = track();
      if (!cur || cur.status === "error" || (cur.status === "done" && !player.playing)) {
        stopPlayback(); state.current = t.id; state.selected = null;
      }
    }
    renderAll();
    pump();
  }

  async function pump() {
    if (state.busy) return;
    const job = state.queue.shift();
    if (!job) return;
    state.busy = true;
    const { t, buf } = job;
    if (!track() || (track().status !== "done" && track().status !== "busy")) { state.current = t.id; state.selected = null; }
    let stage = "decode";
    try {
      t.status = "busy"; t.error = null; t.errorStage = null;
      setStage(t, "Reading audio", 0.02);
      const dec = await Isol8Decode.decodeNative(buf);
      stage = "analyse";
      t.sr = dec.sampleRate; t.length = dec.channels[0].length; t.format = dec.format; t.rateKnown = dec.rateKnown;
      t.quality = assessQuality(new Uint8Array(buf), dec, t.file.size);
      cacheAudio(t.id, dec.channels);
      if (!dec.rateKnown) toast("Couldn't read the sample rate from this file, so it was decoded at 44.1 kHz. If the song uses another rate, results may be weaker.", "warn");
      if (t.id === state.current) { mapCache = null; renderAll(); }
      if (t.removed) throw Object.assign(new Error("Cancelled"), { cancelled: true });
      const results = await analyse(dec.channels, dec.sampleRate, (stage, frac) => setStage(t, stage, frac), t.opt);
      if (t.removed) throw Object.assign(new Error("Cancelled"), { cancelled: true });
      t.results = results;
      t.debug = results.debug;
      t.probe = null;
      probeCtx.delete(t.id);
      t.elapsed = results.elapsedMs;
      t.status = "done";
      noteUse("songs");
      if (t.id === state.current) {
        state.selected = results.length ? results[0].id : null;
        mapCache = null;
        celebrate();
      }
    } catch (err) {
      if (t.removed || err.cancelled) { audioCache.delete(t.id); state.busy = false; renderAll(); pump(); return; }
      console.error(err);
      t.status = "error";
      t.error = String(err && err.message || err);
      t.errorStage = stage;
      toast(stage === "decode" ? `Couldn't read ${baseName(t.name)}. Try converting it to WAV or FLAC.`
        : `Analysing ${baseName(t.name)} failed. Try again, or lower "Candidates to check" if the browser ran out of memory.`, "error");
    }
    saveTrack(t);
    state.busy = false;
    renderAll();
    pump();
  }

  function setStage(t, text, frac) {
    t.stageText = text; t.progress = frac;
    if (t.id === state.current) {
      $("stageText").textContent = text;
      $("stagePct").textContent = `${Math.round(frac * 100)}%`;
      $("stageBar").style.width = `${(frac * 100).toFixed(1)}%`;
    }
  }

  function cacheAudio(id, channels) {
    audioCache.delete(id);
    audioCache.set(id, channels);
    while (audioCache.size > CACHE_MAX) {
      const oldest = audioCache.keys().next().value;
      if (oldest === state.current) { audioCache.set(oldest, audioCache.get(oldest)); audioCache.delete(oldest); continue; }
      audioCache.delete(oldest);
    }
  }
  async function ensureAudio(t) {
    if (audioCache.has(t.id)) { const ch = audioCache.get(t.id); cacheAudio(t.id, ch); return ch; }
    const dec = await Isol8Decode.decodeNative(await t.file.arrayBuffer());
    cacheAudio(t.id, dec.channels);
    return dec.channels;
  }

  // ---------------------------------------------------------- worker pool
  const CORES = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1));
  function poolSize(length) {
    const mem = navigator.deviceMemory || 8;
    const perWorkerMB = (length * 4 * 2) / 1e6;                // a copy of the track per worker
    const byMem = Math.max(1, Math.floor((mem * 1000 * 0.25) / Math.max(perWorkerMB, 1)));
    return Math.max(1, Math.min(CORES, byMem));
  }

  function makeWorker() {
    try { return new Worker("worker.js"); } catch { return null; }
  }

  /** Runs the engine pipeline on a pool of workers; falls back to this thread. */
  async function analyse(channels, sr, onStage, options) {
    const t0 = performance.now();
    const opt = Object.assign({}, E.DEFAULTS, options || {});
    const n = channels[0].length;
    const k = poolSize(n);
    const workers = [];
    for (let i = 0; i < k; i++) { const w = makeWorker(); if (w) workers.push(w); }
    if (!workers.length) {
      onStage("Analysing on this thread", 0.1);
      await new Promise((r) => setTimeout(r, 30));
      const ctx = E.prepare(channels, sr, opt), f = E.features(ctx), [l0, l1] = E.lagRange(ctx);
      const raw = E.coarseScan(f, sr, ctx.opt, l0, l1);
      const cands = E.selectCandidates(raw, f.hop, ctx.opt);
      const found = [];
      cands.forEach((c) => found.push(...E.analyseCandidate(ctx, c)));
      const stats = {};
      const res = E.finalize(ctx, found, stats);
      res.elapsedMs = performance.now() - t0;
      res.debug = { raw: raw.length, cands, stats, opt, hop: f.hop };
      return res;
    }
    const job = Math.random();
    const pending = new Map();
    let taskSeq = 0;
    const call = (w, msg, onProgress) => new Promise((resolve, reject) => {
      const task = ++taskSeq;
      pending.set(task, { resolve, reject, onProgress });
      w.postMessage(Object.assign({ job, task }, msg));
    });
    for (const w of workers) {
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") { const p = pending.get("init:" + workers.indexOf(w)); if (p) { pending.delete("init:" + workers.indexOf(w)); p.resolve(); } return; }
        const p = pending.get(m.task);
        if (!p) return;
        if (m.type === "progress") { p.onProgress && p.onProgress(m.frac); return; }
        pending.delete(m.task);
        if (m.type === "error") p.reject(new Error(m.message)); else p.resolve(m);
      };
      w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || "Worker failed")); pending.clear(); };
    }
    state.abortAnalysis = () => {
      const err = new Error("Cancelled"); err.cancelled = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    try {
      onStage("Mapping repeats", 0.08);
      await Promise.all(workers.map((w, i) => new Promise((resolve, reject) => {
        pending.set("init:" + i, { resolve, reject });
        w.postMessage({ type: "init", job, channels, sampleRate: sr, options: opt });
      })));

      // coarse scan, split into chunks of equal work (cost of lag L ∝ frames - L)
      const hop = Math.pow(2, Math.round(Math.log2(sr * 0.0464)));
      const frames = n >= 2 * hop ? 1 + Math.floor((n - 2 * hop) / hop) : 0;
      const fps = sr / hop;
      const l0 = Math.floor(opt.minLagS * fps), l1 = frames - Math.floor(opt.minLenS * fps);
      const chunks = [];
      const nChunks = Math.max(1, workers.length * 4);
      const totalWork = ((frames - l0) ** 2 - (frames - l1) ** 2) / 2;
      let from = l0;
      for (let c = 1; c <= nChunks && from < l1; c++) {
        // solve (frames-from)^2 - (frames-to)^2 = 2*work for `to`
        const target = (frames - l0) ** 2 - (2 * totalWork * c) / nChunks;
        let to = c === nChunks ? l1 : Math.min(l1, Math.ceil(frames - Math.sqrt(Math.max(0, target))));
        to = Math.max(to, from + 1);
        chunks.push({ from, to, work: ((frames - from) ** 2 - (frames - to) ** 2) / 2 });
        from = to;
      }
      const chunkDone = new Array(chunks.length).fill(0);
      const scanProgress = () => {
        const done = chunks.reduce((s, ch, i) => s + ch.work * chunkDone[i], 0) / Math.max(1, totalWork);
        onStage("Mapping repeats", 0.1 + 0.35 * done);
      };
      const raw = [];
      let next = 0;
      await Promise.all(workers.map(async (w) => {
        while (next < chunks.length) {
          const i = next++;
          const m = await call(w, { type: "scan", from: chunks[i].from, to: chunks[i].to }, (f) => { chunkDone[i] = f; scanProgress(); });
          chunkDone[i] = 1; scanProgress();
          raw.push(...m.raw);
        }
      }));
      const cands = E.selectCandidates(raw, hop, opt);

      // sample-exact lock + region measurement per candidate
      const found = [];
      let ci = 0, done = 0;
      onStage("Locking alignment", 0.45);
      await Promise.all(workers.map(async (w) => {
        while (ci < cands.length) {
          const c = cands[ci++];
          const m = await call(w, { type: "candidate", candidate: c });
          found.push(...m.pairs);
          done++;
          onStage("Locking alignment", 0.45 + 0.5 * (done / cands.length));
        }
      }));
      onStage("Removing duplicates", 0.96);
      await new Promise((r) => setTimeout(r, 0));
      const stats = {};
      const res = E.finalize({ ch: channels, sr, opt }, found, stats);
      res.elapsedMs = performance.now() - t0;
      res.debug = { raw: raw.length, cands, stats, opt, hop };
      onStage("Done", 1);
      return res;
    } finally {
      state.abortAnalysis = null;
      workers.forEach((w) => w.terminate());
    }
  }

  // --------------------------------------------------------- render: page
  function renderAll() {
    const t = track();
    renderSession();
    $("dropPrompt").hidden = !!t;
    $("trackMeta").hidden = !t;
    $("status").hidden = !t || (t.status !== "busy" && t.status !== "queued");
    $("scopeLegend").hidden = !t || t.status !== "done" || !t.results.length;
    $("workbench").hidden = !t || t.status !== "done";
    $("intro").hidden = state.tracks.length > 0;
    renderSettingsHead();
    document.body.classList.toggle("busy", state.tracks.some((x) => x.status === "busy" || x.status === "queued"));
    wakeScope();
    if (!t) { scope.mode = "idle"; $("scope").classList.add("empty"); return; }
    $("trackTitle").textContent = baseName(t.name);
    const facts = [];
    if (t.length) facts.push(fmtTime(t.length / t.sr, 0));
    if (t.sr) facts.push(`${(t.sr / 1000).toFixed(t.sr % 1000 ? 1 : 0)} kHz`);
    if (t.format && t.format !== "unknown") facts.push(t.format.toUpperCase());
    if (t.status === "done" && t.elapsed) facts.push(`analysed in ${(t.elapsed / 1000).toFixed(1)} s`);
    $("trackFacts").replaceChildren(...facts.map((f) => { const e = document.createElement("span"); e.textContent = f; return e; }));
    $("scope").classList.toggle("empty", !t);
    $("quality").hidden = !t.quality;
    if (t.quality) {
      $("qualityText").textContent = `Low-quality file (${t.quality.label}): isolations will be noisier`;
      $("quality").title = QUALITY_DETAIL;
      $("quality").setAttribute("aria-label", `Low-quality file, ${t.quality.label}. ${QUALITY_DETAIL}`);
    }
    if (t.status === "busy" || t.status === "queued") {
      scope.mode = "busy";
      setStage(t, t.stageText, t.progress);
    } else if (t.status === "error") {
      scope.mode = "idle";
      $("status").hidden = false;
      $("stageText").textContent = t.errorStage === "analyse"
        ? "The analysis failed. Re-analyse to try again, or lower \"Candidates to check\" in the settings."
        : "Couldn't read this file. Try converting it to WAV or FLAC.";
      $("stagePct").textContent = "";
      $("stageBar").style.width = "0";
    } else {
      scope.mode = "map";
      renderResults();
      renderPlayer();
      renderDebug();
    }
  }

  function arrowSvg() {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 18 10"); s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M1 5h15M12 1l4 4-4 4"); p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.4"); p.setAttribute("stroke-linecap", "round");
    s.append(p);
    return s;
  }

  const VISIBLE = 8;
  function renderResults() {
    const t = track(), list = $("resultList");
    const res = t.results;
    $("noResults").hidden = res.length > 0;
    document.querySelector(".bench").classList.toggle("solo", !res.length);
    $("resultsAside").textContent = res.length ? `${res.length} found` : "";
    const shown = state.showAll ? res : res.slice(0, VISIBLE);
    const fresh = list.dataset.track !== t.id || list.dataset.all !== String(state.showAll);
    list.dataset.track = t.id; list.dataset.all = String(state.showAll);
    list.classList.toggle("animate", fresh && !reduceMotion);
    list.replaceChildren(...shown.map((p, idx) => {
      const li = document.createElement("li");
      li.style.setProperty("--i", String(idx));
      const b = document.createElement("button");
      b.type = "button"; b.className = "result"; b.dataset.id = p.id;
      b.setAttribute("aria-pressed", p.id === state.selected ? "true" : "false");
      const sr = p.sr;
      const rank = document.createElement("span"); rank.className = "rank"; rank.textContent = p.rank;
      const times = document.createElement("span"); times.className = "times";
      const ts = document.createElement("span"); ts.className = "t-src"; ts.textContent = fmtTime(p.srcStart / sr);
      const td = document.createElement("span"); td.className = "t-dst"; td.textContent = fmtTime(p.dstStart / sr);
      const len = document.createElement("span"); len.className = "len"; len.textContent = `${((p.dstEnd - p.dstStart) / sr).toFixed(1)} s`;
      times.append(ts, arrowSvg(), td, len);
      const db = document.createElement("span"); db.className = "db";
      db.append(document.createTextNode(fmtDb(p.cancelDb)));
      const u = document.createElement("small"); u.textContent = "dB"; db.append(u);
      const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = kindOf(p);
      const bands = document.createElement("span"); bands.className = "bands";
      bands.title = `Share that cancels: lows ${pct(p.bands[0])}, low mids ${pct(p.bands[1])}, high mids ${pct(p.bands[2])}, highs ${pct(p.bands[3])}`;
      for (const v of p.bands) {
        const i = document.createElement("i");
        i.style.height = `${Math.max(2, v * 16)}px`;
        if (v < 0.2) i.className = "weak";
        i.style.setProperty("--i", String(idx));
        bands.append(i);
      }
      b.setAttribute("aria-label", `Result ${p.rank}: copied from ${fmtTime(p.srcStart / sr)} onto ${fmtTime(p.dstStart / sr)}, ${((p.dstEnd - p.dstStart) / sr).toFixed(1)} seconds, cancels by ${fmtDb(p.cancelDb)} dB. ${kindOf(p)}.`);
      b.append(rank, times, db, kind, bands);
      b.addEventListener("click", () => { selectResult(p.id, "play"); wakeScope(); });
      li.append(b);
      return li;
    }));
    const more = $("showMore");
    more.hidden = res.length <= VISIBLE;
    more.textContent = state.showAll ? "Show fewer" : `Show ${res.length - VISIBLE} more`;
  }
  const pct = (v) => `${Math.round(v * 100)}%`;

  /** how: false = stay stopped, true = keep playing if it was, "play" = start playing (clicks). */
  function selectResult(id, how = false) {
    if (state.selected === id) { if (how === "play" && !player.playing) play(); return; }
    const keepPlaying = how;
    const wasPlaying = player.playing;
    stopPlayback();
    state.selected = id;
    const t = track();
    const idx = t.results.findIndex((r) => r.id === id);
    if (idx >= VISIBLE && !state.showAll) state.showAll = true;
    renderResults();
    renderPlayer();
    if (keepPlaying === "play" || (keepPlaying && wasPlaying)) play();
  }

  // --------------------------------------------------------------- player
  const MODES = ["iso", "dst", "src"];
  const MODE_NOTE = {
    iso: "Twin minus copy. Everything the two share cancels; what's left was in only one of them.",
    dst: "The twin section, untouched.",
    src: "The copied section, lined up with the twin.",
  };
  const player = {
    ctx: null, nodes: null, playing: false, startedAt: 0, offset: 0,
    mode: "iso", key: null, buffers: null, iso: null, nudge: 0, best: null, duration: 0,
    blend: 1,            // 0 = twin, 1 = isolated (twin minus the whole copy)
    clean: loadClean(),  // {noise, amount, stereo}: optional clean-up of the isolation (stereo isn't remembered between visits)
  };
  function loadClean() {
    // only noise reduction is remembered between visits; stereo and filter start fresh
    const def = { noise: false, amount: 0.5, stereo: "full", pan: 0, focus: 0.25, low: 0, high: 0 };
    try {
      const v = JSON.parse(localStorage.getItem("isol8-clean"));
      if (v && typeof v === "object") return { ...def, noise: !!v.noise, amount: Number.isFinite(v.amount) ? Math.max(0, Math.min(1, v.amount)) : def.amount };
    } catch { /* storage off */ }
    return def;
  }
  function saveClean() { try { localStorage.setItem("isol8-clean", JSON.stringify({ noise: player.clean.noise, amount: player.clean.amount })); } catch { /* storage off */ } }

  function renderPlayer() {
    const p = result(), t = track();
    $("player").hidden = !p;
    if (!p) return;
    const sr = p.sr;
    $("playerNum").textContent = `#${p.rank}`;
    $("playerTitle").textContent = `${fmtTime(p.srcStart / sr)} onto ${fmtTime(p.dstStart / sr)}`;
    $("playerKind").textContent = kindOf(p);
    $("fSrc").textContent = `${fmtTime(p.srcStart / sr)} – ${fmtTime(p.srcEnd / sr)}`;
    $("fDst").textContent = `${fmtTime(p.dstStart / sr)} – ${fmtTime(p.dstEnd / sr)}`;
    $("fLen").textContent = `${((p.dstEnd - p.dstStart) / sr).toFixed(1)} s`;
    $("waveStart").textContent = fmtTime(p.dstStart / sr);
    $("waveEnd").textContent = fmtTime(p.dstEnd / sr);
    const key = `${t.id}:${p.id}`;
    const fresh = player.key !== key;
    if (fresh) {
      player.key = key; player.nudge = 0; player.best = null; player.buffers = null; player.offset = 0; player.iso = null; player.spec = null;
      player.crop = null; renderCrop();
      waveBase = null;
      scope.pulseAt = performance.now(); scope.pulseId = p.id; wakeScope();
    }
    updateAlignmentUi();
    if (!$("modeNote").textContent) $("modeNote").textContent = modeNote();
    requestAnimationFrame(placeModePill);
    prepareBuffers().then(() => { if (player.key !== key) return; if (fresh) playIntro(); else drawWave(); });
  }

  function currentLag() { const p = result(); return p ? p.lag + player.nudge : 0; }

  function updateAlignmentUi() {
    const p = result();
    if (!p) return;
    const lag = currentLag();
    $("lagOut").textContent = `${fmtInt(lag)} (${(lag / p.sr).toFixed(4)} s)`;
    $("nudgeReset").hidden = player.nudge === 0;
    const db = player.best === null ? p.cancelDb : player.best;
    $("fDb").textContent = `${fmtDb(db)} dB`;
  }

  /** Shared by renderPlayer and play(), so a click that does both computes the buffers once. */
  function prepareBuffers() {
    const c = player.clean;
    const tag = `${player.key}|${player.nudge}|${JSON.stringify(c)}`;
    if (player.prep && player.prep.tag === tag) return player.prep.promise;
    const promise = buildBuffers().finally(() => { if (player.prep && player.prep.promise === promise) player.prep = null; });
    player.prep = { tag, promise };
    return promise;
  }
  async function buildBuffers() {
    const t = track(), p = result(), key = player.key;
    if (!t || !p) return;
    const ch = await ensureAudio(t);
    if (player.key !== key || result() !== p) return;          // the selection moved on meanwhile
    const lag = currentLag();
    const s = Math.max(p.dstStart, lag), e = Math.min(p.dstEnd, ch[0].length);
    const clean = Object.assign({}, player.clean), cleanTag = JSON.stringify(clean);
    const dst = ch.map((c) => c.subarray(s, e)), src = ch.map((c) => c.subarray(s - lag, e - lag));
    // the isolation + noise reduction is reused while only the stereo or filter settings change
    const baseTag = `${key}|${lag}|${clean.noise}|${clean.noise ? clean.amount : ""}`;
    const slow = (clean.noise && player.base?.tag !== baseTag) || clean.stereo === "position";
    if (slow) { $("player").classList.add("working"); await new Promise((r) => setTimeout(r, 30)); }
    let base = player.base?.tag === baseTag ? player.base : null;
    if (!base) {
      let iso = E.isolate(ch, lag, s, e);
      if (clean.noise) iso = E.denoise(iso, dst, p.sr, clean.amount);
      base = { tag: baseTag, iso, panMap: null };
    }
    let iso = base.iso;
    if (clean.stereo === "position") {
      if (!base.panMap) base.panMap = E.panMap(iso, p.sr, 61);
      iso = E.panExtract(iso, p.sr, clean.pan, clean.focus);
    } else iso = E.stereoPart(iso, clean.stereo);
    iso = E.bandLimit(iso, p.sr, clean.low, clean.high);
    $("player").classList.remove("working");
    if (player.key !== key || result() !== p || currentLag() !== lag || JSON.stringify(player.clean) !== cleanTag) return;
    player.base = base;
    player.iso = iso; player.dst = dst; player.src = src;
    player.span = [s, e];
    player.duration = (e - s) / p.sr;
    if (player.crop) setCrop(player.crop[0], player.crop[1]);   // the section can shrink when nudged
    player.buffers = null; // AudioBuffers are made lazily on play (needs a context)
    const shaped = clean.noise || clean.stereo !== "full" || clean.low > 0 || clean.high > 0;
    player.best = player.nudge !== 0 || shaped ? E.cancelDbOf(dst, src, iso) : null;
    renderCleanHint();
    drawPanMap();
    player.spec = staticSpectrum(player.dst, player.iso, p.sr);
    updateAlignmentUi();
  }

  function toAudioBuffer(chs, sr) {
    const b = player.ctx.createBuffer(chs.length, chs[0].length, sr);
    chs.forEach((c, i) => b.copyToChannel(c, i));
    return b;
  }

  /**
   * Get the shared AudioContext, waking it up. Call it synchronously from the click/tap
   * handler (before any await): iOS Safari only lets audio start inside a user gesture.
   */
  function audioCtx() {
    // iOS routes Web Audio as "ambient" sound by default, which the ring/silent switch mutes,
    // so the app looks broken on most iPhones. "playback" plays like a music app does.
    try { if (navigator.audioSession && navigator.audioSession.type !== "playback") navigator.audioSession.type = "playback"; } catch { /* unsupported */ }
    if (!player.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      player.ctx = new AC();
      // a phone call, Siri or another app's audio "interrupts" the context on iOS; reflect that in the UI
      player.ctx.addEventListener("statechange", () => {
        if (player.ctx.state === "running") return;
        if (player.playing) pause();
        if (pick.playing) pickStop();
      });
    }
    // iOS also uses the non-standard "interrupted" state, which needs resume() just like "suspended"
    if (player.ctx.state !== "running") {
      const r = player.ctx.resume();
      // iOS can leave the promise pending after an interruption; don't let that hang play()
      return Promise.race([r, new Promise((res) => setTimeout(res, 400))]).then(() => player.ctx, () => player.ctx);
    }
    return Promise.resolve(player.ctx);
  }

  /** Volume of each stream: the blend slides from the twin (0) to the isolation (1). */
  function gainFor(m) {
    if (player.mode === "src") return m === "src" ? 1 : 0;
    return m === "dst" ? 1 - player.blend : m === "iso" ? player.blend : 0;
  }
  function applyGains() {
    if (!player.nodes) return;
    const now = player.ctx.currentTime;
    for (const [m, n] of Object.entries(player.nodes)) {
      n.g.gain.cancelScheduledValues(now);
      n.g.gain.setTargetAtTime(gainFor(m), now, 0.008);
    }
  }

  let playSeq = 0;   // bumped by every start/stop, so an older play() that is still awaiting gives up
  async function play() {
    const p = result();
    if (!p) return;
    pickStop();
    if (player.nodes) stopPlayback(true);
    const my = ++playSeq;
    await audioCtx();
    if (my !== playSeq) return;
    if (!player.iso) await prepareBuffers();
    if (my !== playSeq || !player.iso || result() !== p) return;
    if (!player.buffers) {
      player.buffers = { iso: toAudioBuffer(player.iso, p.sr), dst: toAudioBuffer(player.dst, p.sr), src: toAudioBuffer(player.src, p.sr) };
    }
    const ctx = player.ctx, loop = $("loop").checked;
    const at = ctx.currentTime + 0.03;
    const [ca, cb] = cropRange();
    if (player.offset < ca || player.offset >= cb - 0.01) player.offset = ca;
    player.nodes = {};
    for (const m of MODES) {
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = player.buffers[m]; src.loop = loop;
      if (loop) { src.loopStart = ca; src.loopEnd = cb; }
      g.gain.value = gainFor(m);
      src.connect(g).connect(ctx.destination);
      let an = null;
      if (m === "dst" || m === "iso") {                // live spectrum taps (before the mode gain)
        an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0.78;
        src.connect(an);
      }
      if (loop) src.start(at, player.offset); else src.start(at, player.offset, cb - player.offset);
      player.nodes[m] = { src, g, an };
    }
    player.nodes.iso.src.onended = () => { if (player.playing && !$("loop").checked) { player.playing = false; player.offset = cropRange()[0]; setPlayIcon(); } };
    player.startedAt = at - player.offset;
    player.playing = true;
    setPlayIcon();
    tick();
  }

  function position() {
    if (!player.playing) return player.offset;
    const t = player.ctx.currentTime - player.startedAt;     // where the section would be without looping
    const [ca, cb] = cropRange();
    if (!$("loop").checked) return Math.min(t, cb);
    return t < cb ? Math.max(0, t) : ca + ((t - ca) % (cb - ca));
  }

  // ------------------------------------------------------------------ crop
  // Section-relative seconds [start, end]; null = the whole section. Playback stays inside it
  // and the isolated-sound export is cut to it.
  const MIN_CROP = 0.05;
  const cropRange = () => player.crop || [0, player.duration];
  function setCrop(a, b, moving) {
    const d = player.duration;
    if (!(d > MIN_CROP)) return;
    a = Math.max(0, Math.min(a, d)); b = Math.max(0, Math.min(b, d));
    if (b - a < MIN_CROP) { if (moving === "a") a = b - MIN_CROP; else b = a + MIN_CROP; }
    if (a < 0) { a = 0; b = MIN_CROP; }
    if (b > d) { b = d; a = d - MIN_CROP; }
    player.crop = [a, b];
    renderCrop();
    drawWaveHead();
  }
  function renderCrop() {
    const on = !!player.crop, p = result();
    $("cropOn").checked = on;
    $("cropFields").hidden = !on;
    $("cropA").hidden = $("cropB").hidden = !on;
    $("cropNote").textContent = on && $("exportWhat").value === "invSong" ? "Crop only applies when exporting the isolated sound." : "";
    if (!on || !p || !player.span) return;
    const [a, b] = player.crop, d = Math.max(player.duration, 1e-9), base = player.span[0] / p.sr;
    // keep each handle's grab area inside the waveform; the line inside it stays exact
    const W = $("waveWrap").clientWidth;
    for (const [id, v] of [["cropA", a], ["cropB", b]]) {
      const h = $(id), hw = h.offsetWidth || 22, x = (v / d) * W;
      const left = Math.max(0, Math.min(W - hw, x - hw / 2));
      h.style.left = `${left}px`;
      h.style.setProperty("--line", `${x - left}px`);
    }
    for (const [id, v] of [["cropStart", a], ["cropEnd", b]]) {
      const el = $(id);
      if (document.activeElement !== el) { el.value = fmtTime(base + v, 2); el.classList.remove("bad"); }
    }
    $("cropLen").textContent = `${(b - a).toFixed(2)} s`;
  }
  function restartIfPlaying() { if (player.playing) { const pos = position(); pause(); player.offset = pos; play(); } }
  function bindCrop() {
    const ww = $("waveWrap");
    $("cropOn").addEventListener("change", (e) => {
      if (e.target.checked) setCrop(0, player.duration);
      else { player.crop = null; renderCrop(); drawWaveHead(); }
      restartIfPlaying();
    });
    $("exportWhat").addEventListener("change", renderCrop);
    window.addEventListener("resize", () => { if (player.crop) renderCrop(); });
    for (const [id, which] of [["cropA", "a"], ["cropB", "b"]]) {
      const h = $(id);
      const at = (e) => { const r = ww.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * player.duration; };
      const move = (v) => { const [a, b] = cropRange(); setCrop(which === "a" ? v : a, which === "b" ? v : b, which); };
      let dragging = null;
      h.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); e.preventDefault();
        dragging = e.pointerId;
        try { h.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        h.classList.add("drag"); h.focus({ preventScroll: true });
      });
      h.addEventListener("pointermove", (e) => { if (dragging === e.pointerId) move(at(e)); });
      const end = (e) => {
        if (dragging !== e.pointerId) return;
        dragging = null; h.classList.remove("drag");
        try { h.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        restartIfPlaying();
      };
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
      h.addEventListener("click", (e) => e.stopPropagation());
      h.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault(); e.stopPropagation();
        const step = (e.shiftKey ? 0.5 : 0.05) * (e.key === "ArrowLeft" ? -1 : 1);
        move(cropRange()[which === "a" ? 0 : 1] + step);
      });
      h.addEventListener("keyup", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") restartIfPlaying(); });
    }
    for (const [id, which] of [["cropStart", "a"], ["cropEnd", "b"]]) {
      const el = $(id);
      const commit = () => {
        const p = result(), v = parseTime(el.value);
        if (!p || !player.span || !Number.isFinite(v)) { el.classList.add("bad"); return; }
        const rel = v - player.span[0] / p.sr, [a, b] = cropRange();
        el.classList.remove("bad");
        setCrop(which === "a" ? rel : a, which === "b" ? rel : b, which);
        el.value = fmtTime(player.span[0] / p.sr + player.crop[which === "a" ? 0 : 1], 2);
        restartIfPlaying();
      };
      el.addEventListener("change", commit);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
    }
  }

  function stopPlayback(keepPosition = false) {
    playSeq++;
    if (player.nodes) {
      const pos = position();
      for (const n of Object.values(player.nodes)) { try { n.src.onended = null; n.src.stop(); } catch { /* already stopped */ } n.src.disconnect(); }
      player.nodes = null;
      player.offset = keepPosition ? pos : 0;
    } else if (!keepPosition) player.offset = 0;
    player.playing = false;
    setPlayIcon();
  }
  const pause = () => stopPlayback(true);
  const toggle = () => (player.playing ? pause() : play());

  function placeModePill() {
    const b = document.querySelector(`.modes button[data-mode="${player.mode}"]`), pill = document.querySelector(".mode-pill");
    if (!b || !pill || !b.offsetWidth) return;
    pill.style.setProperty("--x", `${b.offsetLeft}px`);
    pill.style.setProperty("--w", `${b.offsetWidth}px`);
  }

  function setMode(mode, fromBlend) {
    const changed = player.mode !== mode;
    player.mode = mode;
    if (!fromBlend && mode === "iso") player.blend = 1;
    if (!fromBlend && mode === "dst") player.blend = 0;
    renderBlend();
    document.querySelectorAll(".modes button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode ? "true" : "false"));
    placeModePill();
    const pb = $("playBtn");
    MODES.forEach((m) => pb.classList.toggle(m, m === mode && m !== "iso"));
    const note = $("modeNote");
    note.textContent = modeNote();
    if (changed) { note.classList.remove("flash"); void note.offsetWidth; note.classList.add("flash"); }
    applyGains();
    drawWave();
  }
  function modeNote() {
    if (player.mode === "src" || player.blend <= 0 || player.blend >= 1) return MODE_NOTE[player.mode];
    return `Twin with ${Math.round(player.blend * 100)}% of the flipped copy added. Slide right and the shared music cancels away, leaving the hidden part.`;
  }
  function renderBlend() {
    const row = $("blendRow"), r = $("blend"), b = player.blend;
    r.value = String(Math.round(b * 100));
    r.setAttribute("aria-valuetext", b >= 1 ? "Isolated" : b <= 0 ? "Twin" : `${Math.round(b * 100)}% isolated`);
    row.classList.toggle("off", player.mode === "src");
    row.classList.toggle("at-dst", player.mode !== "src" && b <= 0);
    row.classList.toggle("at-iso", player.mode !== "src" && b >= 1);
  }
  function setBlend(v) {
    player.blend = Math.max(0, Math.min(1, v));
    const mode = player.blend >= 0.5 ? "iso" : "dst";
    if (mode !== player.mode) setMode(mode, true);
    else { renderBlend(); $("modeNote").textContent = modeNote(); applyGains(); }
  }

  const STEREO_HINT = {
    full: "",
    center: "Center only: keeps what's panned to the middle, like most lead vocals and ad-libs, and drops stereo width and effects.",
    sides: "Sides only: keeps what differs between left and right, like reverb, stereo effects and hard-panned parts. Centered sounds disappear.",
    position: "Keeps only what sits at one spot between left and right. Each peak in the map is a sound; slide onto one, and narrow the focus to leave its neighbours out.",
  };
  function renderStereo() {
    const t = track(), mono = !!(t && audioCache.get(t.id) && audioCache.get(t.id).length < 2);
    document.querySelectorAll("#stereoRow .seg button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.part === (mono ? "full" : player.clean.stereo)));
      b.disabled = mono && b.dataset.part !== "full";
    });
    $("stereoHint").textContent = mono ? "This song is mono, so there's no center or sides to separate." : STEREO_HINT[player.clean.stereo];
    $("panPick").hidden = mono || player.clean.stereo !== "position";
    renderShapeOutputs();
  }

  // ------------------------------------------------- position and filter
  const focusWidth = (v) => 0.06 + 0.54 * (v / 100);
  const lowHz = (v) => (v <= 0 ? 0 : 20 * Math.pow(100, v / 100));          // off, 20 Hz .. 2 kHz
  const highHz = (v) => (v >= 100 ? 0 : 500 * Math.pow(40, v / 100));       // 500 Hz .. 20 kHz, off
  const fmtHz = (f) => (!f ? "Off" : f < 1000 ? `${Math.round(f)} Hz` : `${(f / 1000).toFixed(f < 10000 ? 1 : 0)} kHz`);
  const fmtPan = (x) => (Math.abs(x) < 0.03 ? "Center" : `${Math.round(Math.abs(x) * 100)}% ${x < 0 ? "left" : "right"}`);
  function renderShapeOutputs() {
    const c = player.clean;
    $("panOut").textContent = fmtPan(c.pan);
    $("panPos").setAttribute("aria-valuetext", fmtPan(c.pan));
    const fv = Number($("panFocus").value);
    $("panFocusOut").textContent = fv < 25 ? "Narrow" : fv < 60 ? "Medium" : "Wide";
    $("lowCutOut").textContent = fmtHz(c.low);
    $("highCutOut").textContent = fmtHz(c.high);
  }
  /** The pan map: how much sound sits at each position, with the kept slice highlighted. */
  function drawPanMap() {
    const cv = $("panCanvas");
    if ($("panPick").hidden) return;
    const { w, h, dpr } = sizeCanvas(cv), g = cv.getContext("2d");
    g.clearRect(0, 0, w, h);
    const map = player.base && player.base.panMap;
    const c = player.clean, xOf = (pan) => ((pan + 1) / 2) * w;
    // the kept slice
    const grad = g.createLinearGradient(xOf(c.pan - c.focus * 1.6), 0, xOf(c.pan + c.focus * 1.6), 0);
    grad.addColorStop(0, `rgba(${P.lilac},0)`); grad.addColorStop(0.5, `rgba(${P.lilac},0.22)`); grad.addColorStop(1, `rgba(${P.lilac},0)`);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = `rgba(${P.faint},0.6)`; g.fillRect(w / 2 - dpr / 2, 0, dpr, h);
    if (!map) return;
    let peak = 1e-20; for (const v of map) peak = Math.max(peak, v);
    const bw = w / map.length;
    for (let i = 0; i < map.length; i++) {
      const v = Math.sqrt(map[i] / peak), bh = Math.max(1, v * (h - 6 * dpr));
      const centre = -1 + ((i + 0.5) / map.length) * 2, d = (centre - c.pan) / Math.max(0.03, c.focus);
      const inSlice = Math.exp(-d * d);
      g.fillStyle = `rgba(${P.lilac},${0.25 + 0.65 * inSlice})`;
      g.fillRect(i * bw + dpr, h - bh, Math.max(1, bw - 2 * dpr), bh);
    }
  }
  /** Bound once: sliders preview as they move (outputs, map, spectrum shading) and rebuild when let go. */
  function bindShapeSliders() {
    const live = (id, key, map) => {
      $(id).addEventListener("input", (e) => { player.clean[key] = map(Number(e.target.value)); renderShapeOutputs(); drawPanMap(); drawSpectrum(false); });
      $(id).addEventListener("change", (e) => setClean(key, map(Number(e.target.value))));
    };
    live("panPos", "pan", (v) => v / 100);
    live("panFocus", "focus", focusWidth);
    live("lowCut", "low", lowHz);
    live("highCut", "high", highHz);
  }
  function renderCleanHint() {
    renderStereo();
    $("cleanHint").textContent = player.clean.noise
      ? `Noise reduction at ${Math.round(player.clean.amount * 100)}%. Higher removes more of the leftover music, but can also soften quiet parts of the hidden sound.` : "";
  }
  async function setClean(k, on) {
    player.clean[k] = on; saveClean();
    const p = result();
    if (!p) return;
    const wasPlaying = player.playing, pos = position();
    stopPlayback();
    await prepareBuffers();
    player.offset = Math.min(pos, player.duration);
    drawWave(); drawSpectrum(false);
    if (wasPlaying) play();
  }

  function seek(frac) {
    skipIntro();
    const wasPlaying = player.playing;
    stopPlayback();
    player.offset = Math.max(0, Math.min(1, frac)) * player.duration;
    if (wasPlaying) play(); else { drawWave(); drawClock(); }
  }

  async function nudge(d) {
    const p = result();
    if (!p) return;
    const wasPlaying = player.playing, pos = position();
    stopPlayback();
    player.nudge = d === 0 ? 0 : player.nudge + d;
    await prepareBuffers();
    player.offset = Math.min(pos, player.duration);
    drawWave();
    if (wasPlaying) play();
  }

  function setPlayIcon() {
    $("playBtn").setAttribute("aria-label", player.playing ? "Pause" : "Play");
    $("playBtn").classList.toggle("playing", player.playing);
    $("playIcon").innerHTML = player.playing
      ? '<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/>'
      : '<path d="M4 2.5v11l9-5.5z" fill="currentColor"/>';
  }

  function drawClock() {
    $("clock").textContent = `${fmtTime(position())} / ${fmtTime(player.duration)}`;
    const wr = $("waveWrap");
    wr.setAttribute("aria-valuenow", String(Math.round((position() / Math.max(player.duration, 1e-9)) * 100)));
  }

  let raf = 0;
  function tick() {
    cancelAnimationFrame(raf);
    const step = () => {
      drawWaveHead();
      drawClock();
      drawSpectrum(player.playing);
      if (player.playing) raf = requestAnimationFrame(step);
      else drawSpectrum(false);
    };
    raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------- waveform
  let waveBase = null; // offscreen render of the envelopes
  function sizeCanvas(c) {
    const r = c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, dpr };
  }
  function envelope(chs, cols) {
    const n = chs[0].length, mn = new Float32Array(cols), mx = new Float32Array(cols);
    for (let x = 0; x < cols; x++) {
      const a = Math.floor((x * n) / cols), b = Math.max(a + 1, Math.floor(((x + 1) * n) / cols));
      let lo = 0, hi = 0;
      for (const c of chs) for (let i = a; i < b && i < n; i += 1) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      mn[x] = lo; mx[x] = hi;
    }
    return { mn, mx };
  }
  function drawWave() {
    const c = $("waveCanvas");
    if (!player.iso || $("player").hidden) return;
    const { w, h } = sizeCanvas(c);
    const off = document.createElement("canvas"); off.width = w; off.height = h;
    const g = off.getContext("2d");
    const mid = h / 2;
    const cols = Math.min(w, 1600);
    const twin = envelope(player.mode === "src" ? player.src : player.dst, cols);
    const iso = envelope(player.iso, cols);
    let peak = 1e-6;
    for (let x = 0; x < cols; x++) peak = Math.max(peak, -twin.mn[x], twin.mx[x], -iso.mn[x], iso.mx[x]);
    const sc = (h * 0.46) / peak, bw = w / cols;
    g.fillStyle = player.mode === "src" ? `rgba(${P.amber},0.22)` : `rgba(${P.cyan},0.2)`;
    for (let x = 0; x < cols; x++) g.fillRect(x * bw, mid - twin.mx[x] * sc, Math.max(1, bw), Math.max(1, (twin.mx[x] - twin.mn[x]) * sc));
    const fg = g.createLinearGradient(0, mid - h * 0.46, 0, mid + h * 0.46);
    const [c0, c1] = [`rgba(${P.ink},0.95)`, `rgba(${P.lilac},0.4)`];
    fg.addColorStop(0, c0); fg.addColorStop(0.5, c1); fg.addColorStop(1, c0);
    g.globalAlpha = player.mode === "iso" ? 1 : 0.4;
    g.fillStyle = fg;
    for (let x = 0; x < cols; x++) g.fillRect(x * bw, mid - iso.mx[x] * sc, Math.max(1, bw - (bw > 2 ? 1 : 0)), Math.max(1, (iso.mx[x] - iso.mn[x]) * sc));
    g.globalAlpha = 1;
    waveBase = off;
    drawWaveHead();
    drawClock();
    drawSpectrum(player.playing);
  }

  // ------------------------------------------------ isolation sequence
  // When a result is picked, the player waveform acts out the technique with that result's
  // real audio: the twin appears, the copy slides onto it and flips over, and what doesn't
  // cancel grows out of the middle. Then the normal view takes over.
  const intro = { active: false, raf: 0, key: null };
  const INTRO_MS = 2300;
  const easeOut = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  const easeIO = (x) => { x = Math.max(0, Math.min(1, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  function stopIntro() { cancelAnimationFrame(intro.raf); intro.active = false; intro.key = null; }
  /** Cut the sequence short and show the normal waveform straight away (seeking, etc.). */
  function skipIntro() { if (!intro.active) return; stopIntro(); drawWave(); }
  function playIntro() {
    stopIntro();
    if (reduceMotion || !player.iso || $("player").hidden) { drawWave(); return; }
    const c = $("waveCanvas"), { w, h, dpr } = sizeCanvas(c);
    const cols = Math.max(60, Math.min(Math.floor(w / (3 * dpr)), 500));
    const twin = envelope(player.dst, cols), copy = envelope(player.src, cols), iso = envelope(player.iso, cols);
    let peak = 1e-6;
    for (let x = 0; x < cols; x++) peak = Math.max(peak, twin.mx[x], -twin.mn[x], copy.mx[x], -copy.mn[x]);
    Object.assign(intro, { active: true, key: player.key });
    const t0 = performance.now();
    const step = (now) => {
      if (intro.key !== player.key || !intro.active) { intro.active = false; return; }
      const u = Math.min(1, (now - t0) / INTRO_MS);
      drawIntroFrame(c, w, h, dpr, cols, twin, copy, iso, peak, u);
      if (u < 1) intro.raf = requestAnimationFrame(step);
      else { intro.active = false; drawWave(); }
    };
    intro.raf = requestAnimationFrame(step);
    drawClock();
  }
  function drawIntroFrame(c, w, h, dpr, cols, twin, copy, iso, peak, u) {
    const g = c.getContext("2d"), mid = h / 2, sc = (h * 0.46) / peak, bw = w / cols;
    g.clearRect(0, 0, w, h);
    const band = (env, scale, xOff, fill) => {
      g.fillStyle = fill;
      for (let x = 0; x < cols; x++) {
        const top = mid - env.mx[x] * sc * scale, bot = mid - env.mn[x] * sc * scale;
        g.fillRect(x * bw + xOff, Math.min(top, bot), Math.max(1, bw - dpr), Math.max(1, Math.abs(bot - top)));
      }
    };
    const grow = easeOut(u / 0.2);                          // twin appears
    const slide = easeIO((u - 0.12) / 0.3);                 // copy slides onto it
    const flip = Math.cos(Math.PI * easeIO((u - 0.46) / 0.18)); // copy turns upside down (+1 -> -1)
    const cancel = easeOut((u - 0.66) / 0.28);              // they cancel; the residue grows
    band(twin, grow, 0, `rgba(${P.cyan},${0.5 - 0.3 * cancel})`);
    if (u > 0.12 && cancel < 1) {
      const fadeIn = Math.min(1, (u - 0.12) / 0.08);
      band(copy, flip * (1 - cancel), (1 - slide) * w * 0.35, `rgba(${P.amber},${0.5 * fadeIn * (1 - cancel)})`);
    }
    if (cancel > 0) {
      const fg = g.createLinearGradient(0, mid - h * 0.46, 0, mid + h * 0.46);
      fg.addColorStop(0, `rgba(${P.ink},0.95)`); fg.addColorStop(0.5, `rgba(${P.lilac},0.45)`); fg.addColorStop(1, `rgba(${P.ink},0.95)`);
      band(iso, cancel, 0, fg);
      // the moment of cancellation: a flash along the centre line
      const flash = Math.max(0, 1 - Math.abs(cancel - 0.15) / 0.15);
      if (flash > 0) {
        const gl = g.createLinearGradient(0, mid - 14 * dpr, 0, mid + 14 * dpr);
        gl.addColorStop(0, `rgba(${P.lilac},0)`); gl.addColorStop(0.5, `rgba(${P.lilac},${0.55 * flash})`); gl.addColorStop(1, `rgba(${P.lilac},0)`);
        g.fillStyle = gl; g.fillRect(0, mid - 14 * dpr, w, 28 * dpr);
      }
    }
    // caption
    const steps = [[0, "the twin"], [0.12, "+ the copy, lined up"], [0.46, "phase flipped"], [0.66, "= what doesn't cancel"]];
    let cap = steps[0], ci = 0;
    steps.forEach((s, i) => { if (u >= s[0]) { cap = s; ci = i; } });
    const next = steps[ci + 1] ? steps[ci + 1][0] : 1.2;
    const a = Math.min(1, (u - cap[0]) / 0.05, (next - u) / 0.05 + 0.15);
    g.font = `500 ${11 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`;
    g.textBaseline = "top";
    g.fillStyle = `rgba(${[P.cyan, P.amber, P.amber, P.lilac][ci]},${Math.max(0, a)})`;
    g.fillText(cap[1], 10 * dpr, 9 * dpr);
  }

  // ------------------------------------------------------------- spectrum
  // Twin vs isolated across frequency: the gap between them is what cancelled. Static (averaged
  // over the section) when paused; live from the playing audio otherwise.
  const SPEC_N = 4096;
  function staticSpectrum(dst, iso, sr) {
    const n = dst[0].length;
    if (n < SPEC_N) return null;
    const fft = E.rfftFor(SPEC_N), H = SPEC_N / 2 + 1;
    const win = new Float64Array(SPEC_N);
    let wsum = 0;
    for (let i = 0; i < SPEC_N; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEC_N); wsum += win[i]; }
    const buf = new Float64Array(SPEC_N), re = new Float64Array(H), im = new Float64Array(H);
    const acc = (chs) => {
      const pw = new Float64Array(H), frames = Math.min(48, Math.floor(n / SPEC_N));
      for (let f = 0; f < frames; f++) {
        const off = Math.floor(((n - SPEC_N) * f) / Math.max(1, frames - 1));
        for (let i = 0; i < SPEC_N; i++) { let v = 0; for (const c of chs) v += c[off + i]; buf[i] = (v / chs.length) * win[i]; }
        fft.forward(buf, re, im);
        for (let k = 0; k < H; k++) pw[k] += (re[k] * re[k] + im[k] * im[k]) / frames;
      }
      const db = new Float32Array(H);
      for (let k = 0; k < H; k++) db[k] = 10 * Math.log10(pw[k] * Math.pow(2 / wsum, 2) + 1e-14);
      return db;
    };
    return { twin: acc(dst), iso: acc(iso), sr };
  }
  const specRange = { top: -20 };
  const liveBufs = {};
  function drawSpectrum(live) {
    const c = $("specCanvas");
    if (!c || $("player").hidden) return;
    const p = result();
    let twin, iso, sr = p ? p.sr : 44100;
    if (live && player.nodes && player.nodes.dst && player.nodes.dst.an) {
      for (const m of ["dst", "iso"]) {
        const an = player.nodes[m].an;
        if (!liveBufs[m] || liveBufs[m].length !== an.frequencyBinCount) liveBufs[m] = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(liveBufs[m]);
      }
      twin = liveBufs.dst; iso = liveBufs.iso; sr = player.ctx.sampleRate;
    } else if (player.spec) { twin = player.spec.twin; iso = player.spec.iso; }
    const { w, h, dpr } = sizeCanvas(c), g = c.getContext("2d");
    g.clearRect(0, 0, w, h);
    if (!twin) return;
    const H = twin.length, nyq = sr / 2, f0 = 30, f1 = Math.min(20000, nyq);
    const NB = Math.max(40, Math.floor(w / (3 * dpr)));
    const tw = new Float32Array(NB), is = new Float32Array(NB);
    let maxDb = -200, eT = 0, eI = 0;
    for (let b = 0; b < NB; b++) {
      const lo = f0 * Math.pow(f1 / f0, b / NB), hi = f0 * Math.pow(f1 / f0, (b + 1) / NB);
      const k0 = Math.max(1, Math.floor((lo / nyq) * (H - 1))), k1 = Math.max(k0 + 1, Math.ceil((hi / nyq) * (H - 1)));
      let pt = 0, pi = 0, cnt = 0;
      for (let k = k0; k < k1 && k < H; k++) { pt += Math.pow(10, twin[k] / 10); pi += Math.pow(10, iso[k] / 10); cnt++; }
      eT += pt; eI += pi;
      tw[b] = 10 * Math.log10(pt / Math.max(1, cnt) + 1e-14); is[b] = 10 * Math.log10(pi / Math.max(1, cnt) + 1e-14);
      if (tw[b] > maxDb) maxDb = tw[b];
    }
    // the vertical range follows the music smoothly, 72 dB deep
    specRange.top = maxDb < -150 ? specRange.top : specRange.top + (maxDb + 4 - specRange.top) * (live ? 0.08 : 1);
    const top = specRange.top, span = 72, pad = 4 * dpr;
    const xOf = (b) => (b / (NB - 1)) * w, yOf = (db) => pad + Math.max(0, Math.min(1, (top - db) / span)) * (h - 2 * pad);
    const area = (arr, fill, stroke) => {
      g.beginPath(); g.moveTo(0, h);
      for (let b = 0; b < NB; b++) g.lineTo(xOf(b), yOf(arr[b]));
      g.lineTo(w, h); g.closePath();
      g.fillStyle = fill; g.fill();
      g.beginPath();
      for (let b = 0; b < NB; b++) b ? g.lineTo(xOf(b), yOf(arr[b])) : g.moveTo(0, yOf(arr[b]));
      g.strokeStyle = stroke; g.lineWidth = 1.4 * dpr; g.stroke();
    };
    // the cancelled band: between the twin and the isolated curves
    g.beginPath();
    for (let b = 0; b < NB; b++) b ? g.lineTo(xOf(b), yOf(tw[b])) : g.moveTo(0, yOf(tw[b]));
    for (let b = NB - 1; b >= 0; b--) g.lineTo(xOf(b), yOf(Math.min(is[b], tw[b])));
    g.closePath();
    const band = g.createLinearGradient(0, 0, w, 0);
    band.addColorStop(0, `rgba(${P.amber},0.22)`); band.addColorStop(1, `rgba(${P.cyan},0.22)`);
    g.fillStyle = band; g.fill();
    g.beginPath();
    for (let b = 0; b < NB; b++) b ? g.lineTo(xOf(b), yOf(tw[b])) : g.moveTo(0, yOf(tw[b]));
    g.strokeStyle = `rgba(${P.cyan},0.9)`; g.lineWidth = 1.4 * dpr; g.stroke();
    area(is, `rgba(${P.lilac},0.28)`, `rgba(${P.lilac},0.95)`);
    // frequency ticks
    g.fillStyle = `rgba(${P.faint},0.9)`; g.font = `${9.5 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`; g.textBaseline = "bottom";
    for (const [f, lab] of [[100, "100"], [1000, "1k"], [10000, "10k"]]) {
      if (f >= f1) continue;
      const x = (Math.log(f / f0) / Math.log(f1 / f0)) * w;
      g.fillRect(x, h - 4 * dpr, dpr, 4 * dpr); g.fillText(lab, x + 3 * dpr, h - 1 * dpr);
    }
    // shade what the filter removes
    for (const [lo, hi] of [[f0, player.clean.low], [player.clean.high, f1]]) {
      if (!(lo > 0) || !(hi > lo) || (hi === f1 && !player.clean.high) || (lo === f0 && !player.clean.low)) continue;
      const xa = Math.max(0, (Math.log(Math.max(lo, f0) / f0) / Math.log(f1 / f0)) * w), xb = Math.min(w, (Math.log(Math.min(hi, f1) / f0) / Math.log(f1 / f0)) * w);
      if (xb <= xa) continue;
      g.fillStyle = `rgba(${P.bg},0.6)`; g.fillRect(xa, 0, xb - xa, h);
      g.fillStyle = `rgba(${P.amber},0.8)`; g.fillRect(lo === f0 ? xb - dpr : xa, 0, dpr, h);
    }
    const db = eI > 0 && eT > 1e-12 ? 10 * Math.log10(eT / eI) : null;
    $("specDb").textContent = db === null || !Number.isFinite(db) ? "" : `${live ? "cancelling" : "average"} ${db.toFixed(1)} dB${live ? " now" : ""}`;
  }
  function drawWaveHead() {
    const c = $("waveCanvas");
    if (!waveBase || intro.active) return;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(waveBase, 0, 0, c.width, c.height);
    const x = (position() / Math.max(player.duration, 1e-9)) * c.width;
    // played part dimmed, glowing playhead
    g.fillStyle = `rgba(${P.bg},0.5)`;
    g.fillRect(0, 0, x, c.height);
    const glow = g.createLinearGradient(x - 40, 0, x, 0);
    glow.addColorStop(0, `rgba(${P.lilac},0)`); glow.addColorStop(1, `rgba(${P.lilac},0.12)`);
    g.fillStyle = glow; g.fillRect(Math.max(0, x - 40), 0, Math.min(40, x), c.height);
    g.fillStyle = `rgb(${P.ink})`;
    g.fillRect(Math.round(x) - 1, 0, 2, c.height);
    if (player.crop) {
      const d = Math.max(player.duration, 1e-9), xa = (player.crop[0] / d) * c.width, xb = (player.crop[1] / d) * c.width;
      g.fillStyle = `rgba(${P.bg},0.62)`;
      g.fillRect(0, 0, xa, c.height); g.fillRect(xb, 0, c.width - xb, c.height);
    }
    scope.playhead = player.playing || player.offset > 0 ? position() : null;
  }

  // ---------------------------------------------------------------- export
  const WHAT_LABEL = { iso: "isolated", invSong: "song without it" };
  let exporting = false;
  function setDownloadBusy(text) {
    const b = $("download");
    b.disabled = !!text; b.classList.toggle("working", !!text);
    $("downloadLabel").textContent = text || "Download";
  }

  /**
   * Channels for an export target. "Song without this sound" is the whole track with the twin
   * section replaced by twin + the phase-inverted isolation (which takes the sound back out).
   */
  async function exportChannels(what) {
    if (!player.iso) await prepareBuffers();
    if (what === "iso") return player.iso;
    const ch = await ensureAudio(track());
    const [s0, s1] = player.span;
    return ch.map((c, k) => {
      const o = new Float32Array(c), iso = player.iso[k];
      for (let i = s0; i < s1; i++) o[i] = c[i] - iso[i - s0];
      return o;
    });
  }

  function shapeLabel() {
    const c = player.clean, parts = [];
    if (player.iso && player.iso.length > 1) {
      if (c.stereo === "center" || c.stereo === "sides") parts.push(c.stereo);
      if (c.stereo === "position") parts.push(`at ${fmtPan(c.pan)}`);
    }
    const hz = (f) => fmtHz(f).replace(" ", "");
    if (c.low && c.high) parts.push(`${hz(c.low)}-${hz(c.high)}`);
    else if (c.low) parts.push(`above ${hz(c.low)}`);
    else if (c.high) parts.push(`below ${hz(c.high)}`);
    return parts.length ? ` ${parts.join(" ")}` : "";
  }
  /** Cut section-relative [a, b] seconds out, with 3 ms fades so the cut edges don't click. */
  function cropChannels(chs, [a, b], sr) {
    const i0 = Math.max(0, Math.round(a * sr)), i1 = Math.min(chs[0].length, Math.round(b * sr));
    const fade = Math.min(Math.round(sr * 0.003), (i1 - i0) >> 2);
    return chs.map((c) => {
      const o = c.slice(i0, i1), n = o.length;
      for (let i = 0; i < fade; i++) { const k = i / fade; o[i] *= k; o[n - 1 - i] *= k; }
      return o;
    });
  }
  const fileTime = (s) => fmtTime(s, 1).replace(":", "m") + "s";
  function cropLabel([a, b], p) { const base = player.span[0] / p.sr; return `${fileTime(base + a)}-${fileTime(base + b)}`; }

  async function download() {
    const t = track(), p = result();
    if (!p || exporting) return;
    exporting = true;
    const what = $("exportWhat").value;
    let fmt = $("exportFormat").value;
    try {
      setDownloadBusy("Preparing…");
      await new Promise((r) => setTimeout(r, 20));
      let chs = await exportChannels(what);
      const crop = what === "iso" && player.crop ? player.crop : null;
      if (crop) chs = cropChannels(chs, crop, p.sr);
      let out;
      if (fmt === "mp3") {
        try {
          out = await Isol8Export.encodeMp3(chs, p.sr, (f) => setDownloadBusy(`Encoding ${Math.round(f * 100)}%`));
        } catch (err) {
          if (!err.unavailable) throw err;
          toast("The MP3 encoder isn't installed in this copy of isol8, so this was saved as a 32-bit WAV instead.", "warn");
          fmt = "f32";
        }
      }
      if (!out) out = Isol8Export.encodeWav(chs, p.sr, fmt);
      const ext = fmt === "mp3" ? "mp3" : "wav";
      const where = `${fmtTime(p.srcStart / p.sr, 0).replace(":", "m")}s to ${fmtTime(p.dstStart / p.sr, 0).replace(":", "m")}s`;
      const name = `isol8.it - ${baseName(t.name)} - #${p.rank} ${WHAT_LABEL[what]} (${where})${player.nudge ? ` nudged ${player.nudge > 0 ? "+" : ""}${player.nudge}` : ""}${player.clean.noise ? " denoised" : ""}${shapeLabel()}${crop ? ` cropped ${cropLabel(crop, p)}` : ""}.${ext}`;
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const notes = [];
      if (out.resampled) notes.push(`MP3 can't hold ${(p.sr / 1000).toFixed(1)} kHz, so the file is ${(out.sampleRate / 1000).toFixed(1)} kHz`);
      if (out.gainDb < -0.01) notes.push(`turned down by ${(-out.gainDb).toFixed(1)} dB so the peaks don't clip${fmt === "mp3" ? "" : `. Choose 32-bit float WAV to keep the exact level`}`);
      if (notes.length) toast(`Saved. ${notes.join("; ").replace(/^./, (c) => c.toUpperCase())}.`);
      else if (fmt !== "f32" || $("exportFormat").value === "f32") toast("Saved.");
      noteUse("exports");
    } catch (err) {
      console.error(err);
      toast("Couldn't export this result.", "error");
    } finally {
      exporting = false;
      setDownloadBusy("");
    }
  }

  // ------------------------------------------------------- scope (canvas)
  const scope = { mode: "idle", playhead: null, hover: null, arcs: [], celebrateAt: 0, sleeping: false, loading: false, pulseAt: 0, pulseId: null, pulsing: false };
  let mapCache = null;

  function celebrate() { scope.celebrateAt = performance.now(); }

  function wavePair(x, t) {
    // a little "song": three partials, slowly evolving
    return 0.55 * Math.sin(x * 0.021 + t * 1.3) + 0.3 * Math.sin(x * 0.053 - t * 0.7) + 0.18 * Math.sin(x * 0.11 + t * 2.1);
  }

  function drawGraticule(g, w, h, dpr) {
    g.strokeStyle = `rgba(${P.ink},0.035)`;
    g.lineWidth = 1;
    const step = 48 * dpr;
    g.beginPath();
    for (let x = (w % step) / 2; x < w; x += step) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, h); }
    for (let y = (h / 2) % step; y < h; y += step) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(w, Math.round(y) + 0.5); }
    g.stroke();
  }

  // Where the idle waves sit relative to the hero copy. CSS sets --hero-stacked when the copy
  // moves under the waves; otherwise the waves start just past the copy's measured right edge,
  // so they never run under the text however wide the panel is. Cached per canvas width.
  let heroLayout = null;
  function heroWaveLayout(w, dpr) {
    if (heroLayout && heroLayout.w === w) return heroLayout;
    const sc = $("scope");
    const stacked = getComputedStyle(sc).getPropertyValue("--hero-stacked").trim() === "1";
    let x0 = w * 0.48;
    if (!stacked) {
      const left = sc.getBoundingClientRect().left, r = document.createRange();
      let right = 0;
      for (const el of $("dropPrompt").querySelectorAll("h1, .lede, .cta, .fmt, #settingsToggle")) {
        r.selectNodeContents(el);
        right = Math.max(right, r.getBoundingClientRect().right - left);
      }
      if (right > 0) x0 = Math.max(x0, (right + 48) * dpr);
    }
    return (heroLayout = { w, stacked, x0 });
  }

  function drawInterference(g, w, h, dpr, now) {
    const t = reduceMotion ? 1.2 : now / 1000;
    const tr = track();
    // misalignment: idle drifts in and out of phase; busy closes as the analysis progresses
    let mis;
    if (scope.mode === "busy" && tr) mis = (1 - Math.min(1, tr.progress)) * 26 + 2;
    else mis = reduceMotion ? 14 : 14 + 13 * Math.sin(t * 0.45);
    const idle = scope.mode !== "busy", hero = idle ? heroWaveLayout(w, dpr) : null;
    const narrow = idle && hero.stacked;
    // stacked: the copy sits at the bottom, so the waves stay in the top band
    const mid = h * (idle ? (narrow ? 0.11 : 0.5) : 0.4), amp = h * (idle && narrow ? 0.06 : 0.2);
    const x0 = idle && !narrow ? hero.x0 : 0;
    const lines = [
      { col: `rgba(${P.amber},0.9)`, f: (x) => wavePair(x / dpr, t), y: mid - amp * 0.05 },
      { col: `rgba(${P.cyan},0.9)`, f: (x) => -wavePair(x / dpr + mis, t), y: mid + amp * 0.05 },
    ];
    g.lineWidth = 2 * dpr;
    g.shadowBlur = 14 * dpr;
    for (const L of lines) {
      g.strokeStyle = L.col; g.shadowColor = L.col;
      g.beginPath();
      for (let x = x0; x <= w; x += 3 * dpr) {
        const fade = Math.min(1, (x - x0) / (120 * dpr));
        const y = L.y + L.f(x) * amp * fade;
        x === x0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    // residue: what the two leave behind when summed
    g.strokeStyle = `rgba(${P.lilac},0.95)`; g.shadowColor = `rgba(${P.lilac},0.9)`;
    g.lineWidth = 1.6 * dpr;
    g.beginPath();
    const ry = idle ? (narrow ? h * 0.24 : h * 0.82) : h * 0.68;
    for (let x = x0; x <= w; x += 3 * dpr) {
      const fade = Math.min(1, (x - x0) / (120 * dpr));
      const y = ry + (wavePair(x / dpr, t) - wavePair(x / dpr + mis, t)) * amp * 0.9 * fade;
      x === x0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;
  }

  function buildMap(w, h, dpr) {
    const t = track();
    const ch = audioCache.get(t.id);
    if (!ch) return null;
    const cols = Math.floor(w / (2 * dpr));
    const env = envelope(ch, cols);
    return { w, h, cols, env, id: t.id, sr: t.sr, len: t.length };
  }

  function drawMap(g, w, h, dpr, now) {
    const t = track();
    if (!mapCache || mapCache.w !== w || mapCache.h !== h || mapCache.id !== t.id) mapCache = buildMap(w, h, dpr);
    if (!mapCache) return;
    const { cols, env, len } = mapCache;
    const metaH = $("trackMeta").offsetHeight || 30;
    const top = (metaH + 46) * dpr, base = h - 40 * dpr;          // arcs live between the title and the waveform
    const waveH = Math.min(70 * dpr, (base - top) * 0.42), mid = base - waveH;
    const xOf = (s) => (s / len) * w;
    const results = t.results;                         // every twin, not just the ones listed
    const sel = result();
    const hov = scope.hover && scope.hover !== state.selected ? results.find((r) => r.id === scope.hover) : null;
    scope.geo = { len, w, mid, waveH, dpr };
    scope.pulsing = false;
    // spans of the selected (and hovered) pair
    const drawSpan = (a, b, col) => { g.fillStyle = col; g.fillRect(xOf(a), mid - waveH, Math.max(1, xOf(b) - xOf(a)), waveH * 2); };
    if (hov) { drawSpan(hov.srcStart, hov.srcEnd, `rgba(${P.amber},0.08)`); drawSpan(hov.dstStart, hov.dstEnd, `rgba(${P.cyan},0.08)`); }
    if (sel) { drawSpan(sel.srcStart, sel.srcEnd, `rgba(${P.amber},0.13)`); drawSpan(sel.dstStart, sel.dstEnd, `rgba(${P.cyan},0.13)`); }
    // envelope
    let peak = 1e-6;
    for (let i = 0; i < cols; i++) peak = Math.max(peak, env.mx[i], -env.mn[i]);
    const bw = w / cols;
    for (let i = 0; i < cols; i++) {
      const s = (i / cols) * len;
      let col = `rgba(${P.muted},0.3)`;
      if (sel && s >= sel.srcStart && s < sel.srcEnd) col = `rgba(${P.amber},0.85)`;
      else if (sel && s >= sel.dstStart && s < sel.dstEnd) col = `rgba(${P.cyan},0.85)`;
      else if (hov && s >= hov.srcStart && s < hov.srcEnd) col = `rgba(${P.amber},0.5)`;
      else if (hov && s >= hov.dstStart && s < hov.dstEnd) col = `rgba(${P.cyan},0.5)`;
      g.fillStyle = col;
      const y0 = mid - (env.mx[i] / peak) * waveH, y1 = mid - (env.mn[i] / peak) * waveH;
      g.fillRect(i * bw, y0, Math.max(1, bw - 1 * dpr), Math.max(1, y1 - y0));
    }
    // time axis
    g.fillStyle = `rgba(${P.faint},0.95)`;
    g.font = `${10.5 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`;
    g.textBaseline = "top";
    const dur = len / t.sr, stepS = dur > 400 ? 60 : dur > 150 ? 30 : 15;
    for (let s = 0; s <= dur; s += stepS) {
      const x = (s / dur) * w;
      g.fillRect(x, base + 8 * dpr, 1, 5 * dpr);
      if (x < w - 30 * dpr) g.fillText(fmtTime(s, 0), x + 4 * dpr, base + 8 * dpr);
    }
    // arcs (draw in to the full height on reveal)
    const reveal = reduceMotion ? 1 : Math.min(1, (now - scope.celebrateAt) / 900);
    const ease = 1 - Math.pow(1 - reveal, 3);
    scope.arcs = [];
    const order = results.slice().sort((a, b) => (a.id === state.selected) - (b.id === state.selected) || (a.id === scope.hover) - (b.id === scope.hover));
    const maxH = mid - waveH - top + 8 * dpr;
    for (const p of order) {
      const x1 = xOf((p.srcStart + p.srcEnd) / 2), x2 = xOf((p.dstStart + p.dstEnd) / 2);
      const span = Math.abs(x2 - x1);
      const ah = Math.min(maxH, span * 0.55 + 18 * dpr) * ease;
      const y = mid - waveH - 4 * dpr;
      const isSel = p.id === state.selected, isHov = p.id === scope.hover;
      const grad = g.createLinearGradient(x1, 0, x2, 0);
      const alpha = isSel ? 1 : isHov ? 0.8 : results.length > VISIBLE ? 0.2 : 0.32;
      grad.addColorStop(0, `rgba(${P.amber},${alpha})`);
      grad.addColorStop(1, `rgba(${P.cyan},${alpha})`);
      g.strokeStyle = grad;
      g.lineWidth = (isSel ? 2.4 : 1.4) * dpr;
      if (isSel) { g.shadowBlur = 12 * dpr; g.shadowColor = `rgba(${P.lilac},0.5)`; }
      g.beginPath();
      g.moveTo(x1, y);
      g.bezierCurveTo(x1, y - ah * 1.33, x2, y - ah * 1.33, x2, y);
      g.stroke();
      g.shadowBlur = 0;
      const pts = [];
      for (let i = 0; i <= 32; i++) {
        const u = i / 32, v = 1 - u;
        pts.push([v * v * v * x1 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x2,
          v * v * v * y + 3 * v * v * u * (y - ah * 1.33) + 3 * v * u * u * (y - ah * 1.33) + u * u * u * y]);
      }
      scope.arcs.push({ id: p.id, pts });
      // selection pulse: a spark travels from the copy to its twin along the arc
      if (isSel && scope.pulseId === p.id && !reduceMotion) {
        const k = (now - scope.pulseAt) / 1100;
        if (k >= 0 && k < 1.35) {
          scope.pulsing = true;
          const e = easeIO(Math.min(1, k)), fi = e * 32, i0 = Math.floor(fi), i1 = Math.min(32, i0 + 1), fr = fi - i0;
          const at = (j) => [pts[j][0], pts[j][1]];
          const px = at(i0)[0] + (at(i1)[0] - at(i0)[0]) * fr, py = at(i0)[1] + (at(i1)[1] - at(i0)[1]) * fr;
          const fade = k < 1 ? 1 : 1 - (k - 1) / 0.35;
          for (let tr = 6; tr >= 1; tr--) {                 // trail
            const j = Math.max(0, fi - tr * 0.9), j0 = Math.floor(j), j1 = Math.min(32, j0 + 1), f2 = j - j0;
            const tx = pts[j0][0] + (pts[j1][0] - pts[j0][0]) * f2, ty = pts[j0][1] + (pts[j1][1] - pts[j0][1]) * f2;
            g.fillStyle = `rgba(${P.lilac},${0.12 * (7 - tr) / 6 * fade})`;
            g.beginPath(); g.arc(tx, ty, (2 + (7 - tr) * 0.5) * dpr, 0, Math.PI * 2); g.fill();
          }
          const glow = g.createRadialGradient(px, py, 0, px, py, 14 * dpr);
          glow.addColorStop(0, `rgba(${P.lilac},${0.95 * fade})`); glow.addColorStop(1, `rgba(${P.lilac},0)`);
          g.fillStyle = glow; g.beginPath(); g.arc(px, py, 14 * dpr, 0, Math.PI * 2); g.fill();
          if (k > 0.9) {                                    // arrival: the twin lights up
            const a = Math.max(0, 1 - (k - 0.9) / 0.45) * 0.25;
            g.fillStyle = `rgba(${P.cyan},${a})`;
            g.fillRect(xOf(p.dstStart), mid - waveH, Math.max(1, xOf(p.dstEnd) - xOf(p.dstStart)), waveH * 2);
          }
        }
      }
      if (isSel || isHov) {
        g.fillStyle = isSel ? `rgb(${P.lilac})` : `rgba(${P.lilac},0.8)`;
        g.font = `600 ${12 * dpr}px system-ui, sans-serif`;
        g.textBaseline = "bottom";
        g.textAlign = "center";
        g.fillText(`#${p.rank}`, (x1 + x2) / 2, y - ah - 4 * dpr);
        g.textAlign = "left";
      }
      // end markers
      g.fillStyle = `rgba(${P.amber},${alpha})`; g.beginPath(); g.arc(x1, y, (isSel ? 3.2 : 2.2) * dpr, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgba(${P.cyan},${alpha})`; g.beginPath(); g.arc(x2, y, (isSel ? 3.2 : 2.2) * dpr, 0, Math.PI * 2); g.fill();
    }
    // playhead in the song timeline
    if (sel && scope.playhead !== null) {
      const x = xOf(Math.max(sel.dstStart, sel.lag) + scope.playhead * sel.sr);
      g.fillStyle = `rgb(${P.lilac})`;
      g.fillRect(x - 1 * dpr, mid - waveH - 2 * dpr, 2 * dpr, waveH * 2 + 4 * dpr);
    }
    return reveal < 1 || scope.pulsing;
  }

  function scopeLoop(now) {
    const c = $("scopeCanvas");
    const { w, h, dpr } = sizeCanvas(c);
    const g = c.getContext("2d");
    g.clearRect(0, 0, w, h);
    drawGraticule(g, w, h, dpr);
    const tr = track();
    let animating = false;
    if (scope.mode === "map" && tr && tr.status === "done") {
      if (!audioCache.get(tr.id) && !scope.loading) {
        scope.loading = true;
        ensureAudio(tr).then(() => { scope.loading = false; mapCache = null; wakeScope(); }, () => { scope.loading = false; });
      }
      animating = drawMap(g, w, h, dpr, now) || player.playing;
    } else {
      drawInterference(g, w, h, dpr, now);
      animating = !reduceMotion || scope.mode === "busy";
    }
    if (animating) requestAnimationFrame(scopeLoop);
    else scope.sleeping = true;
  }
  function wakeScope() { if (scope.sleeping) { scope.sleeping = false; requestAnimationFrame(scopeLoop); } }

  // --------------------------------------------------- advanced settings
  const settings = Object.assign({}, E.DEFAULTS);
  const pctFmt = (v) => `${Math.round(v * 100)}%`;
  const SETTINGS = [
    { group: "Finding repeats", note: "The first pass compares the song with itself at every offset and keeps stretches that look alike." },
    { key: "simThr", label: "Similarity threshold", min: 0.5, max: 0.95, step: 0.01, fmt: (v) => v.toFixed(2),
      hint: "How alike two passages must look to become a candidate. Lower it if a repeat isn't found at all." },
    { key: "minLenS", label: "Minimum repeat length", min: 1, max: 20, step: 0.5, unit: "s",
      hint: "Shortest similar stretch the scan keeps. Lower it for short repeats like a single bar." },
    { key: "smoothS", label: "Similarity smoothing", min: 0.25, max: 6, step: 0.25, unit: "s",
      hint: "Averaging window along each repeat. Shorter catches brief repeats; longer rides over small dips." },
    { key: "minLagS", label: "Minimum distance between copies", min: 0.5, max: 30, step: 0.5, unit: "s",
      hint: "Copies closer together than this are ignored." },
    { key: "maxCandidates", label: "Candidates to check", min: 10, max: 300, step: 5,
      hint: "How many of the best-looking repeats get locked to the sample. Raise it if the debug panel says the limit was reached. Slower." },
    { group: "Measuring cancellation", note: "Each candidate is aligned to the exact sample, and isol8 measures where the copy actually cancels." },
    { key: "nullDb", label: "Cancellation depth", min: 3, max: 40, step: 1, unit: "dB",
      hint: "How far a frequency must drop to count as cancelled. Lower it for lossy files or bus-processed mixes." },
    { key: "fracThr", label: "Share that must cancel", min: 0.05, max: 0.8, step: 0.01, fmt: pctFmt,
      hint: "Share of a moment's energy that has to cancel for that moment to belong to a result." },
    { key: "minRegionS", label: "Minimum result length", min: 0.5, max: 15, step: 0.5, unit: "s",
      hint: "Cancelling stretches shorter than this are dropped." },
    { key: "gapS", label: "Bridge gaps up to", min: 0, max: 5, step: 0.25, unit: "s",
      hint: "Short dips inside a result are joined over instead of splitting it." },
    { key: "zoneThr", label: "Other-zone similarity", min: 0.4, max: 0.95, step: 0.01, fmt: (v) => v.toFixed(2),
      hint: "Once an offset is locked, other places that look this alike at the same offset are checked too." },
    { group: "Filtering results", note: "What's left is filtered, merged and ranked." },
    { key: "minDeep", label: "Minimum average cancellation", min: 0, max: 0.8, step: 0.01, fmt: pctFmt,
      hint: "Results whose average cancelling share is below this are hidden." },
    { key: "identicalSdrDb", label: "Duplicate strictness", min: 3, max: 40, step: 1, unit: "dB",
      hint: "Results that sound alike to within this many dB are merged. Raise it to keep near-duplicates." },
    { key: "maxResults", label: "Max results", min: 5, max: 300, step: 5,
      hint: "How many results are listed." },
  ];
  const fmtSetting = (d, v) => (d.fmt ? d.fmt(v) : `${+v.toFixed(2)}${d.unit ? ` ${d.unit}` : ""}`);
  const changedKeys = (o) => SETTINGS.filter((d) => d.key && o[d.key] !== E.DEFAULTS[d.key]).map((d) => d.key);

  function buildSettings() {
    const body = $("settingsBody");
    let group = null;
    for (const d of SETTINGS) {
      if (d.group) {
        group = document.createElement("fieldset"); group.className = "set-group";
        const lg = document.createElement("legend"); lg.textContent = d.group;
        const nt = document.createElement("p"); nt.className = "set-note"; nt.textContent = d.note;
        group.append(lg, nt); body.append(group); continue;
      }
      const row = document.createElement("div"); row.className = "set-row"; row.dataset.key = d.key;
      const id = `set-${d.key}`;
      const top = document.createElement("div"); top.className = "set-top";
      const lab = document.createElement("label"); lab.htmlFor = id; lab.textContent = d.label;
      const val = document.createElement("output"); val.className = "set-val"; val.htmlFor = id;
      const rst = document.createElement("button"); rst.type = "button"; rst.className = "set-reset"; rst.textContent = "Reset";
      rst.setAttribute("aria-label", `Reset ${d.label}`);
      top.append(lab, val, rst);
      const inp = document.createElement("input"); inp.type = "range"; inp.id = id;
      inp.min = d.min; inp.max = d.max; inp.step = d.step;
      const hint = document.createElement("p"); hint.className = "set-hint"; hint.textContent = `${d.hint} Default ${fmtSetting(d, E.DEFAULTS[d.key])}.`;
      row.append(top, inp, hint);
      inp.addEventListener("input", () => { settings[d.key] = Number(inp.value); syncSettings(); });
      rst.addEventListener("click", () => { settings[d.key] = E.DEFAULTS[d.key]; syncSettings(); });
      group.append(row);
    }
    syncSettings();
  }
  function syncSettings() {
    for (const d of SETTINGS) {
      if (!d.key) continue;
      const row = document.querySelector(`.set-row[data-key="${d.key}"]`), inp = row.querySelector("input");
      const v = settings[d.key];
      inp.value = v;
      inp.style.setProperty("--p", `${((v - d.min) / (d.max - d.min)) * 100}%`);
      row.querySelector(".set-val").textContent = fmtSetting(d, v);
      row.classList.toggle("changed", v !== E.DEFAULTS[d.key]);
    }
    const n = changedKeys(settings).length;
    $("settingsReset").disabled = n === 0;
    document.querySelectorAll(".changed-dot").forEach((e) => (e.hidden = n === 0));
    renderSettingsHead();
  }
  function renderSettingsHead() {
    const t = track();
    const canRe = !!t && (t.status === "done" || t.status === "error");
    $("reanalyse").hidden = !canRe;
    if (canRe) $("reanalyse").textContent = `Re-analyse ${baseName(t.name).length > 28 ? baseName(t.name).slice(0, 27) + "…" : baseName(t.name)}`;
    const n = changedKeys(settings).length;
    $("settingsSub").textContent = `${n ? `${n} changed from the defaults. ` : ""}Applies to songs you add from now on${canRe ? ", or re-analyse the current one" : ""}.`;
  }
  function toggleSettings(open) {
    const p = $("settings");
    const shown = !p.hidden && !p.classList.contains("closing");
    open = open === undefined ? !shown : open;
    clearTimeout(p._closeTimer);
    if (open) { p.classList.remove("closing"); p.hidden = false; }
    else if (shown) {
      // play the opening animation in reverse, then hide
      if (reduceMotion) p.hidden = true;
      else {
        p.classList.add("closing");
        const done = () => { clearTimeout(p._closeTimer); p.removeEventListener("animationend", onEnd); if (p.classList.contains("closing")) { p.classList.remove("closing"); p.hidden = true; } };
        const onEnd = (e) => { if (e.target === p) done(); };
        p.addEventListener("animationend", onEnd);
        p._closeTimer = setTimeout(done, 500);   // fallback if the animation never runs
      }
    }
    ["settingsToggle", "settingsBtn"].forEach((id) => $(id).setAttribute("aria-expanded", String(open)));
    if (open) p.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }
  async function reanalyse() {
    const t = track();
    if (!t || t.reopening || state.queue.some((j) => j.t === t) || t.status === "busy") return;
    stopPlayback(); pickStop();
    let buf;
    t.reopening = true;
    try { buf = await t.file.arrayBuffer(); } catch { toast("Couldn't reopen the file.", "error"); return; } finally { t.reopening = false; }
    Object.assign(t, { status: "queued", results: [], progress: 0, stageText: "Waiting", opt: Object.assign({}, settings), debug: null, probe: null });
    state.selected = null; player.key = null;
    state.queue.push({ t, buf });
    saveTrack(t);
    renderAll(); wakeScope(); pump();
  }

  // ------------------------------------------------------------ debug
  const probeCtx = new Map();   // track id -> engine context (features cached for probing)
  function parseTime(str) {
    const s = String(str).trim().replace(",", ".");
    if (!s) return NaN;
    const parts = s.split(":").map(Number);
    if (parts.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
    return parts.reduce((acc, x) => acc * 60 + x, 0);
  }
  function stepItem(n, label, warn) {
    const li = document.createElement("li");
    if (warn) li.className = "warn";
    const b = document.createElement("strong"); b.textContent = typeof n === "number" ? fmtInt(n) : n;
    const sp = document.createElement("span"); sp.textContent = label;
    li.append(b, sp);
    return li;
  }
  function renderDebug() {
    const t = track(), dbg = t && t.debug;
    $("debug").hidden = !dbg;
    if (!dbg) return;
    const st = dbg.stats, opt = dbg.opt;
    const capHit = dbg.cands.length >= opt.maxCandidates;
    const cut = st.cut.length;
    $("pipeline").replaceChildren(
      stepItem(dbg.raw, "similar stretches found by the scan"),
      stepItem(dbg.cands.length, capHit ? `candidates checked (limit of ${opt.maxCandidates} reached)` : "candidates checked", capHit),
      stepItem(st.found, "cancelling regions measured"),
      stepItem(st.afterFilter, `passed the filters (${st.rejected.length} hidden)`),
      stepItem(st.afterDedupe, `after joining pieces of the same pair (${st.afterFilter - st.afterDedupe - st.duplicates.length}) and merging sound-alikes (${st.duplicates.length})`),
      stepItem(t.results.length, cut ? `listed (${cut} cut by the limit)` : "listed", cut > 0),
    );
    const tips = [];
    if (capHit) tips.push(`The candidate limit was reached, so weaker repeats were never checked. Raise "Candidates to check".`);
    if (cut) tips.push(`${cut} result${cut === 1 ? " was" : "s were"} cut by "Max results".`);
    const changed = changedKeys(opt);
    tips.push(changed.length ? `Analysed with custom settings: ${changed.map((k) => { const d = SETTINGS.find((x) => x.key === k); return `${d.label} ${fmtSetting(d, opt[k])}`; }).join(", ")}.` : "Analysed with the default settings.");
    $("pipelineHint").textContent = tips.join(" ");
    $("debugSummary").textContent = `${st.rejected.length + st.duplicates.length + cut} hidden${capHit ? " · limit hit" : ""}`;
    renderHidden();
    renderProbe();
    requestAnimationFrame(drawPick);
  }

  function hiddenEntries(t) {
    const st = t.debug.stats, opt = t.debug.opt, out = [];
    for (const p of st.rejected) {
      const why = p.cancelDb <= 0 ? "doesn't cancel overall" : `average cancellation ${pctFmt(p.deep)} is below ${pctFmt(opt.minDeep)}`;
      out.push({ p, why });
    }
    for (const { pair, of } of st.duplicates) out.push({ p: pair, why: `sounds the same as ${of.rank ? `#${of.rank}` : "a listed result"}` });
    for (const p of st.cut) out.push({ p, why: "cut by Max results" });
    return out.filter(({ p }) => !t.results.some((r) => r.id === pairId(p)));
  }
  const pairId = (p) => `${p.lag}:${p.dstStart}`;
  function renderHidden() {
    const t = track(), list = $("hiddenList");
    const items = hiddenEntries(t);
    $("hiddenCount").textContent = items.length ? `${items.length}` : "";
    if (!items.length) { const li = document.createElement("li"); li.className = "none"; li.textContent = "Nothing was hidden."; list.replaceChildren(li); return; }
    list.replaceChildren(...items.slice(0, 60).map(({ p, why }) => {
      const li = document.createElement("li");
      const times = document.createElement("span"); times.className = "times";
      const a = document.createElement("span"); a.className = "t-src"; a.textContent = fmtTime(p.srcStart / p.sr);
      const b = document.createElement("span"); b.className = "t-dst"; b.textContent = fmtTime(p.dstStart / p.sr);
      const len = document.createElement("span"); len.className = "len"; len.textContent = `${((p.dstEnd - p.dstStart) / p.sr).toFixed(1)} s · ${fmtDb(p.cancelDb)} dB`;
      times.append(a, arrowSvg(), b, len);
      const w = document.createElement("span"); w.className = "why"; w.textContent = why;
      const add = document.createElement("button"); add.type = "button"; add.className = "btn ghost small"; add.textContent = "Add";
      add.setAttribute("aria-label", `Add ${fmtTime(p.srcStart / p.sr)} onto ${fmtTime(p.dstStart / p.sr)} to the results`);
      add.addEventListener("click", () => addManual(p));
      li.append(times, w, add);
      return li;
    }));
  }
  function addManual(p) {
    const t = track();
    const id = pairId(p);
    if (!t.results.some((r) => r.id === id)) {
      p.id = id; p.rank = t.results.length + 1; p.manual = true;
      t.results.push(p);
      saveTrack(t);
    }
    state.showAll = t.results.length > VISIBLE;
    mapCache = null;
    renderResults(); renderHidden(); renderProbe();
    selectResult(id, "play");
    wakeScope();
    document.querySelector(`.result[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    toast(`Added as #${t.results.find((r) => r.id === id).rank}.`);
  }

  async function runProbe(e) {
    e.preventDefault();
    const t = track();
    if (!t || t.status !== "done") return;
    const src = parseTime($("probeSrc").value), dst = parseTime($("probeDst").value);
    const len = Number($("probeLen").value) || 15, search = Number($("probeSearch").value) || 1;
    if (!Number.isFinite(src) || !Number.isFinite(dst)) { toast("Enter times like 1:23.4 or 83.4.", "warn"); return; }
    const btn = $("probeBtn");
    btn.disabled = true; btn.textContent = "Checking…";
    await new Promise((r) => setTimeout(r, 30));
    try {
      const ch = await ensureAudio(t);
      let ctx = probeCtx.get(t.id);
      if (!ctx || ctx.ch !== ch) { ctx = E.prepare(ch, t.sr, t.debug.opt); probeCtx.set(t.id, ctx); }
      const r = E.probePair(ctx, Math.round(src * t.sr), Math.round(dst * t.sr), Math.round(Math.min(120, Math.max(1, len)) * t.sr), Math.min(5, Math.max(0.05, search)));
      t.probe = r;
      renderProbe();
      drawPick();
    } catch (err) {
      t.probe = { error: String((err && err.message) || err) };
      renderProbe();
    } finally {
      btn.disabled = false; btn.textContent = "Check";
    }
  }

  /** Works out which stage would lose the probed pair, in plain words. */
  function probeVerdict(t, r) {
    const opt = t.debug.opt, out = [];
    const known = t.results.find((p) => Math.abs(p.lag - r.lag) <= 32 && Math.min(p.dstEnd, r.b) > Math.max(p.dstStart, r.a));
    if (known) out.push({ ok: true, text: `Already in the results as #${known.rank}.` });
    const off = r.lag - r.guess;
    if (Math.abs(off) > 0.9 * Number($("probeSearch").value || 1) * t.sr) out.push({ warn: true, text: `The best alignment landed near the edge of the search range (${(off / t.sr).toFixed(2)} s from your guess). Double-check the times or widen the search.` });
    if (r.cancelDb < 1 && !r.regions.length) {
      out.push({ bad: true, text: `These two spans don't cancel (${fmtDb(r.cancelDb)} dB at the best offset). They were probably played or recorded twice rather than copied, or one was processed differently.` });
      return out;
    }
    // stage 1: coarse scan
    if (r.sim.longestS < opt.minLenS) {
      const need = r.sim.max - 0.02;
      out.push({ bad: true, text: `The first scan can't see this repeat: similarity peaks at ${r.sim.max.toFixed(2)}, and only stays above ${opt.simThr.toFixed(2)} for ${r.sim.longestS.toFixed(1)} s (needs ${opt.minLenS} s).` +
        (need >= 0.5 ? ` Try "Similarity threshold" around ${need.toFixed(2)}` : " Similarity is very low here") + `${r.sim.longestS > 0.5 ? ` or "Minimum repeat length" ${Math.max(1, Math.floor(r.sim.longestS * 2) / 2)} s` : ""}.` });
    } else {
      const cand = t.debug.cands.some((c) => Math.abs(c.lag - r.lag) <= 3 * t.debug.hop && Math.min(c.b, r.b) > Math.max(c.a, r.a));
      if (!cand && !known) {
        if (t.debug.cands.length >= opt.maxCandidates) out.push({ bad: true, text: `The scan sees it (similarity ${r.sim.max.toFixed(2)} for ${r.sim.longestS.toFixed(1)} s), but it ranked below the ${opt.maxCandidates} candidates that were checked. Raise "Candidates to check".` });
        else out.push({ warn: true, text: `The scan sees it (similarity ${r.sim.max.toFixed(2)}), but it was folded into a stronger nearby candidate. Its regions are measured below.` });
      } else if (!known) out.push({ ok: true, text: `The scan picked it up as a candidate (similarity ${r.sim.max.toFixed(2)}).` });
    }
    // stage 2: cancellation regions
    const maxFrac = r.profile.frac.reduce((m, v) => Math.max(m, v), 0);
    if (!r.regions.length) {
      out.push({ bad: true, text: `No stretch cancels enough to become a result: at most ${pctFmt(maxFrac)} of the energy cancels by ${opt.nullDb} dB (needs ${pctFmt(opt.fracThr)} for ${opt.minRegionS} s). Try lowering "Share that must cancel" or "Cancellation depth".` });
    } else {
      for (const p of r.regions) {
        const where = `${fmtTime(p.dstStart / t.sr)}–${fmtTime(p.dstEnd / t.sr)} (${p.lengthS.toFixed(1)} s)`;
        if (p.cancelDb <= 0 || p.deep < opt.minDeep) out.push({ bad: true, text: `Region ${where} is hidden by "Minimum average cancellation": it averages ${pctFmt(p.deep)}, below ${pctFmt(opt.minDeep)}.` });
        else if (!known) {
          const dup = t.debug.stats.duplicates.find((d) => Math.abs(d.pair.lag - p.lag) <= 32);
          if (dup) out.push({ bad: true, text: `Region ${where} was merged as a duplicate: it sounds the same as #${dup.of.rank}. Raise "Duplicate strictness" to keep both.` });
          else if (t.debug.stats.cut.some((c) => Math.abs(c.lag - p.lag) <= 32)) out.push({ bad: true, text: `Region ${where} was cut by "Max results".` });
          else out.push({ ok: true, text: `Region ${where} passes every filter with these settings (${fmtDb(p.cancelDb)} dB, ${pctFmt(p.deep)} average).` });
        }
      }
    }
    return out;
  }

  function renderProbe() {
    const t = track(), box = $("probeOut"), r = t && t.probe;
    if (t && box.dataset.track !== t.id) {
      box.dataset.track = t.id;
      const pk = pickOf(t);
      $("probeSrc").value = pk.src ? fmtTime(pk.src.s) : ""; $("probeDst").value = pk.dst ? fmtTime(pk.dst.s) : "";
      $("probeLen").value = pk.src ? (pk.src.e - pk.src.s).toFixed(1) : "15";
      $("pickPlaySrc").disabled = !pk.src; $("pickPlayDst").disabled = !pk.dst;
      pick.cursor = 0; pick.env = null;
      setPickMode(pk.src && !pk.dst ? "dst" : "listen");
    }
    box.hidden = !r;
    if (!r) return;
    if (r.error) { box.replaceChildren(Object.assign(document.createElement("p"), { className: "verdict bad", textContent: r.error })); return; }
    const verdicts = probeVerdict(t, r).map((v) => {
      const p = document.createElement("p"); p.className = `verdict ${v.ok ? "ok" : v.bad ? "bad" : "warn"}`; p.textContent = v.text; return p;
    });
    const grid = document.createElement("dl"); grid.className = "facts-grid probe-facts";
    const fact = (k, v, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; d.append(dt, dd); return d; };
    const off = r.lag - r.guess;
    grid.append(
      fact("Offset found", `${fmtInt(r.lag)}`),
      fact("From your guess", `${off >= 0 ? "+" : "−"}${fmtInt(Math.abs(off))} (${(off / t.sr).toFixed(3)} s)`),
      fact("Cancels by", `${fmtDb(r.cancelDb)} dB`),
      fact("Similarity", `${r.sim.max.toFixed(2)} max · ${r.sim.mean.toFixed(2)} avg`),
    );
    const cv = document.createElement("canvas"); cv.className = "probe-chart"; cv.setAttribute("aria-label", "Cancelling share and similarity across the checked span");
    const legend = document.createElement("p"); legend.className = "probe-legend";
    legend.innerHTML = '<span class="k lilac"></span>Share cancelling (smoothed) <span class="k cyan"></span>Scan similarity <span class="k dash"></span>Thresholds <span class="k mint"></span>Regions';
    const adds = document.createElement("div"); adds.className = "probe-adds";
    for (const p of r.regions) {
      const id = pairId(p), inList = t.results.some((x) => x.id === id);
      const b = document.createElement("button"); b.type = "button"; b.className = "btn small" + (inList ? " ghost" : "");
      b.textContent = inList ? `${fmtTime(p.dstStart / t.sr)}–${fmtTime(p.dstEnd / t.sr)} is listed` : `Add ${fmtTime(p.dstStart / t.sr)}–${fmtTime(p.dstEnd / t.sr)} to results`;
      b.disabled = inList;
      b.addEventListener("click", () => addManual(p));
      adds.append(b);
    }
    box.replaceChildren(...verdicts, grid, cv, legend, adds);
    requestAnimationFrame(() => drawProbe(cv, t, r));
  }

  function drawProbe(c, t, r) {
    const { w, h, dpr } = sizeCanvas(c), g = c.getContext("2d");
    g.clearRect(0, 0, w, h);
    const opt = r.opt, a = r.a, b = r.b, span = b - a;
    const xOf = (s) => ((s - a) / span) * w;
    const pad = 8 * dpr, yOf = (v) => h - pad - v * (h - 2 * pad);
    // regions
    for (const p of r.regions) { g.fillStyle = `rgba(${P.mint},0.1)`; g.fillRect(xOf(p.dstStart), 0, xOf(p.dstEnd) - xOf(p.dstStart), h); }
    // thresholds
    g.setLineDash([4 * dpr, 4 * dpr]); g.lineWidth = dpr;
    g.strokeStyle = `rgba(${P.lilac},0.45)`; g.beginPath(); g.moveTo(0, yOf(opt.fracThr)); g.lineTo(w, yOf(opt.fracThr)); g.stroke();
    g.strokeStyle = `rgba(${P.cyan},0.45)`; g.beginPath(); g.moveTo(0, yOf(opt.simThr)); g.lineTo(w, yOf(opt.simThr)); g.stroke();
    g.setLineDash([]);
    const plot = (vals, start, hop, col) => {
      g.strokeStyle = col; g.lineWidth = 1.6 * dpr; g.beginPath();
      vals.forEach((v, i) => { const x = xOf(start + (i + 0.5) * hop), y = yOf(Math.max(0, Math.min(1, v))); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    };
    plot(r.sim.values, r.sim.start, r.sim.hop, `rgba(${P.cyan},0.9)`);
    // the engine thresholds the profile after a moving average of regionSmoothS
    const fr = r.profile.frac, win = Math.max(1, Math.floor((opt.regionSmoothS * t.sr) / r.profile.hop)), half = win >> 1;
    const smooth = fr.map((_, i) => { let s = 0, k = 0; for (let j = i - half; j < i - half + win; j++) if (j >= 0 && j < fr.length) { s += fr[j]; k++; } return s / k; });
    plot(fr, r.profile.start, r.profile.hop, `rgba(${P.lilac},0.18)`);
    plot(smooth, r.profile.start, r.profile.hop, `rgba(${P.lilac},0.95)`);
    g.fillStyle = `rgba(${P.faint},0.95)`; g.font = `${10 * dpr}px ui-monospace, Menlo, monospace`; g.textBaseline = "top";
    g.fillText(fmtTime(a / t.sr), 4 * dpr, 4 * dpr);
    const end = fmtTime(b / t.sr); g.fillText(end, w - g.measureText(end).width - 4 * dpr, 4 * dpr);
  }

  // ------------------------------------------- debug: song picker + player
  // A whole-song overview to mark the copy and the twin by ear. Rough is fine: the probe
  // searches around the marks and locks the exact offset itself.
  const pick = { seq: 0, mode: "listen", cursor: 0, playing: false, node: null, startedAt: 0, from: 0, to: 0, buf: null, bufFor: null, env: null, drag: null, raf: 0 };
  const PICK_HELP = {
    listen: "Click anywhere to listen from there.",
    src: "Drag across the copied section. Drag inside a mark to move it, or its edge to resize.",
    dst: "Drag across its twin, or click where it starts (it takes the copy's length).",
  };
  const pickOf = (t) => (t.pick || (t.pick = { src: null, dst: null }));
  function setPickMode(m) {
    pick.mode = m;
    document.querySelectorAll(".pick-modes button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.pick === m)));
    $("pickWrap").dataset.mode = m;
    $("pickHelp").textContent = PICK_HELP[m];
  }
  function pickDur() { const t = track(); return t && t.length ? t.length / t.sr : 1; }
  function pickPos() {
    if (!pick.playing) return pick.cursor;
    return Math.min(pick.to, pick.from + (player.ctx.currentTime - pick.startedAt));
  }

  async function pickPlay(from, to) {
    const t = track();
    if (!t) return;
    stopPlayback(true);
    pickStop(true);
    const my = ++pick.seq;
    await audioCtx();
    if (my !== pick.seq || track() !== t) return;
    if (pick.bufFor !== t.id) {
      const ch = await ensureAudio(t);
      if (my !== pick.seq || track() !== t) return;
      pick.buf = toAudioBuffer(ch, t.sr); pick.bufFor = t.id;
    }
    if (my !== pick.seq || track() !== t) return;
    const dur = pickDur();
    from = Math.max(0, Math.min(dur - 0.01, from)); to = Math.min(dur, to === undefined ? dur : to);
    const node = player.ctx.createBufferSource();
    node.buffer = pick.buf; node.connect(player.ctx.destination);
    const at = player.ctx.currentTime + 0.02;
    node.start(at, from, Math.max(0.01, to - from));
    node.onended = () => { if (pick.node === node) { pick.cursor = pickPos(); pickStop(true); } };
    Object.assign(pick, { node, playing: true, startedAt: at, from, to });
    setPickIcon();
    const step = () => { drawPick(); if (pick.playing) pick.raf = requestAnimationFrame(step); };
    pick.raf = requestAnimationFrame(step);
  }
  function pickStop(keep) {
    pick.seq++;
    if (pick.node) {
      const pos = pickPos();
      try { pick.node.onended = null; pick.node.stop(); } catch { /* already stopped */ }
      pick.node.disconnect(); pick.node = null;
      if (keep !== false) pick.cursor = pos;
    }
    pick.playing = false;
    cancelAnimationFrame(pick.raf);
    setPickIcon();
    drawPick();
  }
  function setPickIcon() {
    const b = $("pickPlay");
    if (!b) return;
    b.setAttribute("aria-label", pick.playing ? "Pause" : "Play from the cursor");
    b.classList.toggle("playing", pick.playing);
    $("pickIcon").innerHTML = pick.playing ? '<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/>' : '<path d="M4 2.5v11l9-5.5z" fill="currentColor"/>';
  }

  /** Marks -> probe fields. */
  function pickToForm() {
    const t = track(), pk = pickOf(t);
    if (pk.src) { $("probeSrc").value = fmtTime(pk.src.s); $("probeLen").value = (pk.src.e - pk.src.s).toFixed(1); }
    if (pk.dst) $("probeDst").value = fmtTime(pk.dst.s);
    $("pickPlaySrc").disabled = !pk.src; $("pickPlayDst").disabled = !pk.dst;
  }
  /** Probe fields -> marks (when typed). */
  function formToPick() {
    const t = track();
    if (!t || t.status !== "done") return;
    const pk = pickOf(t), src = parseTime($("probeSrc").value), dst = parseTime($("probeDst").value);
    const len = Math.max(0.5, Number($("probeLen").value) || 15), dur = pickDur();
    pk.src = Number.isFinite(src) ? { s: Math.min(src, dur), e: Math.min(dur, src + len) } : null;
    pk.dst = Number.isFinite(dst) ? { s: Math.min(dst, dur), e: Math.min(dur, dst + len) } : null;
    $("pickPlaySrc").disabled = !pk.src; $("pickPlayDst").disabled = !pk.dst;
    drawPick();
  }

  function drawPick() {
    const t = track(), c = $("pickCanvas");
    if (!t || t.status !== "done" || $("debug").hidden || !$("debug").open || !c.offsetWidth) return;
    const ch = audioCache.get(t.id);
    const { w, h, dpr } = sizeCanvas(c), g = c.getContext("2d");
    g.clearRect(0, 0, w, h);
    const dur = pickDur(), xOf = (sec) => (sec / dur) * w;
    const axis = 16 * dpr, mid = (h - axis) / 2, amp = (h - axis) * 0.44;
    const pk = pickOf(t);
    // marks
    const mark = (r, rgb, label) => {
      if (!r) return;
      const x0 = xOf(r.s), x1 = Math.max(x0 + 2 * dpr, xOf(r.e));
      g.fillStyle = `rgba(${rgb},0.16)`; g.fillRect(x0, 0, x1 - x0, h - axis);
      g.fillStyle = `rgba(${rgb},0.95)`; g.fillRect(x0, 0, 2 * dpr, h - axis); g.fillRect(x1 - 2 * dpr, 0, 2 * dpr, h - axis);
      g.font = `600 ${10.5 * dpr}px ui-monospace, Menlo, monospace`; g.textBaseline = "top";
      g.fillText(label, x0 + 5 * dpr, 4 * dpr);
    };
    // what the last probe found (exact positions)
    if (t.probe && t.probe.regions) for (const p of t.probe.regions) {
      g.fillStyle = `rgba(${P.mint},0.22)`;
      g.fillRect(xOf(p.dstStart / t.sr), h - axis - 5 * dpr, Math.max(2, xOf(p.dstEnd / t.sr) - xOf(p.dstStart / t.sr)), 5 * dpr);
      g.fillRect(xOf(p.srcStart / t.sr), h - axis - 5 * dpr, Math.max(2, xOf(p.srcEnd / t.sr) - xOf(p.srcStart / t.sr)), 5 * dpr);
    }
    mark(pk.src, "255,181,71", "copy");
    mark(pk.dst, "82,224,232", "twin");
    // waveform
    if (ch) {
      const cols = Math.floor(w / (2 * dpr));
      if (!pick.env || pick.env.id !== t.id || pick.env.cols !== cols) { const e = envelope(ch, cols); let pkv = 1e-6; for (let i = 0; i < cols; i++) pkv = Math.max(pkv, e.mx[i], -e.mn[i]); pick.env = { id: t.id, cols, e, peak: pkv }; }
      const { e, peak } = pick.env, bw = w / cols;
      for (let i = 0; i < cols; i++) {
        const sec = ((i + 0.5) / cols) * dur;
        const inS = pk.src && sec >= pk.src.s && sec < pk.src.e, inD = pk.dst && sec >= pk.dst.s && sec < pk.dst.e;
        g.fillStyle = inS ? `rgba(${P.amber},0.9)` : inD ? `rgba(${P.cyan},0.9)` : `rgba(${P.muted},0.4)`;
        const y0 = mid - (e.mx[i] / peak) * amp, y1 = mid - (e.mn[i] / peak) * amp;
        g.fillRect(i * bw, y0, Math.max(1, bw - dpr), Math.max(1, y1 - y0));
      }
    }
    // axis
    g.fillStyle = `rgba(${P.faint},0.95)`; g.font = `${10 * dpr}px ui-monospace, Menlo, monospace`; g.textBaseline = "bottom";
    const stepS = dur > 400 ? 60 : dur > 150 ? 30 : dur > 40 ? 10 : 5;
    for (let sec = 0; sec <= dur; sec += stepS) { const x = xOf(sec); g.fillRect(x, h - axis, 1, 4 * dpr); if (x < w - 30 * dpr) g.fillText(fmtTime(sec, 0), x + 3 * dpr, h - 1 * dpr); }
    // cursor / playhead
    const x = xOf(pickPos());
    g.fillStyle = pick.playing ? `rgb(${P.ink})` : `rgba(${P.ink},0.55)`;
    g.fillRect(Math.round(x) - dpr, 0, 2 * dpr, h - axis);
    $("pickTime").textContent = `${fmtTime(pickPos())} / ${fmtTime(dur, 0)}`;
  }

  function bindPicker() {
    const wrap = $("pickWrap"), hover = $("pickHover");
    document.querySelectorAll(".pick-modes button").forEach((b) => b.addEventListener("click", () => setPickMode(b.dataset.pick)));
    $("pickPlay").addEventListener("click", () => (pick.playing ? pickStop() : pickPlay(pick.cursor)));
    $("pickPlaySrc").addEventListener("click", () => { const pk = pickOf(track()); if (pk.src) pickPlay(pk.src.s, pk.src.e); });
    $("pickPlayDst").addEventListener("click", () => { const pk = pickOf(track()); if (pk.dst) pickPlay(pk.dst.s, pk.dst.e); });
    $("debug").addEventListener("toggle", () => { if (!$("debug").open) pickStop(); requestAnimationFrame(drawPick); });
    ["probeSrc", "probeDst", "probeLen"].forEach((id) => $(id).addEventListener("input", formToPick));

    const secAt = (e) => { const r = wrap.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * pickDur(); };
    const edgeTol = () => (6 / wrap.getBoundingClientRect().width) * pickDur();
    wrap.addEventListener("pointerdown", (e) => {
      const t = track(); if (!t || t.status !== "done") return;
      const sec = secAt(e);
      wrap.setPointerCapture(e.pointerId);
      if (pick.mode === "listen") { pick.drag = { kind: "seek" }; pick.cursor = sec; pickPlay(sec); return; }
      const pk = pickOf(t), key = pick.mode, cur = pk[key], tol = edgeTol();
      if (cur && Math.abs(sec - cur.s) < tol) pick.drag = { kind: "resize-s", key };
      else if (cur && Math.abs(sec - cur.e) < tol) pick.drag = { kind: "resize-e", key };
      else if (cur && sec > cur.s && sec < cur.e) pick.drag = { kind: "move", key, grab: sec - cur.s, len: cur.e - cur.s };
      else pick.drag = { kind: "new", key, anchor: sec, moved: false };
      e.preventDefault();
    });
    wrap.addEventListener("pointermove", (e) => {
      const t = track(); if (!t || t.status !== "done") return;
      const sec = secAt(e), dur = pickDur();
      hover.hidden = false; hover.textContent = fmtTime(sec);
      hover.style.left = `${(sec / dur) * 100}%`;
      const d = pick.drag;
      if (!d) {
        const cur = pick.mode !== "listen" && pickOf(t)[pick.mode], tol = edgeTol();
        wrap.style.cursor = pick.mode === "listen" ? "pointer" : cur && (Math.abs(sec - cur.s) < tol || Math.abs(sec - cur.e) < tol) ? "ew-resize" : cur && sec > cur.s && sec < cur.e ? "grab" : "crosshair";
        return;
      }
      if (d.kind === "seek") return;
      const pk = pickOf(t);
      if (d.kind === "new") {
        if (Math.abs(sec - d.anchor) > edgeTol() / 2) d.moved = true;
        if (d.moved) pk[d.key] = { s: Math.min(d.anchor, sec), e: Math.max(d.anchor, sec) };
      } else if (d.kind === "move") {
        const s0 = Math.max(0, Math.min(dur - d.len, sec - d.grab));
        pk[d.key] = { s: s0, e: s0 + d.len };
      } else if (d.kind === "resize-s") pk[d.key] = { s: Math.min(sec, pk[d.key].e - 0.5), e: pk[d.key].e };
      else if (d.kind === "resize-e") pk[d.key] = { s: pk[d.key].s, e: Math.max(sec, pk[d.key].s + 0.5) };
      pickToForm(); drawPick();
    });
    const end = (e) => {
      const d = pick.drag; pick.drag = null;
      const t = track(); if (!d || !t || d.kind === "seek") return;
      const pk = pickOf(t);
      if (d.kind === "new" && !d.moved) {
        // a click: twin takes the copy's length; copy gets a default 10 s
        const len = d.key === "dst" && pk.src ? pk.src.e - pk.src.s : pk[d.key] ? pk[d.key].e - pk[d.key].s : 10;
        const s0 = Math.min(d.anchor, pickDur() - len);
        pk[d.key] = { s: Math.max(0, s0), e: Math.max(0, s0) + len };
      }
      if (pk[d.key] && pk[d.key].e - pk[d.key].s < 0.5) pk[d.key].e = pk[d.key].s + 0.5;
      pickToForm(); drawPick();
      if (d.key === "src" && !pk.dst && e.type === "pointerup") setPickMode("dst");   // next: its twin
    };
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);
    wrap.addEventListener("pointerleave", () => { hover.hidden = true; });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation();
        const was = pick.playing;
        pickStop();
        pick.cursor = Math.max(0, Math.min(pickDur(), pick.cursor + (e.key === "ArrowLeft" ? -5 : 5)));
        if (was) pickPlay(pick.cursor); else drawPick();
      } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); pick.playing ? pickStop() : pickPlay(pick.cursor); }
    });
    setPickMode("listen");
  }

  // ----------------------------------------------------------------- events
  function bind() {
    $("chooseFile").addEventListener("click", () => $("fileInput").click());
    $("addSong").addEventListener("click", () => $("fileInput").click());
    bindTabScroller();
    bindStarNudge();
    $("closeAll").addEventListener("click", closeAllClick);
    bindLeaveWarning();
    $("fileInput").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; wakeScope(); });
    // installed app: songs opened with isol8 from the OS ("Open with")
    if ("launchQueue" in window) {
      window.launchQueue.setConsumer(async (params) => {
        const files = await Promise.all((params.files || []).map((h) => h.getFile().catch(() => null)));
        const ok = files.filter(Boolean);
        if (ok.length) { addFiles(ok); wakeScope(); }
      });
    }

    const sc = $("scope");
    let depth = 0;
    window.addEventListener("dragenter", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { depth++; sc.classList.add("dragging"); } });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) sc.classList.remove("dragging"); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault(); depth = 0; sc.classList.remove("dragging");
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("audio/") || /\.(mp3|flac|wav|aiff?|ogg|opus|m4a|webm|aac)$/i.test(f.name));
      if (files.length) { addFiles(files); wakeScope(); }
      else toast("That doesn't look like an audio file.", "warn");
    });

    $("showMore").addEventListener("click", () => { state.showAll = !state.showAll; renderResults(); mapCache = null; wakeScope(); });
    $("playBtn").addEventListener("click", () => { toggle(); wakeScope(); });
    document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("loop").addEventListener("change", () => { if (player.playing) { pause(); play(); } });
    $("nudgeDown").addEventListener("click", () => nudge(-1));
    $("nudgeUp").addEventListener("click", () => nudge(+1));
    $("nudgeReset").addEventListener("click", () => nudge(0));
    $("download").addEventListener("click", download);
    $("blend").addEventListener("input", (e) => setBlend(e.target.value / 100));
    $("cleanNoise").checked = player.clean.noise;
    $("cleanNoise").addEventListener("change", (e) => { $("nrAmountWrap").hidden = !e.target.checked; setClean("noise", e.target.checked); });
    $("nrAmount").value = String(Math.round(player.clean.amount * 100));
    $("nrAmountOut").textContent = `${$("nrAmount").value}%`;
    $("nrAmountWrap").hidden = !player.clean.noise;
    $("nrAmount").addEventListener("input", (e) => { $("nrAmountOut").textContent = `${e.target.value}%`; });
    // rebuild once the slider is let go (a rebuild takes a moment on long sections)
    $("nrAmount").addEventListener("change", (e) => setClean("amount", e.target.value / 100));
    bindCrop();
    bindShapeSliders();
    document.querySelectorAll("#stereoRow .seg button").forEach((b) => b.addEventListener("click", () => {
      if (b.disabled || player.clean.stereo === b.dataset.part) return;
      setClean("stereo", b.dataset.part);
      renderStereo();
    }));
    renderStereo();
    renderBlend();
    $("settingsToggle").addEventListener("click", () => toggleSettings());
    $("settingsBtn").addEventListener("click", () => toggleSettings());
    $("settingsClose").addEventListener("click", () => toggleSettings(false));
    $("settingsReset").addEventListener("click", () => { Object.assign(settings, E.DEFAULTS); syncSettings(); });
    $("reanalyse").addEventListener("click", reanalyse);
    $("probeForm").addEventListener("submit", runProbe);
    bindPicker();
    buildSettings();

    // waveform seeking (mouse, touch, keyboard)
    const ww = $("waveWrap");
    const seekFromEvent = (e) => { const r = ww.getBoundingClientRect(); seek((e.clientX - r.left) / r.width); wakeScope(); };
    ww.addEventListener("pointerdown", (e) => { ww.setPointerCapture(e.pointerId); seekFromEvent(e); });
    ww.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation();
        seek((position() + (e.key === "ArrowLeft" ? -2 : 2)) / player.duration);
      }
    });

    // twin map: hover + click on arcs
    const cv = $("scopeCanvas"), tip = $("scopeTip");
    /** The twin under the pointer: an arc, or else a copied/twin span on the waveform (best ranked wins). */
    const nearest = (e) => {
      const r = cv.getBoundingClientRect(), dpr = cv.width / r.width;
      const x = (e.clientX - r.left) * dpr, y = (e.clientY - r.top) * dpr;
      let best = null, bd = 14 * dpr;
      for (const a of scope.arcs) for (const [px, py] of a.pts) { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = a.id; } }
      const geo = scope.geo, t = track();
      if (!best && geo && t && Math.abs(y - geo.mid) <= geo.waveH + 6 * dpr) {
        const at = (x / geo.w) * geo.len;
        let rank = Infinity;
        for (const p of t.results) {
          if (((at >= p.srcStart && at < p.srcEnd) || (at >= p.dstStart && at < p.dstEnd)) && p.rank < rank) { rank = p.rank; best = p.id; }
        }
      }
      return best;
    };
    const showTip = (e, id) => {
      const t = track(), p = id && t ? t.results.find((r) => r.id === id) : null;
      if (!p || e.pointerType === "touch") { tip.hidden = true; return; }
      const sr = p.sr, sc = $("scope").getBoundingClientRect();
      tip.innerHTML = "";
      const b = document.createElement("b"); b.textContent = `#${p.rank}`;
      const sEl = document.createElement("span"); sEl.className = "s"; sEl.textContent = fmtTime(p.srcStart / sr);
      const dEl = document.createElement("span"); dEl.className = "d"; dEl.textContent = fmtTime(p.dstStart / sr);
      const small = document.createElement("small");
      small.textContent = `${((p.dstEnd - p.dstStart) / sr).toFixed(1)} s · cancels ${fmtDb(p.cancelDb)} dB · ${kindOf(p)}`;
      tip.append(b, sEl, " → ", dEl, small);
      tip.hidden = false;
      const x = Math.max(90, Math.min(sc.width - 90, e.clientX - sc.left));
      tip.style.left = `${x}px`; tip.style.top = `${e.clientY - sc.top}px`;
    };
    cv.addEventListener("pointermove", (e) => {
      if (scope.mode !== "map") { tip.hidden = true; return; }
      const id = nearest(e);
      showTip(e, id);
      if (id !== scope.hover) { scope.hover = id; cv.style.cursor = id ? "pointer" : ""; wakeScope(); }
    });
    cv.addEventListener("pointerleave", () => { scope.hover = null; tip.hidden = true; wakeScope(); });
    cv.addEventListener("click", (e) => {
      if (scope.mode !== "map") return;
      const id = nearest(e);
      if (id) { selectResult(id, "play"); wakeScope(); }
    });

    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = track();
      if (!t || t.status !== "done" || !t.results.length) return;
      const onButton = e.target.closest("button, summary, a, [role='application']");
      if (e.key === " " && !onButton) { e.preventDefault(); toggle(); wakeScope(); }
      else if (e.key === "1") setMode("iso");
      else if (e.key === "2") setMode("dst");
      else if (e.key === "3") setMode("src");
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.closest(".results, .player")) {
        e.preventDefault();
        const i = t.results.findIndex((r) => r.id === state.selected);
        const j = Math.max(0, Math.min(t.results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        if (j !== i) { selectResult(t.results[j].id, true); document.querySelector(`.result[data-id="${t.results[j].id}"]`)?.focus(); wakeScope(); }
      }
    });

    let rt = 0;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { mapCache = null; drawWave(); placeModePill(); drawPick(); wakeScope(); }, 120); });
    window.addEventListener("isol8:theme", () => {
      // wait one frame so the new variables are applied before reading them
      requestAnimationFrame(() => { readPalette(); mapCache = null; drawWave(); drawPick(); renderProbe(); wakeScope(); });
    });
    const top = document.querySelector(".top");
    const onScroll = () => top.style.setProperty("--scrolled", String(Math.min(1, scrollY / 40)));
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }

  bind();
  renderAll();
  restoreSession();
  scope.sleeping = false;
  requestAnimationFrame(scopeLoop);

  // test hook (read-only view of results; used by the end-to-end tests)
  window.__isol8 = { state, analyse, settings };
})();

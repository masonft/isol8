/* isol8 MP3 encoder worker. Encodes float PCM to CBR MP3 with LAME (lamejs, LGPL-3.0,
   vendored in vendor/lame.min.js so the page still makes no network requests). */
/* global lamejs */
let available = true;
try { importScripts("vendor/lame.min.js"); } catch { available = false; }

self.onmessage = (e) => {
  const { id, channels, sampleRate, kbps, gain } = e.data;
  if (!available || typeof lamejs === "undefined") { self.postMessage({ id, type: "unavailable" }); return; }
  try {
    const nch = Math.min(2, channels.length), n = channels[0].length;
    const enc = new lamejs.Mp3Encoder(nch, sampleRate, kbps);
    const BLOCK = 1152 * 16;
    const L = new Int16Array(BLOCK), R = new Int16Array(BLOCK);
    const parts = [];
    const q = (v) => { const s = Math.round(v * gain * 32767); return s > 32767 ? 32767 : s < -32768 ? -32768 : s; };
    let lastReport = 0;
    for (let i = 0; i < n; i += BLOCK) {
      const m = Math.min(BLOCK, n - i);
      const a = channels[0], b = channels[nch - 1];
      for (let k = 0; k < m; k++) { L[k] = q(a[i + k]); R[k] = q(b[i + k]); }
      const out = nch === 2 ? enc.encodeBuffer(L.subarray(0, m), R.subarray(0, m)) : enc.encodeBuffer(L.subarray(0, m));
      if (out.length) parts.push(out);
      const frac = (i + m) / n;
      if (frac - lastReport > 0.02) { lastReport = frac; self.postMessage({ id, type: "progress", frac }); }
    }
    const tail = enc.flush();
    if (tail.length) parts.push(tail);
    self.postMessage({ id, type: "done", parts });
  } catch (err) {
    self.postMessage({ id, type: "error", message: String((err && err.message) || err) });
  }
};

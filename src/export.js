/* isol8 export: WAV (exact) and MP3 (320 kbps CBR via the vendored LAME encoder).
   Everything is encoded locally. */
(function (root) {
  "use strict";

  /** MP3 only exists at these rates (MPEG-1, MPEG-2 and MPEG-2.5). */
  const MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

  function peakOf(chs) {
    let peak = 0;
    for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    return peak;
  }

  function encodeWav(chs, sr, fmt) {
    const nch = chs.length, n = chs[0].length;
    let gain = 1;
    const peak = peakOf(chs);
    const bytes = fmt === "f32" ? 4 : fmt === "s24" ? 3 : 2;
    if (fmt !== "f32" && peak > 0.999) gain = 0.999 / peak;
    const float = fmt === "f32";
    const fmtSize = float ? 18 : 16, factSize = float ? 12 : 0;
    const dataSize = n * nch * bytes;
    const buf = new ArrayBuffer(12 + 8 + fmtSize + factSize + 8 + dataSize);
    const v = new DataView(buf);
    let o = 0;
    const str = (s) => { for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); };
    str("RIFF"); v.setUint32(o, buf.byteLength - 8, true); o += 4; str("WAVE");
    str("fmt "); v.setUint32(o, fmtSize, true); o += 4;
    v.setUint16(o, float ? 3 : 1, true); o += 2; v.setUint16(o, nch, true); o += 2;
    v.setUint32(o, sr, true); o += 4; v.setUint32(o, sr * nch * bytes, true); o += 4;
    v.setUint16(o, nch * bytes, true); o += 2; v.setUint16(o, bytes * 8, true); o += 2;
    if (float) { v.setUint16(o, 0, true); o += 2; str("fact"); v.setUint32(o, 4, true); o += 4; v.setUint32(o, n, true); o += 4; }
    str("data"); v.setUint32(o, dataSize, true); o += 4;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const s = chs[c][i] * gain;
        if (float) { v.setFloat32(o, s, true); o += 4; }
        else if (bytes === 3) {
          const q = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388607)));
          v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255); o += 3;
        } else { v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true); o += 2; }
      }
    }
    return { blob: new Blob([buf], { type: "audio/wav" }), gainDb: 20 * Math.log10(gain), sampleRate: sr };
  }

  /** Picks the MP3 rate to encode at: the song's own rate when MP3 allows it. */
  function mp3RateFor(sr) {
    if (MP3_RATES.includes(sr)) return sr;
    const exact = MP3_RATES.find((r) => sr % r === 0);
    if (exact) return exact;
    return sr > 48000 ? 48000 : MP3_RATES.reduce((a, b) => (Math.abs(b - sr) < Math.abs(a - sr) ? b : a));
  }

  async function resample(chs, sr, to) {
    const n = chs[0].length, m = Math.ceil((n * to) / sr);
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const ctx = new OAC(chs.length, m, to);
    const b = ctx.createBuffer(chs.length, n, sr);
    chs.forEach((c, i) => b.copyToChannel(c, i));
    const s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination); s.start();
    const out = await ctx.startRendering();
    return Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i));
  }

  let worker = null, seq = 0;
  const jobs = new Map();
  function getWorker() {
    if (worker) return worker;
    try { worker = new Worker("mp3-worker.js"); } catch { return null; }
    worker.onmessage = (e) => {
      const m = e.data, j = jobs.get(m.id);
      if (!j) return;
      if (m.type === "progress") { j.onProgress && j.onProgress(m.frac); return; }
      jobs.delete(m.id);
      if (m.type === "done") j.resolve(m.parts);
      else if (m.type === "unavailable") j.reject(Object.assign(new Error("MP3 encoder not installed"), { unavailable: true }));
      else j.reject(new Error(m.message || "MP3 encoding failed"));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      for (const j of jobs.values()) j.reject(Object.assign(new Error("MP3 encoder not available"), { unavailable: true }));
      jobs.clear();
      worker.terminate(); worker = null;
    };
    return worker;
  }

  /**
   * Encodes channels to a 320 kbps MP3. Rates MP3 can't carry (e.g. 96 kHz) are resampled
   * for the file only. Peaks above full scale are turned down so the MP3 doesn't clip.
   */
  async function encodeMp3(chs, sr, onProgress, kbps = 320) {
    const w = getWorker();
    if (!w) throw Object.assign(new Error("Workers unavailable"), { unavailable: true });
    const outSr = mp3RateFor(sr);
    let data = chs.slice(0, 2);
    if (outSr !== sr) data = await resample(data, sr, outSr);
    const peak = peakOf(data);
    const gain = peak > 0.999 ? 0.999 / peak : 1;
    const id = ++seq;
    const parts = await new Promise((resolve, reject) => {
      jobs.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, channels: data, sampleRate: outSr, kbps, gain });
    });
    return { blob: new Blob(parts, { type: "audio/mpeg" }), gainDb: 20 * Math.log10(gain), sampleRate: outSr, resampled: outSr !== sr };
  }

  root.Isol8Export = { encodeWav, encodeMp3, mp3RateFor, MP3_RATES };
})(typeof self !== "undefined" ? self : this);

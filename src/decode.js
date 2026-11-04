/*
 * Native-sample-rate decoding.
 *
 * Web Audio's decodeAudioData() resamples to the context's rate. Resampling turns
 * the whole-sample offset between twins into a fractional one, which ruins the
 * cancellation. So the file's own rate is read from its header first and a context
 * with exactly that rate is used for decoding.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Isol8Decode = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

  function ascii(b, o, n) { let s = ""; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; }
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16be = (b, o) => (b[o] << 8) | b[o + 1];

  function skipId3(b) {
    let o = 0;
    while (ascii(b, o, 3) === "ID3" && o + 10 <= b.length) {
      const size = ((b[o + 6] & 0x7f) << 21) | ((b[o + 7] & 0x7f) << 14) | ((b[o + 8] & 0x7f) << 7) | (b[o + 9] & 0x7f);
      o += 10 + size + (b[o + 5] & 0x10 ? 10 : 0);
    }
    return o;
  }

  function wavRate(b) {
    let o = 12;
    while (o + 8 <= b.length) {
      const id = ascii(b, o, 4), size = u32le(b, o + 4);
      if (id === "fmt ") return u32le(b, o + 12);
      o += 8 + size + (size & 1);
    }
    return null;
  }

  function flacRate(b, o) {
    // "fLaC" + metadata block header (4) + STREAMINFO: 10 bytes, then 20-bit rate
    const p = o + 8 + 10;
    return (b[p] << 12) | (b[p + 1] << 4) | (b[p + 2] >> 4);
  }

  function mp3Rate(b, o) {
    for (let i = o; i + 4 < Math.min(b.length, o + 65536); i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, br = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3;
      if (ver === 1 || layer === 0 || br === 15 || br === 0 || sri === 3) continue;
      const rate = MP3_RATES[ver][sri];
      // confirm with the next frame header (layer III / II)
      const padding = (b[i + 2] >> 1) & 1;
      const brTab = ver === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
                              : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      if (layer === 1) {
        const len = Math.floor(((ver === 3 ? 144 : 72) * brTab[br] * 1000) / rate) + padding;
        const j = i + len;
        if (j + 1 < b.length && !(b[j] === 0xff && (b[j + 1] & 0xe0) === 0xe0)) continue;
      }
      return rate;
    }
    return null;
  }

  function oggRate(b) {
    // first page's first packet: Vorbis id header or OpusHead / FLAC-in-Ogg
    const segs = b[26], data = 27 + segs;
    if (ascii(b, data + 1, 6) === "vorbis") return u32le(b, data + 12);
    if (ascii(b, data, 8) === "OpusHead") return 48000; // Opus always decodes at 48 kHz
    if (ascii(b, data + 1, 4) === "FLAC") return flacRate(b, data + 9);
    return null;
  }

  function aiffRate(b) {
    let o = 12;
    while (o + 8 <= b.length) {
      const id = ascii(b, o, 4), size = u32be(b, o + 4);
      if (id === "COMM") {
        // 80-bit IEEE extended at offset 8 of chunk data
        const p = o + 8 + 8, exp = ((b[p] & 0x7f) << 8) | b[p + 1];
        let mant = 0;
        for (let i = 0; i < 8; i++) mant = mant * 256 + b[p + 2 + i];
        return Math.round(mant * Math.pow(2, exp - 16383 - 63));
      }
      o += 8 + size + (size & 1);
    }
    return null;
  }

  /** MP4/M4A: sample rate of the first sound track (stsd entry, or mdhd timescale). */
  function mp4Rate(b) {
    const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta"]);
    let found = null;
    function walk(o, end, inSound) {
      let soundHere = inSound;
      let mdhd = null;
      while (o + 8 <= end && found === null) {
        let size = u32be(b, o);
        const type = ascii(b, o + 4, 4);
        let hdr = 8;
        if (size === 1) { size = u32be(b, o + 8) * 4294967296 + u32be(b, o + 12); hdr = 16; }
        else if (size === 0) size = end - o;
        if (size < hdr) return;
        const body = o + hdr, next = o + size;
        if (type === "hdlr") soundHere = ascii(b, body + 8, 4) === "soun";
        else if (type === "mdhd") {
          const v = b[body];
          mdhd = v === 1 ? u32be(b, body + 20) : u32be(b, body + 12);
        } else if (type === "stsd" && soundHere) {
          // first sample entry: 8-byte box header, 6 reserved, 2 dref, 8 version/rev/vendor,
          // 2 channels, 2 sample size, 2 compression id, 2 packet size, 4 rate (16.16)
          const e = body + 8;
          let rate = u16be(b, e + 8 + 24);
          // ALAC keeps the true rate in its config box: the 16-bit field above can't hold
          // rates over 65535 (e.g. 96 kHz). Config = 4 version/flags + 20 bytes, then the rate.
          if (ascii(b, e + 4, 4) === "alac") {
            const entryEnd = Math.min(e + u32be(b, e), next);
            for (let c = e + 36; c + 36 <= entryEnd;) {
              const cs = u32be(b, c);
              if (ascii(b, c + 4, 4) === "alac" && cs >= 36) { rate = u32be(b, c + 32) || rate; break; }
              if (cs < 8) break;
              c += cs;
            }
          }
          if (rate) found = rate;
        } else if (type === "trak") {
          soundHere = false;
          walk(body, Math.min(next, end), false);
        } else if (containers.has(type)) {
          walk(body, Math.min(next, end), soundHere);
          if (type === "mdia" && found === null && soundHere && mdhd) found = mdhd;
        }
        o = next;
      }
      if (found === null && soundHere && mdhd) found = mdhd;
    }
    walk(0, b.length, false);
    return found;
  }

  /** Returns { format, sampleRate } (sampleRate null if unknown). */
  function sniff(buffer) {
    const b = new Uint8Array(buffer);
    const id3 = skipId3(b);
    const head = ascii(b, 0, 4), sub = ascii(b, 8, 4);
    if ((head === "RIFF" || head === "RF64") && sub === "WAVE") return { format: "wav", sampleRate: wavRate(b) };
    if (head === "FORM" && (sub === "AIFF" || sub === "AIFC")) return { format: "aiff", sampleRate: aiffRate(b) };
    if (ascii(b, id3, 4) === "fLaC") return { format: "flac", sampleRate: flacRate(b, id3) };
    if (head === "OggS") return { format: "ogg", sampleRate: oggRate(b) };
    if (ascii(b, 4, 4) === "ftyp") return { format: "mp4", sampleRate: mp4Rate(b) };
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { format: "webm", sampleRate: 48000 };
    const r = mp3Rate(b, id3);
    if (r) return { format: "mp3", sampleRate: r };
    return { format: "unknown", sampleRate: null };
  }

  /**
   * Decode at the file's native rate. Returns { channels: Float32Array[], sampleRate, format, rateKnown }.
   */
  async function decodeNative(arrayBuffer) {
    const info = sniff(arrayBuffer);
    const OAC = self.OfflineAudioContext || self.webkitOfflineAudioContext;
    if (!OAC) throw new Error("This browser can't decode audio (no Web Audio support).");
    const rate = info.sampleRate && info.sampleRate >= 3000 && info.sampleRate <= 384000 ? info.sampleRate : 44100;
    const ctx = new OAC(1, 1, rate);
    const audio = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    return { channels, sampleRate: audio.sampleRate, format: info.format, rateKnown: !!info.sampleRate };
  }

  return { sniff, decodeNative };
});

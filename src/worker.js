/* isol8 analysis worker. Holds one copy of the track and runs pipeline steps on request. */
/* global Isol8Engine */
importScripts("engine.js");

let ctx = null;

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      ctx = Isol8Engine.prepare(msg.channels, msg.sampleRate, msg.options);
      Isol8Engine.features(ctx);                       // spectral features for the coarse scan
      self.postMessage({ type: "ready", job: msg.job });
    } else if (msg.type === "scan") {
      const f = Isol8Engine.features(ctx);
      const raw = Isol8Engine.coarseScan(f, ctx.sr, ctx.opt, msg.from, msg.to, (x) =>
        self.postMessage({ type: "progress", job: msg.job, task: msg.task, frac: x }));
      self.postMessage({ type: "scanned", job: msg.job, task: msg.task, raw, hop: f.hop });
    } else if (msg.type === "candidate") {
      const pairs = Isol8Engine.analyseCandidate(ctx, msg.candidate);
      self.postMessage({ type: "analysed", job: msg.job, task: msg.task, pairs });
    } else if (msg.type === "release") {
      ctx = null;
    }
  } catch (err) {
    self.postMessage({ type: "error", job: msg.job, task: msg.task, message: String(err && err.message || err) });
  }
};

/* Offline support and the "Install" offer. */
(() => {
  "use strict";
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  const box = document.getElementById("install");
  if (!box) return;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) return;
  const btn = box.querySelector("button"), note = box.querySelector(".install-note");
  let deferred = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    box.hidden = false; btn.hidden = false; note.hidden = true;
  });
  btn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null; box.hidden = true;
  });
  addEventListener("appinstalled", () => { box.hidden = true; });
  // iPhone and iPad Safari have no install prompt; tell people where the option lives
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) { box.hidden = false; btn.hidden = true; note.hidden = false; }
})();

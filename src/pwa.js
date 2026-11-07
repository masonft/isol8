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
    box.hidden = false;
  });
  // iPhone and iPad Safari have no install prompt; the button explains where the option lives
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) box.hidden = false;
  const hideNote = (e) => {
    if (e && box.contains(e.target)) return;
    note.hidden = true; btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", hideNote);
  };
  btn.addEventListener("click", async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null; box.hidden = true;
      return;
    }
    if (!ios) return;
    if (!note.hidden) return hideNote();
    note.hidden = false; btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", hideNote);
  });
  addEventListener("appinstalled", () => { box.hidden = true; });
})();

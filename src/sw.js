/*
 * isol8 service worker: makes the app work offline once it has been opened.
 * Network first, so a new deploy shows up on the next load; the cache is only the fallback.
 * Bump VERSION when the list of files changes.
 */
const VERSION = "isol8-v1";
const SHELL = [
  "./", "index.html", "how.html", "styles.css", "how.css",
  "theme.js", "github.js", "pwa.js", "app.js", "how.js", "engine.js", "decode.js", "export.js",
  "worker.js", "mp3-worker.js", "vendor/lame.min.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // one missing optional file (e.g. the MP3 encoder) must not block installing the rest
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // e.g. the GitHub star count
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === "navigate" && await cache.match("./"));
      if (hit) return hit;
      throw err;
    }
  })());
});

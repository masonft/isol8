/* isol8 GitHub link: shows the repo's star count next to the icon.
   This is the app's only network request: an anonymous GET to GitHub's public API (no
   cookies, no referrer, nothing about your audio). The count is kept for this tab session
   to stay well inside GitHub's rate limit. If the repo isn't there yet, or GitHub can't be
   reached, the button simply stays an icon. */
(() => {
  "use strict";
  const REPO = "masonft/isol8", KEY = "isol8-gh-stars", TTL = 60 * 60 * 1000;

  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`
    : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k` : String(n));

  function show(count) {
    document.querySelectorAll("[data-gh-stars]").forEach((a) => {
      const out = a.querySelector(".gh-stars");
      if (!out || !Number.isFinite(count)) return;
      out.querySelector(".gh-count").textContent = fmt(count);
      out.hidden = false;
      a.classList.add("has-stars");
      a.setAttribute("aria-label", `isol8 on GitHub, ${count.toLocaleString("en-US")} star${count === 1 ? "" : "s"}`);
    });
  }

  async function load() {
    try {
      const c = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (c && Date.now() - c.at < TTL) { if (c.count !== null) show(c.count); return; }
    } catch { /* storage blocked: just fetch */ }
    let count = null;
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}`, {
        credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/vnd.github+json" },
      });
      if (r.ok) { const j = await r.json(); if (Number.isFinite(j.stargazers_count)) count = j.stargazers_count; }
    } catch { /* offline or blocked: keep the plain icon */ }
    try { sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), count })); } catch { /* not cached */ }
    if (count !== null) show(count);
  }

  // after the page has settled, so it never competes with loading or analysis
  const start = () => ("requestIdleCallback" in window ? requestIdleCallback(load, { timeout: 3000 }) : setTimeout(load, 1200));
  if (document.readyState === "complete") start(); else addEventListener("load", start, { once: true });
})();

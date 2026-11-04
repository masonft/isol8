/* isol8 theme: light or dark. Runs in <head> so the right theme is set before the first
   paint. Follows the system setting until you pick one; your pick is remembered in this
   browser (localStorage, the only thing isol8 stores). */
(() => {
  "use strict";
  const KEY = "isol8-theme", root = document.documentElement;
  const sys = matchMedia("(prefers-color-scheme: light)");
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked: follow the system */ }
  const current = () => root.dataset.theme;

  function apply(theme, animate) {
    if (theme === current()) return;
    if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.classList.add("theme-anim");
      clearTimeout(apply.t); apply.t = setTimeout(() => root.classList.remove("theme-anim"), 500);
    }
    root.dataset.theme = theme;
    sync(theme);
    window.dispatchEvent(new CustomEvent("isol8:theme", { detail: theme }));
  }
  /** Browser chrome colour and the toggle's label follow the theme. */
  function sync(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "light" ? "#f5f5f9" : "#06070c";
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.setAttribute("aria-label", `Switch to ${theme === "light" ? "dark" : "light"} mode`));
  }

  root.dataset.theme = saved === "light" || saved === "dark" ? saved : sys.matches ? "light" : "dark";
  sys.addEventListener("change", (e) => { if (!saved) apply(e.matches ? "light" : "dark", true); });

  document.addEventListener("DOMContentLoaded", () => {
    sync(current());
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", () => {
      saved = current() === "light" ? "dark" : "light";
      try { localStorage.setItem(KEY, saved); } catch { /* not remembered, still switches */ }
      apply(saved, true);
    }));
  });
})();

// Applies the dark/light theme before the page paints. The choice lives in chrome.storage.sync
// (so the in-page editor can read it too) and is mirrored to localStorage for an instant first paint.
(() => {
  const KEY = "underline-theme";
  const root = document.documentElement;
  const prefersLight = matchMedia("(prefers-color-scheme: light)");

  const resolve = (pref) => (pref === "light" || pref === "dark" ? pref : prefersLight.matches ? "light" : "dark");

  let pref = "auto";
  try {
    pref = localStorage.getItem(KEY) || "auto";
  } catch {}

  function apply(next) {
    pref = next || "auto";
    root.dataset.theme = resolve(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {}
  }

  apply(pref);
  prefersLight.addEventListener("change", () => apply(pref));

  chrome.storage.sync.get("theme").then(({ theme }) => {
    if (theme && theme !== pref) apply(theme);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.theme) apply(changes.theme.newValue);
  });

  window.underlineTheme = {
    get: () => pref,
    resolved: () => resolve(pref),
    set: (next) => {
      apply(next);
      return chrome.storage.sync.set({ theme: next });
    }
  };
})();

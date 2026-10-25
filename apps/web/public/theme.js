// Runs before React (external file so the app's strict CSP allows it): paints
// the right mode, design, theme and motion before first paint from the appearance the
// app cached last time (lib/appearance.ts writes it; a test runs this file).
(function () {
  // Once: the keys from when the app was called Única ("unica:*") take their
  // Terno names, the default mailbox's pin included ("unica" is "terno" now).
  // A key already under its new name wins; the legacy one goes only once copied.
  function moveLegacyKeys(store) {
    try {
      var legacy = [];
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        if (k && k.indexOf("unica:") === 0) legacy.push(k);
      }
      for (var j = 0; j < legacy.length; j++) {
        var from = legacy[j];
        var to = from === "unica:storage:unica" ? "terno:storage:terno" : "terno:" + from.slice(6);
        if (store.getItem(to) !== null) continue;
        store.setItem(to, store.getItem(from));
        if (store.getItem(to) !== null) store.removeItem(from);
      }
    } catch {}
  }
  moveLegacyKeys(localStorage);
  try {
    moveLegacyKeys(sessionStorage);
  } catch {}

  try {
    var KEY = "terno:appearance";
    var html = document.documentElement;
    var MODES = ["system", "light", "dark"];
    var ID = /^[a-z0-9-]{1,60}$/;
    // the default themes' ids from when the app was called Única (@terno/core LEGACY_THEME_IDS)
    var LEGACY_IDS = { "unica-light": "terno-light", "unica-dark": "terno-dark" };
    // the same numbers-only grammar as @terno/core THEME_COLOR_RE
    var N = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
    var COLOR = new RegExp("^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|oklch\\(\\s*" + N + "%?\\s+" + N + "\\s+" + N + "(?:deg)?\\s*(?:\\/\\s*" + N + "%?\\s*)?\\))$", "i");
    // plan 15: designs (@terno/core DESIGN_IDS) and the default's own palettes
    var DESIGNS = ["macos", "atelier", "lumen"];
    var LUMEN = { v: 2, design: "lumen", light: "lumen-light", dark: "lumen-dark", vibrancy: { light: false, dark: false } };
    var a = null;
    try {
      a = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {}
    if (!a || typeof a !== "object") {
      // v1 kept only the mode under unica:theme (terno:theme since the move above): convert it once
      var legacy = localStorage.getItem("terno:theme");
      a = { v: 2, mode: MODES.indexOf(legacy) >= 0 ? legacy : "system", design: LUMEN.design, light: LUMEN.light, dark: LUMEN.dark, motion: 75, vibrancy: LUMEN.vibrancy };
      localStorage.setItem(KEY, JSON.stringify(a));
      localStorage.removeItem("terno:theme");
    } else if (a.v !== 2) {
      // a cache from before designs: everyone moves to Lumen in its own colors (the backend does the same; its answer repaints anything else)
      a = { v: 2, mode: a.mode, design: LUMEN.design, light: LUMEN.light, dark: LUMEN.dark, motion: a.motion, vibrancy: LUMEN.vibrancy };
    }
    html.setAttribute("data-design", DESIGNS.indexOf(a.design) >= 0 ? a.design : LUMEN.design);
    var mode = MODES.indexOf(a.mode) >= 0 ? a.mode : "system";
    var dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    var m = dark ? "dark" : "light";
    var c = html.classList;
    if (dark) c.add("dark");
    else c.remove("dark");
    html.style.colorScheme = m;

    var custom = a.custom && a.custom[m];
    var id = custom ? custom.base : a[m];
    if (typeof id === "string" && Object.prototype.hasOwnProperty.call(LEGACY_IDS, id)) id = LEGACY_IDS[id];
    html.setAttribute("data-theme", typeof id === "string" && ID.test(id) ? id : dark ? LUMEN.dark : LUMEN.light);
    if (custom && custom.tokens) {
      for (var k in custom.tokens) {
        var v = custom.tokens[k];
        if (ID.test(k) && typeof v === "string" && COLOR.test(v)) html.style.setProperty("--" + k, v);
      }
    }

    var ms = [0, 50, 75, 100].indexOf(a.motion) >= 0 ? a.motion : 75;
    var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    html.style.setProperty("--motion", ms + "ms");
    html.style.setProperty("--motion-fast", Math.round(ms * 0.66) + "ms");
    html.style.setProperty("--motion-base", ms + "ms");
    html.style.setProperty("--motion-slow", Math.round(Math.min(ms * 1.33, 100)) + "ms");
    html.setAttribute("data-motion", ms === 0 || reduced ? "off" : "on");

    if (window.ternoDesktop) {
      c.add("is-desktop");
      if (window.ternoDesktop.platform === "darwin") {
        c.add("is-mac");
        // reduced transparency (System Settings → Accessibility) turns the native vibrancy off too
        var opaque = matchMedia("(prefers-reduced-transparency: reduce)").matches;
        if (!opaque && (!a.vibrancy || a.vibrancy[m] !== false)) html.setAttribute("data-vibrancy", "");
      }
    }
  } catch {}
})();

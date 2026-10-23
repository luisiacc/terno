// Runs before React (external file so the app's strict CSP allows it): paints
// the right mode, theme and motion before first paint from the appearance the
// app cached last time (lib/appearance.ts writes it; a test runs this file).
(function () {
  try {
    var KEY = "unica:appearance";
    var MODES = ["system", "light", "dark"];
    var ID = /^[a-z0-9-]{1,60}$/;
    // the same numbers-only grammar as @unica/core THEME_COLOR_RE
    var N = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
    var COLOR = new RegExp("^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|oklch\\(\\s*" + N + "%?\\s+" + N + "\\s+" + N + "(?:deg)?\\s*(?:\\/\\s*" + N + "%?\\s*)?\\))$", "i");
    var a = null;
    try {
      a = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {}
    if (!a || typeof a !== "object") {
      // v1 kept only the mode under unica:theme: convert it once
      var legacy = localStorage.getItem("unica:theme");
      a = { mode: MODES.indexOf(legacy) >= 0 ? legacy : "system", light: "unica-light", dark: "unica-dark", motion: 75, vibrancy: { light: true, dark: true } };
      localStorage.setItem(KEY, JSON.stringify(a));
      localStorage.removeItem("unica:theme");
    }
    var mode = MODES.indexOf(a.mode) >= 0 ? a.mode : "system";
    var dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    var m = dark ? "dark" : "light";
    var html = document.documentElement;
    var c = html.classList;
    if (dark) c.add("dark");
    else c.remove("dark");
    html.style.colorScheme = m;

    var custom = a.custom && a.custom[m];
    var id = custom ? custom.base : a[m];
    html.setAttribute("data-theme", typeof id === "string" && ID.test(id) ? id : dark ? "unica-dark" : "unica-light");
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

    if (window.unicaDesktop) {
      c.add("is-desktop");
      if (window.unicaDesktop.platform === "darwin") {
        c.add("is-mac");
        if (!a.vibrancy || a.vibrancy[m] !== false) html.setAttribute("data-vibrancy", "");
      }
    }
  } catch {}
})();

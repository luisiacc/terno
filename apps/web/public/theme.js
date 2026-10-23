// Runs before React (external file so the app's strict CSP allows it): paint
// the right theme immediately and flag the desktop shell for vibrancy styles.
(function () {
  try {
    var t = localStorage.getItem("unica:theme") || "system";
    var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    var c = document.documentElement.classList;
    if (dark) c.add("dark");
    if (window.unicaDesktop) {
      c.add("is-desktop");
      if (window.unicaDesktop.platform === "darwin") c.add("is-mac");
    }
  } catch {}
})();

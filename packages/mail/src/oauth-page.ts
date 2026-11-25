import { DEFAULT_LOCALE, LOCALE_IDS, LOCALES } from "@terno/i18n";

export type CallbackKey = "backend.oauth.invalid" | "backend.oauth.denied" | "backend.oauth.back" | "errors.google.adminPolicy"
  | "backend.oauth.microsoftInvalid" | "backend.oauth.microsoftDenied" | "errors.microsoft.adminConsent";

// brand/terno-icon.svg: the app icon the user knows from the Dock
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#2F5BFF"/><rect x="18" y="30" width="64" height="44" rx="7" fill="none" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="4"/><path d="M24 40 L45 56 M76 40 L55 56" fill="none" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="4" stroke-linecap="round"/><rect x="18" y="28" width="64" height="12" rx="6" fill="#FFFFFF"/><rect x="44" y="28" width="12" height="46" rx="6" fill="#FFFFFF"/></svg>`;

// Terno Light / Terno Dark (packages/ui/src/themes/registry.ts). The page is
// served by the backend to the user's browser, so it can't load the app's CSS.
const STYLE = `:root{color-scheme:light dark;--bg:oklch(.99 .002 85);--fg:oklch(.22 .01 265);--muted:oklch(.464 .012 265);--ok:oklch(.54 .13 160);--bad:oklch(.58 .21 25);--glyph:#fff}
@media (prefers-color-scheme:dark){:root{--bg:oklch(.24 .005 265);--fg:oklch(.95 .004 85);--muted:oklch(.745 .01 265);--ok:oklch(.72 .13 160);--bad:oklch(.695 .19 22);--glyph:oklch(.2 .01 265)}}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center;padding:24px}
main{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:340px;margin-bottom:8vh;animation:in 100ms ease-out both}
.mark{position:relative;width:72px;height:72px;margin-bottom:24px}
.mark svg{display:block;border-radius:17px;box-shadow:0 1px 2px rgb(0 0 0/.08),0 10px 28px -10px rgb(47 91 255/.55)}
.badge{position:absolute;right:-7px;bottom:-7px;width:28px;height:28px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--bg)}
.badge::before,.badge::after{content:"";position:absolute}
[data-ok] .badge::before{left:10px;top:6px;width:7px;height:12px;border:solid var(--glyph);border-width:0 2.5px 2.5px 0;border-radius:0 0 1px 0;transform:rotate(45deg)}
[data-fail] .badge{background:var(--bad)}
[data-fail] .badge::before,[data-fail] .badge::after{left:12.75px;top:7px;width:2.5px;height:14px;border-radius:1px;background:var(--glyph);transform:rotate(45deg)}
[data-fail] .badge::after{transform:rotate(-45deg)}
h1{font-size:20px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
p{margin-top:6px;color:var(--muted);text-wrap:balance}
[hidden]{display:none}
@keyframes in{from{opacity:0;transform:translateY(2px)}}
@media (prefers-reduced-motion:reduce){main{animation:none}}`;

/**
 * The page the browser shows after Google's redirect. The backend has no
 * language, so the page carries every locale and shows the browser's own
 * (English without script).
 */
export async function callbackPage(): Promise<(ok: boolean, msg: CallbackKey) => string> {
  const catalogs = await Promise.all(LOCALE_IDS.map(async (id) => [id, await LOCALES[id].load()] as const));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const pick = `<script>(function(){var ids=${JSON.stringify(LOCALE_IDS)};var l=(navigator.languages||[navigator.language]).map(function(t){return String(t).toLowerCase().split(/[-_]/)[0]}).find(function(b){return ids.indexOf(b)>=0});if(!l)return;document.querySelectorAll("[data-locale]").forEach(function(e){var on=e.getAttribute("data-locale")===l;e.hidden=!on;if(on){document.documentElement.lang=e.lang;document.title=e.querySelector("h1").textContent}})})()</script>`;
  return (ok, msg) => {
    let title = "";
    const blocks = catalogs.map(([id, m]) => {
      const text = (k: CallbackKey | "backend.oauth.connected" | "backend.oauth.failed") => esc(String(m[k] ?? k));
      const heading = text(ok ? "backend.oauth.connected" : "backend.oauth.failed");
      if (id === DEFAULT_LOCALE) title = heading;
      return `<div lang="${LOCALES[id].tag}" data-locale="${id}"${id === DEFAULT_LOCALE ? "" : " hidden"}><h1>${heading}</h1><p>${text(msg)}</p></div>`;
    });
    return `<!doctype html><html lang="${LOCALES[DEFAULT_LOCALE].tag}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main ${ok ? "data-ok" : "data-fail"}><div class="mark">${ICON}<span class="badge"></span></div>${blocks.join("")}</main>${pick}</body></html>`;
  };
}

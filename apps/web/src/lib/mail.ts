/** Rules for rendering HTML mail, kept apart from the component (the CSP and remote checks are tested in Node, the color check in the browser). */
import { exposeForTests } from "~/lib/render-probe";

/**
 * Remote images load only once the user opts in (tracking pixels included);
 * remote CSS and fonts never (plan 37: images are what "Load content" and the
 * setting promise, in either mode).
 */
export function csp(allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  return `default-src 'none'; img-src data: cid:${remote}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; frame-src 'none'; form-action 'none'`;
}

/** Attributes that fetch an image (an <a>/<area> href only navigates). */
const IMAGE_ATTRS = ["src", "background", "poster", "lowsrc", "dynsrc", "href", "xlink:href"];
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/**
 * Would the mail load something from the web once allowed (so the reader
 * offers "Load content")? Parsed, so entities and quoting are read as the
 * browser reads them, and linear in the mail's size (Codex code review: a
 * regex over raw markup missed `&#104;ttps:` and could go quadratic).
 * `//host/…` counts where it reaches the web: in the browser; the desktop
 * resolves it to app://, which never leaves the Mac.
 */
export function hasRemoteContent(html: string, protocolRelative = false): boolean {
  // most mail names no URL at all: no parse
  if (!/https?:|\/\/|&#|&[a-z]+;/i.test(html)) return false;
  const remote = protocolRelative ? /^\s*(?:https?:)?\/\//i : /^\s*https?:/i;
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  for (const el of doc.body.querySelectorAll("*")) {
    const link = el.localName === "a" || el.localName === "area";
    for (const { name, value } of el.attributes) {
      const n = name.toLowerCase();
      if (IMAGE_ATTRS.includes(n) && !(link && n.endsWith("href")) && remote.test(value)) return true;
      if (value.includes("url(")) for (const m of value.matchAll(CSS_URL)) if (remote.test(m[2]!)) return true;
    }
  }
  return false;
}

/** Neutral named colors, as a grey level (0 to 255). Any other name is a color of its own. */
const GREYS: Record<string, number> = { black: 0, dimgray: 105, dimgrey: 105, gray: 128, grey: 128, darkgray: 169, darkgrey: 169, silver: 192, lightgray: 211, lightgrey: 211, gainsboro: 220, whitesmoke: 245, white: 255 };

/**
 * A color as the mail wrote it ("#888", "rgb(17, 17, 17)", "white", a legacy attribute's "888"): none (transparent, a
 * keyword that names no color), a grey and how light it is (0 to 1), or a hue of its own.
 */
export function greyOf(value: string): { kind: "none" } | { kind: "grey"; light: number } | { kind: "hue" } {
  const v = value.trim().toLowerCase();
  if (!v || v === "transparent" || v === "inherit" || v === "initial" || v === "unset" || v === "currentcolor" || v === "none") return { kind: "none" };
  let rgb: number[] | null = null;
  let alpha = 1;
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (fn) {
    rgb = [fn[1], fn[2], fn[3]].map(Number);
    if (fn[4]) alpha = fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : Number(fn[4]);
  } else if (hex) {
    const h = hex[1]!.length <= 4 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (h.length === 8) alpha = parseInt(h.slice(6, 8), 16) / 255;
  } else if (v in GREYS) {
    rgb = [GREYS[v]!, GREYS[v]!, GREYS[v]!];
  }
  if (!rgb || rgb.some((n) => Number.isNaN(n))) return { kind: "hue" };
  if (alpha === 0) return { kind: "none" };
  const max = Math.max(...rgb), min = Math.min(...rgb);
  return max - min <= 24 ? { kind: "grey", light: (max + min) / 2 / 255 } : { kind: "hue" };
}

/** A grey this light or lighter behind the mail is just its page: a white page, not a design. */
const PAGE = 0.92;
/** Text greys in between are the mail's quiet text (a footer, a date); darker or lighter ones are its ink. */
const QUIET = [0.3, 0.8] as const;
const NO_IMAGE = new Set(["none", "initial", "unset", "inherit", "revert"]);
/** What marks quiet text in a simple mail: the theme gives it its own quiet ink. */
export const QUIET_ATTR = "data-terno-quiet";

/**
 * Plan 158: does the (already sanitized) mail have a design of its own? Then "Match theme" keeps its colors, on the light
 * paper card. A design is a surface or a hue: a background that isn't a white page (a color or a picture behind), or text
 * in a color that isn't a grey (a link's own color doesn't count: links take the theme's). A simple mail (black or grey
 * text on white, a newsletter written like a letter) takes the theme's colors, its grey text marked quiet (`html`).
 * Parsed into an inert document and read through each element's CSSStyleDeclaration, so quoting, shorthands and ordering
 * in style attributes don't matter. <style> blocks never get here: the sanitizer drops them, so their colors don't apply.
 */
export function mailDesign(cleanHtml: string): { designed: boolean; html: string } {
  // most mail names no color at all: no parse
  if (!/color|background|text=|bgcolor|<svg/i.test(cleanHtml)) return { designed: false, html: cleanHtml };
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${cleanHtml}</body>`, "text/html");
  // drawn art paints its own fills and strokes, which no color rule reaches: it keeps the page it was drawn on
  if (doc.body.querySelector("svg")) return { designed: true, html: cleanHtml };
  let quiet = false;
  for (const el of doc.body.querySelectorAll<HTMLElement>("*")) {
    const s = el.style;
    // a color the mail insists on (!important inline) outranks any sheet: such mail keeps its paper, where it reads as written
    if (s && ["color", "background-color", "background", "background-image"].some((p) => s.getPropertyPriority(p) === "important")) return { designed: true, html: cleanHtml };
    // the shorthand ("background:#fff") leaves its image "initial": a picture is only a real value
    if ((s?.backgroundImage && !NO_IMAGE.has(s.backgroundImage)) || el.hasAttribute("background") || s?.webkitTextFillColor) return { designed: true, html: cleanHtml };
    for (const bg of [el.getAttribute("bgcolor"), s?.backgroundColor]) {
      if (!bg) continue;
      const c = greyOf(bg);
      if (c.kind === "hue" || (c.kind === "grey" && c.light < PAGE)) return { designed: true, html: cleanHtml };
    }
    const ink = s?.color || el.getAttribute("color") || el.getAttribute("text");
    if (!ink || el.closest("a")) continue;
    const c = greyOf(ink);
    if (c.kind === "hue") return { designed: true, html: cleanHtml };
    if (c.kind === "grey" && c.light >= QUIET[0] && c.light <= QUIET[1]) {
      el.setAttribute(QUIET_ATTR, "");
      quiet = true;
    }
  }
  return { designed: false, html: quiet ? doc.body.innerHTML : cleanHtml };
}

exposeForTests({ mailDesign, hasRemoteContent });

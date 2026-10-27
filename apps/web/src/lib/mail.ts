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

/** Presentational attributes that set colors (<font color>, <td bgcolor>, <body text/link>…). */
const COLOR_ATTRS = ["bgcolor", "color", "text", "link", "vlink", "alink"];

/**
 * Does the (already sanitized) mail paint its own colors? Then it keeps them,
 * on the light paper card. Parsed into an inert document and read through
 * each element's CSSStyleDeclaration, so quoting, shorthands and ordering in
 * style attributes don't matter. <style> blocks never get here: the sanitizer
 * drops them, so their colors don't apply either.
 */
export function hasOwnColors(cleanHtml: string): boolean {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${cleanHtml}</body>`, "text/html");
  for (const el of doc.body.querySelectorAll<HTMLElement>("*")) {
    if (COLOR_ATTRS.some((a) => el.hasAttribute(a))) return true;
    const s = el.style;
    if (s && (s.color || s.backgroundColor || (s.backgroundImage && s.backgroundImage !== "none") || s.webkitTextFillColor)) return true;
  }
  return false;
}

exposeForTests({ hasOwnColors, hasRemoteContent });

/** Rules for rendering HTML mail, kept apart from the component (the CSP and remote checks are tested in Node, the color check in the browser). */
import { exposeForTests } from "~/lib/render-probe";

/**
 * Remote images load only once the user opts in (tracking pixels included);
 * remote CSS and fonts never (plan 35: images are what "Load content" and the
 * setting promise, in either mode).
 */
export function csp(allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  return `default-src 'none'; img-src data: cid:${remote}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; frame-src 'none'; form-action 'none'`;
}

const remoteRules = (scheme: string) => [
  new RegExp(`\\b(?:src|background|poster)\\s*=\\s*["']?\\s*${scheme}`, "i"),
  new RegExp(`url\\(\\s*["']?\\s*${scheme}`, "i"),
  // SVG pulls images through href too (an <a href> is a link, not a load)
  new RegExp(`<(?:image|use|feImage)\\b[^>]*?\\s(?:xlink:)?href\\s*=\\s*["']?\\s*${scheme}`, "i"),
];
const ABSOLUTE = remoteRules("https?:");
const WITH_PROTOCOL_RELATIVE = remoteRules("(?:https?:)?//");

/**
 * Would the mail load something from the web once allowed (so the reader
 * offers "Load content")? `//host/…` counts where it reaches the web: in the
 * browser; the desktop resolves it to app://, which never leaves the Mac.
 */
export function hasRemoteContent(html: string, protocolRelative = false): boolean {
  return (protocolRelative ? WITH_PROTOCOL_RELATIVE : ABSOLUTE).some((r) => r.test(html));
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

exposeForTests({ hasOwnColors });

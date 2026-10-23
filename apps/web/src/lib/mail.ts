/** Rules for rendering HTML mail, kept apart from the component (the CSP and remote checks are tested in Node, the color check in the browser). */
import { exposeForTests } from "~/lib/render-probe";

/** Remote resources are blocked unless the user opts in: tracking pixels, remote CSS and fonts included. */
export function csp(allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  return `default-src 'none'; img-src data: cid:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src 'none'; frame-src 'none'; form-action 'none'`;
}

export function hasRemoteContent(html: string): boolean {
  return /\b(src|background)\s*=\s*["']?\s*https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html);
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

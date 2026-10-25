/** Which links a draft may carry, and what a typed address becomes (plan 16 §6 Links). Pure. */

const SAFE = /^(https?:\/\/|mailto:)/i;
const EMAIL = /^[^\s@/:?#]+@[^\s@/:?#]+\.[^\s@/:?#]+$/;
// a host with a dot (or localhost), optionally a port and a path: "example.com", "docs.example.co.uk/a?b#c"
const BARE_HOST = /^(localhost|[\w-]+(\.[\w-]+)*\.[a-z][\w-]*)(:\d+)?([/?#]\S*)?$/i;

/** Is this href one a link in mail may point to? (http, https, mailto: nothing that runs or reads files) */
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (!SAFE.test(h)) return false;
  if (/^mailto:/i.test(h)) return h.length > 7;
  try {
    const u = new URL(h);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * What the user typed into the link field, as an href: a full http(s)/mailto
 * address as is, "example.com/x" → https://, "ana@example.com" → mailto:.
 * null: not something mail can link to (javascript:, data:, file:, words).
 */
export function normalizeHref(input: string): string | null {
  const v = input.trim();
  if (!v || /\s/.test(v)) return null;
  if (SAFE.test(v)) return isSafeHref(v) ? v : null;
  // a scheme we don't allow ("javascript:", "data:", "file:", "ftp:")
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[\w-]+(\.[\w-]+)+:\d/.test(v) && !/^localhost:\d/i.test(v)) return null;
  if (EMAIL.test(v)) return `mailto:${v}`;
  if (BARE_HOST.test(v)) {
    const href = `https://${v}`;
    return isSafeHref(href) ? href : null;
  }
  return null;
}

/** A URL typed or pasted on its own (the autolink and "paste a URL over a selection"): http(s) or www., whole string. */
export function urlIn(text: string): string | null {
  const v = text.trim();
  if (/^https?:\/\/\S+$/i.test(v)) return isSafeHref(v) ? v : null;
  if (/^www\.[\w-]+(\.[\w-]+)+\S*$/i.test(v)) return `https://${v}`;
  return null;
}

/** The text a link shows in the plain-text alternative's "text (url)": mailto: without its scheme. */
export const hrefLabel = (href: string): string => href.replace(/^mailto:/i, "");

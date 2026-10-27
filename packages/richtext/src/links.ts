/** Which links a draft may carry, and what a typed address becomes (plan 16 §6 Links). Pure. */

const SAFE = /^(https?:\/\/|mailto:)/i;
// dot-separated labels: a dot allowed on both sides of the literal one backtracked quadratically ("a@a.a.a…:")
const EMAIL = /^[^\s@/:?#]+@[^\s@/:?#.]+(?:\.[^\s@/:?#.]+)+$/;
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

/** A URL pasted on its own ("paste a URL over a selection", a URL pasted alone): what the whole text spells. */
export function urlIn(text: string): string | null {
  return spelledHref(text.trim());
}

// ── autolinks (plan 39): what a run of typed text spells, found in one linear pass

/** The longest text an autolink covers: a longer token spells nothing (bounded work per keystroke). */
export const MAX_URL_LENGTH = 8192;

/** What ends a token: whitespace (NBSP included), a non-text leaf (U+FFFC in textBetween), angle brackets and quotes. */
export function isDelimiter(c: number): boolean {
  if (c <= 0x20) return true;
  switch (c) {
    case 0x22: // "
    case 0x3c: // <
    case 0x3e: // >
    case 0x7f:
    case 0xa0:
    case 0xab: // «
    case 0xbb: // »
    case 0x1680:
    case 0x2018: // ‘
    case 0x2019: // ’
    case 0x201c: // “
    case 0x201d: // ”
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
    case 0xfeff:
    case 0xfffc:
      return true;
  }
  return c >= 0x2000 && c <= 0x200a;
}

const ALNUM = /[\p{L}\p{N}]/u;
const isAlnum = (ch: string) => ALNUM.test(ch);
/** what may not stand right before a URL in a word: "(https://…" and "*https://…" start one, "ahttps://…" and "x.www.…" don't */
const blocksStart = (ch: string) => isAlnum(ch) || "@./-+:#=&?%$".includes(ch);
/** punctuation that ends a sentence, never a URL's last character */
const TRAILING = ".,;:!?…";
/** emphasis and quote marks: a URL's last character unless the same mark stands right before it ("_https://x.com/a_" vs "https://x.com/user_") */
const WRAPPERS = "*_~'";
/** what may open around a link: brackets, wrappers, Spanish opening marks */
const OPENERS = `([{${WRAPPERS}¿¡`;

/**
 * The end of a URL starting at `start` once trailing punctuation is off: a
 * closing bracket stays while it closes one opened inside, a wrapper mark
 * goes when it closes one standing right before `start`.
 */
function trimEnd(s: string, start: number, end: number): number {
  let paren = 0;
  let square = 0;
  let curly = 0;
  for (let i = start; i < end; i++) {
    const ch = s[i];
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
  }
  // the wrapper marks right before the start (among opening brackets: "'(https://…)'"), by kind
  const open: Record<string, number> = {};
  for (let i = start - 1; i >= 0 && OPENERS.includes(s[i]!); i--) if (WRAPPERS.includes(s[i]!)) open[s[i]!] = (open[s[i]!] ?? 0) + 1;
  while (end > start) {
    const ch = s[end - 1]!;
    if (TRAILING.includes(ch)) end--;
    else if (open[ch]) {
      open[ch]--;
      end--;
    } else if (ch === ")" && paren < 0) {
      paren++;
      end--;
    } else if (ch === "]" && square < 0) {
      square++;
      end--;
    } else if (ch === "}" && curly < 0) {
      curly++;
      end--;
    } else break;
  }
  return end;
}

/** A host label: letters, digits and inner hyphens. */
function isLabel(l: string): boolean {
  if (l.length === 0 || l.length > 63 || l[0] === "-" || l[l.length - 1] === "-") return false;
  for (const ch of l) if (ch !== "-" && !isAlnum(ch)) return false;
  return true;
}

/** "a.b.tld": two labels or more, the last one two characters or more with a letter (not an IP's last number). */
function isDomain(host: string): boolean {
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every(isLabel)) return false;
  const tld = labels[labels.length - 1]!;
  return tld.length >= 2 && /\p{L}/u.test(tld);
}

/** An address: local@domain.tld (the common forms; not quoted local parts or IP literals). */
export function isEmailAddress(s: string): boolean {
  const at = s.indexOf("@");
  if (at <= 0 || at > 64 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  if (local[0] === "." || local[local.length - 1] === "." || local.includes("..")) return false;
  for (const ch of local) if (!isAlnum(ch) && !"._%+-".includes(ch)) return false;
  return isDomain(s.slice(at + 1));
}

/** The host after an http(s) scheme (userinfo and port around it) has a letter or digit in it. */
function hasHost(s: string, from: number, end: number): boolean {
  let stop = end;
  for (let i = from; i < end; i++) {
    const ch = s[i];
    if (ch === "/" || ch === "?" || ch === "#") {
      stop = i;
      break;
    }
  }
  const authority = s.slice(from, stop);
  for (const ch of authority.slice(authority.lastIndexOf("@") + 1)) if (isAlnum(ch)) return true;
  return false;
}

const startsAt = (s: string, i: number, prefix: string) => s.length - i >= prefix.length && s.slice(i, i + prefix.length).toLowerCase() === prefix;

/** The scheme a URL starts with at i: "https://", "http://", "www." or "mailto:" (any case), else null. */
function schemeAt(s: string, i: number): string | null {
  const c = s.charCodeAt(i) | 0x20;
  if (c === 0x68) return startsAt(s, i, "https://") ? "https://" : startsAt(s, i, "http://") ? "http://" : null;
  if (c === 0x77) return startsAt(s, i, "www.") ? "www." : null;
  if (c === 0x6d) return startsAt(s, i, "mailto:") ? "mailto:" : null;
  return null;
}

export interface FoundLink {
  /** where the link starts and ends in the text searched */
  start: number;
  end: number;
  href: string;
}

/**
 * The link a token spells (a run of text between delimiters, see isDelimiter):
 * from the first http(s)://, www. or mailto: that starts a word in it to the
 * token's end, less trailing punctuation; else the address it is once its
 * wrapping punctuation is off. The href is the text as typed (www. gets
 * https://), so what the reader sees is where it goes. One pass, and only the
 * first candidate is checked: hostile text ("www.www.…", "a@a@…") stays linear.
 */
export function linkIn(token: string): FoundLink | null {
  const n = token.length;
  if (n === 0 || n > MAX_URL_LENGTH) return null;
  for (let i = 0; i < n; i++) {
    const scheme = schemeAt(token, i);
    if (!scheme || (i > 0 && blocksStart(token[i - 1]!))) continue;
    const after = i + scheme.length;
    const end = trimEnd(token, i, n);
    if (end <= after) return null;
    const text = token.slice(i, end);
    if (scheme === "www.") {
      const host = /^[^/?#:]*/.exec(text)![0];
      const href = `https://${text}`;
      // a domain after the www. ("www.santo" is a word, "www.santo.com" a site)
      return isDomain(host.slice(4)) && isSafeHref(href) ? { start: i, end, href } : null;
    }
    if (scheme === "mailto:") return isEmailAddress(token.slice(after, end).split("?")[0]!) ? { start: i, end, href: text } : null;
    return hasHost(token, after, end) && isSafeHref(text) ? { start: i, end, href: text } : null;
  }
  // an address, without the punctuation around it: "(ana@x.com)."
  const at = token.indexOf("@");
  if (at < 0) return null;
  let start = 0;
  while (start < at && OPENERS.includes(token[start]!)) start++;
  const end = trimEnd(token, start, n);
  const address = token.slice(start, end);
  return end > at && isEmailAddress(address) ? { start, end, href: `mailto:${address}` } : null;
}

/** The href when the whole text is one link an autolink would make (no delimiter in it, nothing around it), else null. */
export function spelledHref(text: string): string | null {
  const n = text.length;
  if (n === 0 || n > MAX_URL_LENGTH) return null;
  for (let i = 0; i < n; i++) if (isDelimiter(text.charCodeAt(i))) return null;
  const found = linkIn(text);
  return found && found.start === 0 && found.end === n ? found.href : null;
}

/** Every link in a line of text, in order (a pasted plain text): tokens between delimiters, one link at most in each. */
export function linksIn(line: string): FoundLink[] {
  const out: FoundLink[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && isDelimiter(line.charCodeAt(i))) i++;
    const start = i;
    while (i < n && !isDelimiter(line.charCodeAt(i))) i++;
    const found = i > start ? linkIn(line.slice(start, i)) : null;
    if (found) out.push({ start: start + found.start, end: start + found.end, href: found.href });
  }
  return out;
}

/** The text a link shows in the plain-text alternative's "text (url)": mailto: without its scheme. */
export const hrefLabel = (href: string): string => href.replace(/^mailto:/i, "");

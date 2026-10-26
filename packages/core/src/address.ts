import { decodeEncodedWords, MOJIBAKE, repairMojibake, repairOrphans } from "./encoded-words";
import type { Address } from "./types";

/**
 * Addresses (plan 29): one lenient RFC 5322 reader for what people type and
 * for what other clients write in headers, a repair for what they get wrong
 * (or what an older parser stored), and the writer. Everything is one pass
 * over the text (no backtracking regexes on it): thousands of recipients in
 * a header cost what they weigh.
 */

/** RFC 5322 specials, and `=?` (a receiving client would decode it as an encoded word): a name with any of them is quoted. */
const NEEDS_QUOTES = /[",;<>@()[\]:\\.]|=\?/;
/** Never in a name or an address that goes out: controls, bidi embeddings/overrides/isolates and marks, zero-width spaces, BOM. ZWJ/ZWNJ stay (emoji, Persian, Indic). */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what must go
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}\u{FEFF}]/gu;

/** Recipients per field a draft keeps and a send takes (plan 29: a reply-all to hundreds must save; Gmail allows 500, Workspace 2,000). */
export const MAX_RECIPIENTS = 1000;

/** What can't be in an address: an entry holding one isn't an address, and is written as one quoted string. */
const NOT_AN_ADDRESS = /[\s,;<>"()\\]/;
const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Formats one address; display names with specials are quoted so they can't
 * become extra recipients. An entry that isn't an address ("a@x.com, b@x.com"
 * typed inside quotes, "esto no es un correo") is written as one quoted
 * string: read back, it is the same single entry, never something sendable
 * it wasn't (Codex review 2).
 */
export function formatAddress(a: Address): string {
  const email = a.email.replace(INVISIBLE, "").trim();
  const name = a.name.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  const whole = () => quoted(name ? `${name} ${email}` : email);
  if (NOT_AN_ADDRESS.test(email)) return whole();
  const text = !name ? email : `${NEEDS_QUOTES.test(name) ? quoted(name) : name} <${email}>`;
  if (isValidEmail(email)) return text;
  // not an address ("a:b@x.com", "bob@"): written plainly only when it reads back as itself (a group's ":" or a
  // mailto: wouldn't), else as one quoted entry (Codex code review 3)
  const back = parseAddressList(text);
  return back.length === 1 && back[0]!.email === email && back[0]!.name === name ? text : whole();
}

export function formatAddressList(list: readonly Address[]): string {
  return list.map(formatAddress).join(", ");
}

// ───────────────────────────── reading ─────────────────────────────

/**
 * The list split at its top-level separators (`,` `;`, and a line break in
 * typed text), never inside quotes, comments, angle or square brackets. A
 * group's `name:` and a `mailto:` prefix are dropped (the group's members
 * stay). An opener that is never closed (`"Unbalanced <u@x>, b@x`) is read
 * as nothing and the list split again, so it can't swallow what follows.
 */
function splitList(input: string, typed: boolean): string[] {
  let text = input;
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = scanList(text, typed, false);
    if (r.unclosed < 0) return r.parts;
    text = text.slice(0, r.unclosed) + text.slice(r.unclosed + 1);
  }
  return scanList(text, typed, true).parts;
}

/** A complete encoded word starting exactly here (Q text may hold spaces and specials: it is opaque). */
const WORD_AT = /=\?[^?\s]+\?[QqBb]\?[^?]*\?=/y;

function scanList(text: string, typed: boolean, literal: boolean): { parts: string[]; unclosed: number } {
  // header text (not typed): encoded words are opaque
  const opaque = !typed;
  const parts: string[] = [];
  let start = 0;
  let quote = -1;
  let paren = 0;
  let parenAt = -1;
  let angle = 0;
  let angleAt = -1;
  let square = -1;
  const cut = (end: number) => {
    const p = text.slice(start, end).trim();
    if (p) parts.push(p);
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!literal) {
      if (opaque && ch === "=" && quote < 0 && paren === 0 && angle === 0) {
        // an encoded word is one opaque word: nothing in it separates or brackets (Codex code review 1)
        WORD_AT.lastIndex = i;
        const m = WORD_AT.exec(text);
        if (m) {
          i += m[0].length - 1;
          continue;
        }
      }
      if (quote >= 0) {
        if (ch === "\\") i++;
        else if (ch === '"') quote = -1;
        continue;
      }
      if (paren > 0) {
        if (ch === "\\") i++;
        else if (ch === "(") paren++;
        else if (ch === ")") paren--;
        continue;
      }
      if (angle > 0) {
        if (ch === "<") angle++;
        else if (ch === ">") angle--;
        continue;
      }
      if (square >= 0) {
        if (ch === "]") square = -1;
        continue;
      }
      if (ch === '"') {
        quote = i;
        continue;
      }
      if (ch === "(") {
        paren = 1;
        parenAt = i;
        continue;
      }
      if (ch === "<") {
        angle = 1;
        angleAt = i;
        continue;
      }
      if (ch === "[") {
        square = i;
        continue;
      }
    }
    if (ch === "," || ch === ";" || (typed && (ch === "\n" || ch === "\r"))) cut(i);
    else if (ch === ":" && !literal) {
      // a group's display name, or a mailto: prefix (never inside a mailbox: an address has no bare ":")
      const head = text.slice(start, i);
      if (!head.includes("@")) start = i + 1;
    }
  }
  cut(text.length);
  const unclosed = quote >= 0 ? quote : paren > 0 ? parenAt : angle > 0 ? angleAt : square;
  return { parts, unclosed: literal ? -1 : unclosed };
}

type Token = { kind: "word" | "quoted" | "comment" | "angle"; text: string; encoded?: boolean };

/**
 * One part's tokens: words, quoted strings (unescaped), comments (nested),
 * angle addresses (nested brackets dropped). With `opaque` (header text) an
 * encoded word is one word whatever it holds: its `<`, `@` and `,` are text,
 * never structure (the Mailsploit class).
 */
function tokens(part: string, opaque: boolean): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = part.length;
  while (i < n) {
    const ch = part[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
    } else if (ch === '"') {
      let s = "";
      for (i++; i < n && part[i] !== '"'; i++) s += part[i] === "\\" && i + 1 < n ? part[++i] : part[i];
      i++;
      out.push({ kind: "quoted", text: s });
    } else if (ch === "(") {
      let depth = 1;
      let s = "";
      for (i++; i < n && depth > 0; i++) {
        const c = part[i]!;
        if (c === "\\" && i + 1 < n) s += part[++i];
        else if (c === "(") {
          depth++;
          s += c;
        }
        else if (c === ")") {
          if (--depth > 0) s += c;
        } else s += c;
      }
      out.push({ kind: "comment", text: s });
    } else if (ch === "<") {
      let depth = 1;
      let s = "";
      for (i++; i < n && depth > 0; i++) {
        const c = part[i]!;
        if (c === "<") depth++;
        else if (c === ">") depth--;
        else s += c;
      }
      out.push({ kind: "angle", text: s });
    } else if (ch === ">") {
      i++;
    } else {
      let s = "";
      let encoded = false;
      while (i < n) {
        if (opaque && part[i] === "=") {
          WORD_AT.lastIndex = i;
          const m = WORD_AT.exec(part);
          if (m) {
            s += m[0];
            i += m[0].length;
            encoded = true;
            continue;
          }
        }
        if (' \t\r\n"(<>'.includes(part[i]!)) break;
        s += part[i++];
      }
      out.push({ kind: "word", text: s, ...(encoded ? { encoded } : {}) });
    }
  }
  return out;
}

/** An address as written inside or outside brackets: `mailto:`, a source route, quotes and stray punctuation around it dropped. */
function bareAddress(text: string): string {
  return text
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/^(@[^:]*:)/, "")
    // only a matching pair wraps it: a lone apostrophe is part of a valid local part ('support@x, o'brien@x)
    .replace(/^(['"])(.*)\1$/, "$2")
    .replace(/[.,;>]+$/, "");
}

/**
 * The mailboxes in one part. A phrase then `<addr>` (several in a row when a
 * comma is missing); a bare address, its comment as the name; `Name Words
 * addr@x` without brackets. Encoded words are decoded only here, in a phrase
 * or a comment already known to be one (`decode`: header text, not typed).
 * What has no address left: `{ email: "" }` with its text as the name.
 */
function mailboxes(part: string, decode: boolean): Address[] {
  const out: Address[] = [];
  let phrase: Token[] = [];
  /** the tokens' text (comments in parentheses when `parens`), decoded in a header */
  const text = (list: Token[], parens: boolean) => {
    const raw = list.map((t) => (parens && t.kind === "comment" ? `(${t.text})` : t.text)).join(" ").trim();
    // an address an encoded word spells out is never structure, nor evidence of a swallowed list: decoded without its
    // brackets, whatever else the name holds literally (plan review 1, code review 2)
    return decode ? decodeEncodedWords(raw, neutralize).replace(/\s+([,;])/g, "$1").trim() : raw;
  };
  const words = (list: Token[]) => list.filter((p) => p.kind !== "comment");
  for (const t of tokens(part, decode)) {
    if (t.kind === "angle" || (t.kind === "word" && !t.encoded && t.text.includes("@") && !t.text.startsWith("["))) {
      // `Ana (Acme) <a@x>` keeps its comment; `(Jane Doe) jane@x`: the comment is the name
      const named = words(phrase).length > 0;
      out.push({ name: named ? text(t.kind === "angle" ? phrase : words(phrase), true) : text(phrase, false), email: bareAddress(t.text) });
      phrase = [];
      continue;
    }
    phrase.push(t);
  }
  if (phrase.length) {
    const last = out[out.length - 1];
    if (last && !words(phrase).length) {
      // `jane@x (Jane Doe)`, `Ann <ann@x> (work)`: a trailing comment names an address that has no name
      if (!last.name) last.name = text(phrase, false);
    } else if (words(phrase).length) {
      out.push({ name: text(phrase, true), email: "" });
    }
  }
  return out;
}

/** What an encoded word decodes to, as display text only: no bracketed address, no bracket. */
const neutralize = (s: string) => s.replace(/\s*<[^<>]*>\s*/g, " ").replace(/[<>]/g, "");

/**
 * Every entry of a list as written: `{ email: "" }` where a part had no
 * address. Typed text keeps a part that yields nothing as an entry of its own
 * (`(bob@x.com)` alone is an entry to fix, never silently gone: code review 4).
 */
function entries(input: string, decode: boolean, typed: boolean): Address[] {
  const text = decode ? input.replace(/\r?\n[ \t]+/g, " ") : input;
  return splitList(text, typed).flatMap((p) => {
    const found = mailboxes(p, decode);
    return found.length || !typed ? found : [{ name: p, email: "" }];
  });
}

/**
 * Reads what was typed or pasted into a recipient field: "Ana <ana@x.com>,
 * \"Pérez, Luis\" <l@y.com>; bob@z.com", "Ana Torres ana@x.com",
 * "a@x.com b@y.com". Separators inside quotes or brackets don't split, so a
 * display name containing commas or addresses stays a single recipient.
 * Anything without an address stays as an entry with its text as the email
 * (an unfinished "bob" or "bob@" is never dropped: it shows, and Send says
 * what's wrong with it).
 */
export function parseAddressList(input: string): Address[] {
  return entries(input, false, true).map((a) => (a.email ? a : { name: "", email: a.name }));
}

/**
 * Reads a header's address list (From, To, Cc, Bcc, Reply-To) as other
 * clients write it, and repairs it (repairAddresses). `single`: a header that
 * names one author (From): never split, its first address.
 */
export function parseAddressHeader(value: string, opts: { single?: boolean; split?: boolean } = {}): Address[] {
  const list = repairAddresses(entries(value, true, false), { split: !opts.single && opts.split !== false });
  return opts.single ? list.slice(0, 1) : list;
}

// ───────────────────────────── validity ─────────────────────────────

const LOCAL = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const LABEL = /^[\p{L}\p{N}_](?:[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}_])?$/u;

/**
 * An address mail can be sent to: a dot-atom local part (≤ 64), a domain of
 * at least two labels (≤ 253, Unicode allowed: it goes out as punycode),
 * the last not all digits. Quoted local parts and IP literals aren't taken.
 */
export function isValidEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at > 64 || email.length > 320) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!LOCAL.test(local) || domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1]!)) return false;
  return labels.every((l) => l.length <= 63 && LABEL.test(l));
}

/** The address with a Unicode domain as punycode (what goes out on the wire); unchanged when it is ASCII or can't be converted. */
export function asciiEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const domain = email.slice(at + 1);
  if (at < 0 || !/[^\p{ASCII}]/u.test(domain)) return email;
  try {
    return `${email.slice(0, at)}@${new URL(`http://${domain}`).hostname}`;
  } catch {
    return email;
  }
}

/** Addresses that usually don't take replies (plan 18 marks the same in suggestions). */
const NO_REPLY_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([-+._].*)?$|^noreply/i;
export const isNoReply = (email: string): boolean => NO_REPLY_LOCAL.test(email.slice(0, Math.max(0, email.lastIndexOf("@"))));

// ───────────────────────────── repair ─────────────────────────────

/** Anything in a name that needs a closer look; most names have none of it. */
// oxlint-disable-next-line no-control-regex -- control characters are among what is looked for
const SUSPECT_NAME = /[<>"'“”‘’«»„\\[\]=?@()\u0000-\u001f\u007f-\u009f\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}\u{FEFF}]|^\s|\s$|\s\s/u;
const PLAIN_EMAIL = /^[^\s<>"'@:()[\],;]+@[^\s<>"'@:()[\],;]+\.[^\s<>"'@:()[\],;.]+$/;
const ANGLED = /<([^<>\s]+@[^<>\s]+)>/;
const QUOTE_PAIRS: [string, string][] = [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["«", "»"], ["„", "“"], ["„", "”"], ["”", "”"]];

/** A display name longer than this is cut, after any recovery (Codex review 7). */
const NAME_MAX = 256;

/** A display name as it should show: encoded words and their broken halves decoded, mojibake undone, invisible characters and wrapping quotes gone. */
export function cleanName(raw: string, cap = NAME_MAX): string {
  let s = raw;
  if (s.includes("=?") || s.includes("?=")) s = repairOrphans(decodeEncodedWords(s, neutralize));
  if (MOJIBAKE.test(s)) s = repairMojibake(s);
  s = s
    .replace(INVISIBLE, " ")
    .replace(/\s*\[mailto:[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let round = 0; round < 2; round++) {
    const pair = QUOTE_PAIRS.find(([open, close]) => s.length >= 2 && s.startsWith(open) && s.endsWith(close));
    if (!pair) break;
    s = s.slice(pair[0].length, -pair[1].length).trim();
    if (pair[0] === '"') s = s.replace(/\\(.)/g, "$1");
  }
  return s.length > cap ? s.slice(0, cap).trim() : s;
}

/** An address cleaned of what clients wrap it in: `mailto:`, a source route, brackets, quotes, trailing dots. */
const cleanEmail = (raw: string): string => {
  const e = raw.replace(INVISIBLE, "").trim();
  // an address that is valid as stored is kept exactly: repair never redirects a working mailbox (reconciliation review 2)
  return isValidEmail(e) ? e : bareAddress(e).replace(/\.+$/, "");
};

/** A name that says nothing beyond the address (or claims a different one): dropped, so the address shows (once, and truthfully). Capped. */
function nameFor(full: string, email: string): string {
  const name = full.length > NAME_MAX ? full.slice(0, NAME_MAX).trim() : full;
  if (!name || name.toLowerCase() === email.toLowerCase() || isValidEmail(name)) return "";
  return name;
}

function repairOne(a: Address, split: boolean): Address[] {
  let email = cleanEmail(a.email);
  let name = a.name;
  if (!isValidEmail(email) && /[\s<>"]/.test(a.email)) {
    // a phrase swallowed into the address by an earlier parser (`"luis medina <lmedina"@sucre.net>`): read it again
    const again = entries(a.email.replace(/"/g, ""), false, false).filter((x) => isValidEmail(cleanEmail(x.email)));
    if (again.length === 1) {
      email = cleanEmail(again[0]!.email);
      name = name || again[0]!.name;
    } else if (again.length > 1) return again.flatMap((x) => repairOne(x, false));
  }
  name = cleanName(name, Infinity);
  const angled = ANGLED.exec(name);
  if (angled && isValidEmail(cleanEmail(angled[1]!))) {
    // a recipient list swallowed into a display name (a client's mangled quoting): a separator outside any
    // brackets is the evidence; recovered addresses are ones this header already names, each shown as its own chip
    if (split && /[,;]/.test(name.replace(/<[^<>]*>/g, ""))) {
      return entries(`${name} <${email}>`, false, false).map((x) => {
        const e = cleanEmail(x.email);
        return { name: nameFor(cleanName(x.name, Infinity), e), email: e };
      });
    }
    // otherwise (`"Bob <bob@x>" <bob2@x>`, or a From): the bracketed address goes from the name, never becomes the address
    name = name.replace(/\s*<[^<>]*>\s*/g, " ").replace(/\s+([,;])/g, "$1").trim();
  }
  return [{ name: nameFor(name, email), email }];
}

/**
 * Addresses as other clients (or an older parser) left them, made right:
 * cleaned names and addresses (cleanName, `mailto:`, brackets, trailing
 * dots), and with `split` (To, Cc, Bcc, Reply-To; never a From) a list a
 * mangled display name swallowed read back out of it. A name that merely
 * mentions an address ("leak@x.example, Support") is never split: only a
 * bracketed address and a separator outside brackets are evidence.
 * Duplicates go (case-insensitive; the first place kept, a later name
 * filling an empty one), as do entries with no address at all. Idempotent.
 */
export function repairAddresses(list: readonly Address[], opts: { split?: boolean } = {}): Address[] {
  const split = opts.split ?? true;
  const out: Address[] = [];
  const at = new Map<string, number>();
  const add = (a: Address) => {
    if (!a.email) return;
    const key = a.email.toLowerCase();
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, out.length);
      out.push(a);
    } else if (!out[i]!.name && a.name) out[i] = { ...out[i]!, name: a.name };
  };
  for (const a of list) {
    if (a.name.length <= NAME_MAX && !SUSPECT_NAME.test(a.name) && !MOJIBAKE.test(a.name) && PLAIN_EMAIL.test(a.email)) add(a);
    else for (const r of repairOne(a, split)) add(r);
  }
  return out;
}

/** One address (a From): cleaned, never split. */
export function repairAddress(a: Address): Address {
  return repairAddresses([a], { split: false })[0] ?? { name: cleanName(a.name), email: a.email.trim() };
}

/** A From name as a list shows it: cleaned (only when it looks wrong; the list's hot path pays one regex test). */
export function cleanFromName(name: string | null | undefined): string {
  if (!name) return "";
  return name.length > NAME_MAX || SUSPECT_NAME.test(name) || MOJIBAKE.test(name) ? cleanName(name) : name;
}

/**
 * A stored message's addresses as they are shown and replied to (plan 29):
 * repaired at read time, so mail stored by an older parser reads right
 * everywhere without a backfill. Reply-To is absent when not known.
 */
export function storedAddresses(m: { from_name: string; from_email: string; to_json: string; cc_json: string; reply_to_json?: string | null }): { from: Address; replyTo: Address[]; to: Address[]; cc: Address[] } {
  const from = { name: m.from_name, email: m.from_email };
  return {
    from: SUSPECT_NAME.test(from.name) || MOJIBAKE.test(from.name) || from.name.length > NAME_MAX ? { ...repairAddress(from), email: from.email } : from,
    // plan 27's column ('[]' when the message has none or was stored before it; an IDB row before version 5 lacks it)
    // never split: Reply-To is where a plain reply goes, so a display name never adds a destination there (reconciliation review 1)
    replyTo: repairAddresses(JSON.parse(m.reply_to_json ?? "[]") as Address[], { split: false }),
    to: repairAddresses(JSON.parse(m.to_json) as Address[]),
    cc: repairAddresses(JSON.parse(m.cc_json) as Address[]),
  };
}

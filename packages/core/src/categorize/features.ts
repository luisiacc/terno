import { tokenize } from "../rules/evaluate";
import { normalizeText } from "../text";

/** Bump when the featurization changes: stored examples and snapshots are rebuilt. */
export const FEATURES_V = 1;

/** Shared consumer domains say nothing about who the sender is. */
export const CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
]);

export const INTENTS = ["amount", "invoice", "tracking", "unsubscribe", "calendar", "otp", "travel", "replied", "pdf", "bulk", "consumer"] as const;
export type Intent = (typeof INTENTS)[number];

/** What the featurizer reads from a thread: its root inbound message plus two thread facts. */
export interface FeatureSource {
  fromEmail: string;
  fromName: string;
  listId: string | null;
  subject: string;
  bodyText: string | null;
  /** the user sent a message in this thread */
  replied: boolean;
  attachmentNames: readonly string[];
}

export interface FeatureContext {
  /** domains of the user's own accounts (coworkers share them) */
  ownDomains: ReadonlySet<string>;
}

export interface ThreadFeatures {
  v: number;
  sender: string;
  list: string | null;
  /** null for consumer and own domains */
  domain: string | null;
  /** the sender's domain even when it is not a feature (look-alike checks) */
  rawDomain: string;
  /** normalized display name */
  name: string;
  /** "s:" subject and "b:" body tokens, deduplicated, at most MAX_TOKENS */
  tokens: string[];
  intents: Intent[];
}

export const MAX_TOKENS = 120;
const BODY_BYTES = 2048;
const MAX_TOKEN_LENGTH = 32;

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    // es
    "a al algo algun alguna algunas alguno algunos ante antes aqui asi aun cada como con contra cual cuando de del desde donde dos el ella ellas ellos en entre era es esa esas ese eso esos esta estaba estado estan estar este esto estos fue fueron ha habia han hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o os otra otro para pero poco por porque que quien se sea segun ser si sido sin sobre solo son su sus tambien te tiene tienen todo todos tu tus un una uno unos usted ustedes va vamos ya yo hola gracias saludos re rv fw fwd reenv " +
    // en
    "about after all also an and any are as at be been before but by can could did do does for from had has have he her here him his how i if in into is it its just me more my no not now of on or our out over she so some than that the their them then there these they this to too up us was we were what when which who will with would you your hi hello thanks regards dear best"
  ).split(" "),
);

// Quoted replies repeat the previous message: only what this message adds counts.
const QUOTE_HEADER = /^(el .{0,120} escribi[oó]:|on .{0,120} wrote:|-{2,} ?(mensaje (original|reenviado)|original message|forwarded message) ?-{2,})/im;

/** The body text a message contributes: first 2 KB, quoted lines and replied-to history removed. */
export function ownBodyText(body: string | null): string {
  if (!body) return "";
  const head = body.length > BODY_BYTES * 2 ? body.slice(0, BODY_BYTES * 2) : body;
  const cut = QUOTE_HEADER.exec(head);
  const own = (cut ? head.slice(0, cut.index) : head)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  return own.length > BODY_BYTES ? own.slice(0, BODY_BYTES) : own;
}

/**
 * Text made only of Latin letters, digits, combining marks and common
 * punctuation: removing every combining mark after NFD is then exactly the
 * Latin-only diacritic folding unicode61 does, without the per-character
 * script checks of tokenize() (the slow part on 2 KB bodies). Anything else
 * (other scripts, emoji, superscripts, ª/º) takes the general path.
 */
function isLatinText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c >= 0xa0 && c <= 0x24f) {
      // ª º (letters), superscript digits, µ and fractions are tokens or digits elsewhere: general path
      if (c === 0xaa || c === 0xb2 || c === 0xb3 || c === 0xb5 || c === 0xb9 || c === 0xba || (c >= 0xbc && c <= 0xbe) || c === 0xd7 || c === 0xf7) return false;
      continue;
    }
    // Latin Extended Additional, combining marks, general punctuation, euro sign
    if ((c >= 0x1e00 && c <= 0x1eff) || (c >= 0x300 && c <= 0x36f) || (c >= 0x2000 && c <= 0x206f) || c === 0x20ac) continue;
    return false;
  }
  return true;
}
const MARKS = /[\u0300-\u036f]/g;
const LATIN_WORD = /[a-z0-9\u00df-\u00f6\u00f8-\u00ff\u0100-\u024f\u1e00-\u1eff]+/g;

/** Lowercased, Latin-folded text, or null when it needs the general tokenizer. */
function foldLatin(text: string): string | null {
  return isLatinText(text) ? text.normalize("NFD").replace(MARKS, "").toLowerCase() : null;
}

/** A token as a content feature: stopwords and single letters dropped, numbers bucketed. */
function contentForm(t: string): string | null {
  const len = t.length;
  if (len > MAX_TOKEN_LENGTH) return null;
  let digits = 0;
  for (let i = 0; i < len; i++) {
    const c = t.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
  }
  if (digits === len) return len <= 3 ? "#n" : "#n4";
  if (digits > 0) return "#a";
  return len > 1 && !STOPWORDS.has(t) ? t : null;
}

/** Content tokens: FTS-parity tokens minus stopwords, with numbers bucketed so ids don't explode the vocabulary. */
export function contentTokens(text: string): string[] {
  const folded = foldLatin(text);
  const words = folded !== null ? (folded.match(LATIN_WORD) ?? []) : tokenize(text);
  const out: string[] = [];
  for (const t of words) {
    const w = contentForm(t);
    if (w !== null) out.push(w);
  }
  return out;
}

const AMOUNT = /[$€£]\s?\d|\b\d[\d.,]*[.,]\d{2}\b|\b(mxn|usd|eur)\b/;
/** Single-word intent keywords (folded), looked up while walking the tokens. */
const KEYWORDS = new Map<string, Intent>([
  ...["factura", "facturas", "facturacion", "cfdi", "recibo", "recibos", "receipt", "invoice", "comprobante"].map((w) => [w, "invoice"] as const),
  ...["guia", "rastrea", "rastrearlo", "rastreo", "tracking", "seguimiento", "shipped", "entregado", "paquete"].map((w) => [w, "tracking"] as const),
  ...["unsubscribe"].map((w) => [w, "unsubscribe"] as const),
  ...["invitacion", "invitation", "calendar", "calendario", "evento"].map((w) => [w, "calendar"] as const),
  ...["otp"].map((w) => [w, "otp"] as const),
  ...["vuelo", "vuelos", "flight", "reservacion", "booking", "aeropuerto", "airport", "boarding", "itinerario", "hospedaje"].map((w) => [w, "travel"] as const),
]);
/** Multi-word intents, checked only when their last word comes up. */
const PHRASES = new Map<string, [string, Intent][]>();
for (const [phrase, intent] of [
  ["estado de cuenta", "invoice"],
  ["track your", "tracking"],
  ["en camino", "tracking"],
  ["darse de baja", "unsubscribe"],
  ["dar de baja", "unsubscribe"],
  ["cancelar suscripcion", "unsubscribe"],
  ["cancelar la suscripcion", "unsubscribe"],
  ["codigo de verificacion", "otp"],
  ["codigo de seguridad", "otp"],
  ["codigo de acceso", "otp"],
  ["verification code", "otp"],
  ["one time code", "otp"],
  ["one time password", "otp"],
  ["pase de abordar", "travel"],
  ["check in", "travel"],
] as const) {
  const last = phrase.slice(phrase.lastIndexOf(" ") + 1);
  PHRASES.set(last, [...(PHRASES.get(last) ?? []), [phrase, intent]]);
}
const WEEKDAY = /@ (lun|mar|mie|jue|vie|sab|dom|mon|tue|wed|thu|fri)\b/;

const BULK_LOCAL = /^(no-?reply|noreply|do-?not-?reply|notifications?|notificaciones|alertas?|automated|mailer|newsletter|boletin|news|info|updates|marketing|promo(ciones)?)\b/;

function normalizeName(name: string): string {
  const folded = foldLatin(name);
  return (folded !== null ? (folded.match(LATIN_WORD) ?? []) : tokenize(name)).join(" ");
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}

/** Pure and deterministic: the same source always yields the same features. */
export function extractFeatures(src: FeatureSource, ctx: FeatureContext): ThreadFeatures {
  const sender = normalizeText(src.fromEmail.trim());
  const rawDomain = domainOf(sender);
  const consumer = CONSUMER_DOMAINS.has(rawDomain);
  const domain = rawDomain && !consumer && !ctx.ownDomains.has(rawDomain) ? rawDomain : null;
  const list = src.listId ? normalizeText(src.listId.trim()) : null;
  const body = ownBodyText(src.bodyText);

  const tokens: string[] = [];
  const seen = new Set<string>();
  const found = new Set<Intent>();
  // one walk over the words: content features (until the cap) and keyword intents (all words)
  const walk = (raw: string, folded: string | null, prefix: string) => {
    const words = folded !== null ? (folded.match(LATIN_WORD) ?? []) : tokenize(raw);
    for (let i = 0; i < words.length; i++) {
      const t = words[i]!;
      const intent = KEYWORDS.get(t);
      if (intent) found.add(intent);
      const phrases = PHRASES.get(t);
      if (phrases) {
        for (const [phrase, it] of phrases) {
          const n = phrase.split(" ").length;
          if (i + 1 >= n && words.slice(i + 1 - n, i + 1).join(" ") === phrase) found.add(it);
        }
      }
      if (tokens.length >= MAX_TOKENS) continue;
      const w = contentForm(t);
      if (w === null) continue;
      const key = prefix + w;
      if (!seen.has(key)) {
        seen.add(key);
        tokens.push(key);
      }
    }
  };
  const foldedSubject = foldLatin(src.subject);
  const foldedBody = foldLatin(body);
  walk(src.subject, foldedSubject, "s:");
  walk(body, foldedBody, "b:");
  const text = `${foldedSubject ?? normalizeText(src.subject)}\n${foldedBody ?? normalizeText(body)}`;
  if (AMOUNT.test(text)) found.add("amount");
  if (WEEKDAY.test(text)) found.add("calendar");
  const intents = INTENTS.filter((i) => found.has(i));
  if (src.replied) intents.push("replied");
  if (src.attachmentNames.some((n) => /\.pdf$/i.test(n))) intents.push("pdf");
  if (list || BULK_LOCAL.test(sender)) intents.push("bulk");
  if (consumer) intents.push("consumer");

  return { v: FEATURES_V, sender, list, domain, rawDomain, name: normalizeName(src.fromName), tokens, intents };
}

/**
 * Word n-grams (n ≤ 3) of a normalized display name, the full name first:
 * "bbva seguridad" contains the trained "bbva". Short grams ("ana") match too
 * much to mean anything, so names and grams under 4 characters are skipped.
 */
export function nameGrams(name: string): string[] {
  if (name.length < 4) return [];
  const words = name.split(" ").filter(Boolean);
  const grams = new Set<string>([name]);
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n).join(" ");
      if (g.length >= 4) grams.add(g);
    }
  }
  return [...grams].slice(0, 12);
}

/** 32-bit FNV-1a; 0 is reserved for "absent". */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

export const featureKey = {
  sender: (email: string) => `from:${email}`,
  list: (id: string) => `list:${id}`,
  domain: (d: string) => `dom:${d}`,
  rawDomain: (d: string) => `rawdom:${d}`,
  name: (n: string) => `name:${n}`,
  intent: (i: Intent) => `i:${i}`,
};

/**
 * Hashed features, the stored and trained form (~0.5 KB):
 *   [v, sender, list, domain, rawDomain, nNames, ...names, nTokens, ...tokens, nIntents, ...intents]
 * The first name hash is the full display name.
 */
export function encodeFeatures(f: ThreadFeatures): Uint32Array {
  const names = nameGrams(f.name);
  const out = new Uint32Array(8 + names.length + f.tokens.length + f.intents.length);
  let i = 0;
  out[i++] = f.v;
  out[i++] = fnv1a(featureKey.sender(f.sender));
  out[i++] = f.list ? fnv1a(featureKey.list(f.list)) : 0;
  out[i++] = f.domain ? fnv1a(featureKey.domain(f.domain)) : 0;
  out[i++] = f.rawDomain ? fnv1a(featureKey.rawDomain(f.rawDomain)) : 0;
  out[i++] = names.length;
  for (const n of names) out[i++] = fnv1a(featureKey.name(n));
  out[i++] = f.tokens.length;
  for (const t of f.tokens) out[i++] = fnv1a(t);
  out[i++] = f.intents.length;
  for (const it of f.intents) out[i++] = fnv1a(featureKey.intent(it));
  return out;
}

export interface HashedFeatures {
  v: number;
  sender: number;
  list: number;
  domain: number;
  rawDomain: number;
  names: Uint32Array;
  tokens: Uint32Array;
  intents: Uint32Array;
}

export function decodeFeatures(a: Uint32Array): HashedFeatures {
  const nNames = a[5]!;
  const tokStart = 6 + nNames;
  const nTok = a[tokStart]!;
  const intStart = tokStart + 1 + nTok;
  const nInt = a[intStart]!;
  return {
    v: a[0]!,
    sender: a[1]!,
    list: a[2]!,
    domain: a[3]!,
    rawDomain: a[4]!,
    names: a.subarray(6, 6 + nNames),
    tokens: a.subarray(tokStart + 1, tokStart + 1 + nTok),
    intents: a.subarray(intStart + 1, intStart + 1 + nInt),
  };
}

/** Bytes for a BLOB column (copy: the view may share a larger buffer). */
export function featuresToBlob(a: Uint32Array): Uint8Array {
  return new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
}

export function featuresFromBlob(b: Uint8Array): Uint32Array {
  // node:sqlite hands out Uint8Arrays that may not be 4-byte aligned
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Uint32Array(copy.buffer, 0, Math.floor(b.byteLength / 4));
}

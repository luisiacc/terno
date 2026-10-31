import { isValidEmail } from "./address";

/**
 * Plan 94: how a sender says to stop their mail, from List-Unsubscribe (RFC 2369) and
 * List-Unsubscribe-Post (RFC 8058). Each URI as sent; absent when there is none.
 */
export interface Unsubscribe {
  /** an https URI that takes the one-click POST */
  oneClick?: string;
  mailto?: string;
  /** a page to open (the one-click URI too, when there is one) */
  url?: string;
}

/** A longer URI is dropped, not cut (a cut one would unsubscribe nobody, or someone else). */
export const UNSUBSCRIBE_URI_MAX = 2048;

const httpUri = (raw: string, https = false): string | null => {
  if (raw.length > UNSUBSCRIBE_URI_MAX) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && (https || url.protocol !== "http:")) return null;
    return url.username || url.password ? null : raw;
  } catch {
    return null;
  }
};

/** `<mailto:…>, <https://…>`: the first of each kind, in the header's order. */
export function parseListUnsubscribe(header: string | null | undefined, post: string | null | undefined): Unsubscribe | null {
  if (!header) return null;
  const out: Unsubscribe = {};
  for (const m of header.replace(/\s+/g, " ").matchAll(/<\s*([^<>]*?)\s*>/g)) {
    const raw = m[1]!.replace(/\s/g, "");
    if (/^mailto:/i.test(raw)) {
      if (!out.mailto && raw.length <= UNSUBSCRIBE_URI_MAX && mailtoParts(raw)) out.mailto = raw;
    } else if (!out.url) {
      const url = httpUri(raw);
      if (url) out.url = url;
    }
  }
  // RFC 8058: the POST goes to the header's https URI, and only when the sender asks for it
  if (out.url && post && /(^|[\s;])List-Unsubscribe\s*=\s*One-Click\s*($|;)/i.test(post.trim()) && httpUri(out.url, true)) out.oneClick = out.url;
  return out.mailto || out.url ? out : null;
}

/** A mailto URI's one address, subject and body (RFC 6068), or null when it isn't one address. */
export function mailtoParts(uri: string): { to: string; subject: string; body: string } | null {
  const m = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(uri.trim());
  if (!m) return null;
  let to: string;
  const params = new Map<string, string>();
  try {
    to = decodeURIComponent(m[1]!).trim();
    for (const pair of (m[2] ?? "").split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const key = decodeURIComponent(pair.slice(0, eq)).toLowerCase();
      if (!params.has(key)) params.set(key, decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, "%20")));
    }
  } catch {
    return null;
  }
  // one recipient, no extra headers smuggled in the address part
  if (!to || /[,;\s]/.test(to) || !isValidEmail(to)) return null;
  // only these three fields: cc, bcc and headers a URI may carry are never used
  const subject = (params.get("subject") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 998);
  return { to, subject: subject || "unsubscribe", body: (params.get("body") ?? "").slice(0, 10_000) || "unsubscribe" };
}

/** What a link to stop the mail says, in English and Spanish (accents and case folded). */
const SAYS_UNSUBSCRIBE = /\b(unsubscribe|unsubscribing|opt[\s-]?out|darse de baja|dar(te|me)? de baja|date de baja|desuscribir(te|se|me)?|desuscripcion|anular (la |tu )?suscripcion|cancelar (la |tu |mi )?suscripcion)\b/;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/** Bodies longer than this are read at both ends only (the link sits in the footer, sometimes in a header). */
const SCAN_MAX = 512 * 1024;

/**
 * The link in the mail itself that unsubscribes (plan 94 §1.4): the last http(s) anchor
 * whose text, title or aria-label says so; in a text body, a URL right after such words.
 */
export function findUnsubscribeLink(html: string | null | undefined, text: string | null | undefined): string | null {
  if (html) {
    const body = html.length > SCAN_MAX ? `${html.slice(0, SCAN_MAX / 4)}\n${html.slice(-SCAN_MAX * 3 / 4)}` : html;
    let found: string | null = null;
    for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]{0,2000}?)<\/a\s*>/gi)) {
      const href = attr(m[1]!, "href");
      const url = href ? httpUri(href.trim()) : null;
      if (!url) continue;
      const label = `${decodeEntities(m[2]!.replace(/<[^>]*>/g, " "))} ${attr(m[1]!, "title") ?? ""} ${attr(m[1]!, "aria-label") ?? ""}`;
      if (SAYS_UNSUBSCRIBE.test(fold(label.replace(/\s+/g, " ")))) found = url;
    }
    if (found) return found;
  }
  if (text) {
    const body = text.length > SCAN_MAX ? text.slice(-SCAN_MAX) : text;
    let found: string | null = null;
    for (const m of body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
      // the words just before it, on its line ("Unsubscribe: https://…", "Darse de baja aquí https://…")
      const before = body.slice(Math.max(0, m.index - 80), m.index);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const url = SAYS_UNSUBSCRIBE.test(fold(line)) ? httpUri(m[0]) : null;
      if (url) found = url;
    }
    return found;
  }
  return null;
}

/** What a store keeps (compact JSON, null when none) and reads back (a damaged value reads as none). */
export function unsubscribeJson(u: Unsubscribe | null | undefined): string | null {
  return u && (u.mailto || u.url) ? JSON.stringify(u) : null;
}

export function storedUnsubscribe(json: unknown): Unsubscribe | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const out: Unsubscribe = {};
    for (const key of ["oneClick", "mailto", "url"] as const) if (typeof v[key] === "string" && v[key].length <= UNSUBSCRIBE_URI_MAX) out[key] = v[key];
    return out.mailto || out.url ? out : null;
  } catch {
    return null;
  }
}

/** Plan 94: the message a conversation's Unsubscribe acts on, as a store reads it (a body only when it has no header data). */
export interface UnsubscribeSource {
  messageId: number;
  accountId: number;
  fromName: string;
  fromEmail: string;
  unsubscribe: Unsubscribe | null;
  bodyHtml: string | null;
  bodyText: string | null;
}

/** How many of a conversation's newest messages a store looks through for header data. */
export const UNSUBSCRIBE_LOOKBACK = 50;

/**
 * Of a conversation's messages that aren't yours (not sent, not drafts, not from your addresses), newest first:
 * the first with List-Unsubscribe, else the newest (its body may hold a link). Both stores pick with this.
 */
export function pickUnsubscribeMessage<T extends { from_email: string; unsubscribe?: unknown }>(newestFirst: readonly T[], own: ReadonlySet<string>, key: (email: string) => string): { row: T; unsubscribe: Unsubscribe | null } | null {
  let newest: T | null = null;
  for (const row of newestFirst) {
    if (own.has(key(row.from_email))) continue;
    newest ??= row;
    const unsubscribe = storedUnsubscribe(row.unsubscribe);
    if (unsubscribe) return { row, unsubscribe };
  }
  return newest && { row: newest, unsubscribe: null };
}

/** Plan 94: what Unsubscribe does for a conversation, as the menu shows it (`target`: a host, or the address mail goes to). */
export interface UnsubscribeOffer {
  messageId: number;
  method: "oneClick" | "mailto" | "page";
  target: string;
  /** who it is from, as the snackbar names them */
  name: string;
  /** a page only: the renderer opens it in the click itself (a browser blocks a window opened after a wait) */
  url?: string;
}

export type UnsubscribePlan = UnsubscribeOffer & ({ method: "oneClick"; url: string; page: string | null } | { method: "mailto"; mail: { to: string; subject: string; body: string } } | { method: "page"; url: string });

const hostOf = (url: string) => new URL(url).hostname;

/** One-click, then mail, then the header's page, then the link in the mail (plan 94 §1). */
export function unsubscribePlan(src: UnsubscribeSource): UnsubscribePlan | null {
  const base = { messageId: src.messageId, name: src.fromName.trim() || src.fromEmail };
  const u = src.unsubscribe;
  if (u?.oneClick && httpUri(u.oneClick, true)) return { ...base, method: "oneClick", target: hostOf(u.oneClick), url: u.oneClick, page: u.url && httpUri(u.url) ? u.url : null };
  const mail = u?.mailto ? mailtoParts(u.mailto) : null;
  if (mail) return { ...base, method: "mailto", target: mail.to, mail };
  const url = (u?.url && httpUri(u.url)) || findUnsubscribeLink(src.bodyHtml, src.bodyText);
  return url ? { ...base, method: "page", target: hostOf(url), url } : null;
}

/** What the renderer is told: never the URL of a request Terno makes itself (one-click) or of mail it sends. */
export function unsubscribeOffer(plan: UnsubscribePlan): UnsubscribeOffer {
  return { messageId: plan.messageId, method: plan.method, target: plan.target, name: plan.name, ...(plan.method === "page" && { url: plan.url }) };
}

/** Plan 94: what happened. `requested`: the request went out but its answer can't be read (a redirect, the web's opaque answer). */
export type UnsubscribeOutcome =
  | { outcome: "unsubscribed" | "requested"; target: string }
  | { outcome: "queued"; target: string; opId: string }
  /** a page for the user to open (a snackbar action: it may come after a wait); `failed`: the one-click request was refused */
  | { outcome: "open"; target: string; url: string; failed: boolean };

export const UNSUBSCRIBE_METHODS = ["oneClick", "mailto", "page"] as const;

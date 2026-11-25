/**
 * Plan 17: who is a person, and which conversations wait for your reply.
 * Local and deterministic: headers seen at ingest, Gmail's own categories,
 * the address, and whether you have ever written to it. Both stores compute a
 * thread's facts with threadFacts() over their message rows (the same column
 * names in SQLite and IndexedDB), so one table of cases holds them to one
 * contract.
 */

const DAY = 86_400_000;

/** An unanswered message older than this isn't "waiting" anymore (the count and the filter). */
export const WAITING_WINDOW_MS = 30 * DAY;

/** The oldest `waiting_since` that still counts at `now`. */
export function waitingCutoff(now: number): number {
  return now - WAITING_WINDOW_MS;
}

/** An address as compared for "yours" and "written to": lowercased, trimmed, a `+tag` dropped. */
export function addressKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  const plus = e.indexOf("+");
  return plus > 0 && plus < at ? e.slice(0, plus) + e.slice(at) : e;
}

/**
 * An address as an identity (Reply's "is it mine", plan 34; plan 281: one person in People): `addressKey`'s, and Gmail's
 * dots ignored in its local parts (googlemail.com is gmail.com).
 */
export function personKey(email: string): string {
  const e = addressKey(email);
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  const domain = e.slice(at + 1);
  return domain === "gmail.com" || domain === "googlemail.com" ? `${e.slice(0, at).replace(/\./g, "")}@gmail.com` : e;
}

/** Bulk mail's own headers: List-Unsubscribe, Precedence bulk/list/junk, Auto-Submitted other than "no". */
export function bulkHeaders(h: { listUnsubscribe?: string | null; precedence?: string | null; autoSubmitted?: string | null }): boolean {
  if (h.listUnsubscribe?.trim()) return true;
  const precedence = h.precedence?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const auto = h.autoSubmitted?.trim().toLowerCase();
  return !!auto && !auto.startsWith("no");
}

/** Local parts that are only ever machines once `.`, `_`, `-` are gone. */
const NOREPLY = /noreply|donotreply|noresponder|mailerdaemon/;

/**
 * Role words: a piece of the local part that names a function rather than a
 * person. Weak: a role address you have written to is a person (a shop's
 * support you corresponded with). A superset of the categorizer's BULK_LOCAL.
 */
export const ROLE_WORDS: ReadonlySet<string> = new Set([
  "notification", "notifications", "notifier", "alert", "alerts", "info", "news", "newsletter", "newsletters", "updates", "update",
  "digest", "marketing", "promo", "promos", "offers", "deals", "billing", "invoice", "invoices", "receipt", "receipts", "order", "orders",
  "shipping", "reservation", "reservations", "booking", "bookings", "support", "help", "helpdesk", "hello", "team", "contact",
  "service", "customerservice", "accounts", "account", "security", "calendar", "automated", "auto", "mailer", "system", "admin",
  "feedback", "survey", "community", "store", "shop", "sales", "welcome",
  "notificaciones", "notificacion", "alerta", "alertas", "boletin", "noticias", "promociones", "ofertas", "facturacion", "factura",
  "facturas", "recibo", "recibos", "pedido", "pedidos", "envios", "reservaciones", "reservacion", "reservas", "soporte", "ayuda",
  "hola", "equipo", "contacto", "servicio", "cuenta", "cuentas", "seguridad", "encuesta", "comunidad", "tienda", "ventas", "bienvenida",
]);

/** A domain's first label that marks a sending subdomain (news.example.com). Weak. */
const SENDING_LABELS: ReadonlySet<string> = new Set(["mail", "email", "e", "em", "news", "newsletter", "info", "mailer", "mailing", "marketing", "notifications", "notify", "bounce", "mg", "sg", "mta", "send"]);

/** Domains whose mail is automated in practice. Weak: someone there you wrote to is a person. */
const AUTOMATED_DOMAINS: ReadonlySet<string> = new Set(["facebookmail.com", "linkedin.com", "x.com", "twitter.com", "pinterest.com", "mail.instagram.com", "accounts.google.com"]);

/**
 * Plan 278: the Message-ID's domain of mail sent through a sending service (Amazon SES, SendGrid, Postmark, SparkPost).
 * A heuristic, as the role words are: no service documents its format (SES says only that it sets its own), so a change
 * there only means its mail stops being caught. Strong: an app sends through these from any address it likes (`hello@`,
 * `sac@`), and writing to that address once (to its support) doesn't make its receipts a person's.
 */
const SERVICE_DOMAINS = ["amazonses.com", "sendgrid.net", "mtasv.net", "sparkpostmail.com", "prd.sparkpost"];
/** SendGrid's bare host (no domain), only the shapes seen: `ismtpd0012p1mdw1`, `geopod-ismtpd-54`, `geopod-ismtpd-3-0` */
const SENDGRID_HOST = /^(?:ismtpd\d+(?:p\d+[a-z]+\d+)?|geopod-ismtpd-\d+(?:-\d+)*)$/;

/** Was this message sent through a sending service, by its Message-ID's domain (plan 278)? Exact domains or their subdomains. */
export function sentByService(rfcMessageId: string | null): boolean {
  if (!rfcMessageId) return false;
  const id = rfcMessageId.trim().replace(/^</, "").replace(/>$/, "");
  const at = id.lastIndexOf("@");
  // a malformed one (nothing before the @) says nothing (Codex code review #10)
  if (at <= 0) return false;
  const host = id.slice(at + 1).toLowerCase();
  return SENDGRID_HOST.test(host) || SERVICE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * The version of the rules here (plan 278): each store keeps the one its facts were computed with and rescans once when
 * it differs. 1: plan 17's; 2: sending services. A change to who is a person bumps it.
 */
export const PEOPLE_RULES_V = 2;
/**
 * What a store's facts were computed with when it says nothing: a store made after plan 278 (v83 stamps an older mailbox
 * with 1). A later bump finds these too (Codex code review #11).
 */
export const PEOPLE_RULES_BASE = 2;

/** Gmail's categories: the strong ones are never a person; Updates is weak. */
const GMAIL_STRONG = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];
const GMAIL_WEAK = "CATEGORY_UPDATES";

/** The message columns the facts read (SQLite and IndexedDB name them alike; 0/1 booleans, JSON text). */
export interface FactRow {
  id: number;
  date: number;
  from_email: string;
  /** To, Cc and the Message-ID are read for one message a thread: a store may leave them out and answer `details` */
  to_json?: string;
  cc_json?: string;
  is_sent: number;
  is_draft: number;
  is_trash: number;
  is_spam: number;
  list_id: string | null;
  is_bulk: number;
  gmail_labels: string | null;
  rfc_message_id?: string | null;
  /** `local:…` until the server has the sent copy */
  provider_msg_id: string | null;
}

/**
 * What judges a message's sender, its Message-ID included (plan 278: `sentByService`); an address alone has none of the
 * message's own parts (`addressOnly`).
 */
export type SenderSignals = Pick<FactRow, "from_email" | "list_id" | "is_bulk" | "gmail_labels" | "is_spam"> & { rfc_message_id: string | null };

/** The signals of an address alone, no message: what judges an address rather than mail. */
export const addressOnly = (email: string): SenderSignals => ({ from_email: email, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0, rfc_message_id: null });

/** How automated a sender looks: 2 never a person, 1 a person only if you have written to them, 0 a person. */
export function automatedLevel(m: SenderSignals): 0 | 1 | 2 {
  if (m.is_spam || m.list_id || m.is_bulk || sentByService(m.rfc_message_id)) return 2;
  const labels = m.gmail_labels;
  if (labels && GMAIL_STRONG.some((l) => labels.includes(l))) return 2;
  const email = addressKey(m.from_email);
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return 2;
  const local = email.slice(0, at);
  const compact = local.replace(/[._-]/g, "");
  if (NOREPLY.test(compact) || compact === "postmaster" || compact.startsWith("bounce")) return 2;
  if (labels?.includes(GMAIL_WEAK)) return 1;
  for (const piece of local.split(/[._+-]/)) if (ROLE_WORDS.has(piece)) return 1;
  const domain = email.slice(at + 1);
  if (AUTOMATED_DOMAINS.has(domain)) return 1;
  const dot = domain.indexOf(".");
  if (dot > 0 && domain.indexOf(".", dot + 1) > 0 && SENDING_LABELS.has(domain.slice(0, dot))) return 1;
  return 0;
}

/** An address that looks automated by itself (no headers or labels): what being written to can change. */
export function weakAddress(email: string): boolean {
  return automatedLevel(addressOnly(email)) === 1;
}

/** What the facts need besides the rows: your addresses, who you have written to, and replies elsewhere. */
export interface FactContext {
  /** one of your addresses (an addressKey) */
  own(key: string): boolean;
  /** you have sent mail to it (an addressKey) */
  written(key: string): boolean;
  /** a message of yours, in any account and any thread, names this Message-ID in In-Reply-To or References */
  answered(rfcMessageId: string): boolean;
  /** a local copy (`local:…`) whose send failed: it reached nobody, so it counts for nothing */
  failedSend(messageId: number): boolean;
  /** a row's To, Cc and Message-ID when the store left them out of its rows (read for one message per thread) */
  details?(messageId: number): { to_json: string; cc_json: string; rfc_message_id: string | null };
  /**
   * plan 215: you marked this message as needing no reply (Done on What matters' waiting row): it counts as answered. Asked
   * only of a newest message that would otherwise wait (one primary-key lookup); a newer one from them isn't, so it waits again
   */
  cleared?(messageId: number): boolean;
  /**
   * plan 240: a sender the user said to always show in What matters (an addressKey): their newest unanswered message waits
   * on you as a person's does, whatever their mail looks like; who is a person (`person`) doesn't change
   */
  shown?(key: string): boolean;
  /**
   * plan 278: your word on a sender (an addressKey): true a person, false not, undefined none. It outranks every guess but
   * Spam's. The facts ask it; the dated reader and summaries don't (their own gates would only half follow it)
   */
  rule?(key: string): boolean | undefined;
}

/** Is an inbound message's sender a person (plan 17 §2.2)? Spam never; then your word on the sender (plan 278); then the guesses. */
export function senderIsPerson(m: SenderSignals, ctx: Pick<FactContext, "written" | "rule">): boolean {
  if (m.is_spam) return false;
  const rule = ctx.rule?.(addressKey(m.from_email));
  if (rule !== undefined) return rule;
  const level = automatedLevel(m);
  return level === 0 || (level === 1 && ctx.written(addressKey(m.from_email)));
}

export interface ThreadFacts {
  /** the newest inbound message is from a person */
  person: 0 | 1;
  /** the newest visible message waits for your reply: its date */
  waitingSince: number | null;
}

/** Plan 215: the facts with the message they judged waiting (computed, never stored): what Done and Later on its row act on. */
export interface WaitingFacts extends ThreadFacts {
  waitingMessageId: number | null;
}

const later = (a: Pick<FactRow, "date" | "id">, b: Pick<FactRow, "date" | "id">) => a.date > b.date || (a.date === b.date && a.id > b.id);

function addressesOf(json: string): string[] {
  try {
    const list = JSON.parse(json) as { email?: unknown }[];
    return Array.isArray(list) ? list.flatMap((a) => (typeof a?.email === "string" ? [addressKey(a.email)] : [])) : [];
  } catch {
    return [];
  }
}

/** Drafts, and sends that failed, count for nothing. */
const ignored = (m: FactRow, ctx: FactContext) => m.is_draft === 1 || (m.provider_msg_id !== null && m.provider_msg_id.startsWith("local:") && ctx.failedSend(m.id));
const mineOf = (m: FactRow, ctx: FactContext) => m.is_sent === 1 || ctx.own(addressKey(m.from_email));
const visibleOf = (m: FactRow) => !m.is_trash && !m.is_spam;

/** The facts from the newest visible message and the newest inbound one of the right pool. */
function decide(newest: FactRow | null, inbound: FactRow | null, ctx: FactContext): WaitingFacts {
  // a row's To, Cc and Message-ID: its own, else the store's, read once a message (the inbound one is often the newest)
  let held: { id: number; d: NonNullable<ReturnType<NonNullable<FactContext["details"]>>> } | null = null;
  const detailsOf = (m: FactRow) => {
    if ((m.to_json === undefined || m.rfc_message_id === undefined) && ctx.details) {
      if (held?.id !== m.id) held = { id: m.id, d: ctx.details(m.id) };
      return held.d;
    }
    return { to_json: m.to_json ?? "[]", cc_json: m.cc_json ?? "[]", rfc_message_id: m.rfc_message_id ?? null };
  };
  // plan 278: the Message-ID says whether a sending service sent it
  const person = inbound !== null && senderIsPerson({ ...inbound, rfc_message_id: inbound.rfc_message_id !== undefined ? inbound.rfc_message_id : detailsOf(inbound).rfc_message_id }, ctx);
  // plan 240: a shown sender's message may wait too (never Spam's: the inbound pool leaves it out)
  const waits = person || (inbound !== null && !inbound.is_spam && ctx.shown?.(addressKey(inbound.from_email)) === true);
  // the newest visible message is inbound only if it is also the newest inbound one
  if (!newest || newest !== inbound || !waits) return { person: person ? 1 : 0, waitingSince: null, waitingMessageId: null };
  const d = detailsOf(newest);
  const to = addressesOf(d.to_json);
  const ccOnly = !to.some(ctx.own) && addressesOf(d.cc_json).some(ctx.own);
  // plan 215: "no reply needed", said by hand, is answered (asked last: only of a message that would wait)
  const waiting = !ccOnly && !(d.rfc_message_id && ctx.answered(d.rfc_message_id)) && !ctx.cleared?.(newest.id);
  const p = person ? 1 : 0;
  return waiting ? { person: p, waitingSince: newest.date, waitingMessageId: newest.id } : { person: p, waitingSince: null, waitingMessageId: null };
}

/** The stored facts alone: what's computed beside them never reaches a thread's row. */
const factsOnly = (f: WaitingFacts): ThreadFacts => ({ person: f.person, waitingSince: f.waitingSince });

/**
 * The facts read a conversation's newest messages, this many at most (drafts
 * and hidden ones included): what one thread costs is bounded, the longest
 * included (Codex review 1, #1). A thread where you wrote 200 times since
 * anyone else did isn't from a person lately, nor waiting for you.
 */
export const FACTS_WINDOW = 200;

/** The `k` newest rows (date, then id), in O(n log k): a min-heap of the newest seen so far, its root the oldest of them. */
export function newestMessages<T extends Pick<FactRow, "date" | "id">>(rows: readonly T[], k: number): T[] {
  const heap: T[] = [];
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let s = i;
      if (l < heap.length && later(heap[s]!, heap[l]!)) s = l;
      if (r < heap.length && later(heap[s]!, heap[r]!)) s = r;
      if (s === i) return;
      [heap[i], heap[s]] = [heap[s]!, heap[i]!];
      i = s;
    }
  };
  for (const m of rows) {
    if (heap.length < k) {
      heap.push(m);
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (!later(heap[p]!, heap[i]!)) break;
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      }
    } else if (later(m, heap[0]!)) {
      heap[0] = m;
      down(0);
    }
  }
  return heap;
}

/**
 * A thread's facts from all its messages, in any order (plan 17 §2.3).
 * `person`: the newest inbound one among the visible messages (all but spam
 * when the whole thread is in the Trash) has a person sender. `waitingSince`:
 * the newest visible message is inbound from a person, you aren't only on its
 * Cc, and nothing of yours answers it anywhere. Drafts and failed sends
 * never count.
 */
export function threadFacts(rows: readonly FactRow[], ctx: FactContext, window: number = FACTS_WINDOW): ThreadFacts {
  let newest: FactRow | null = null;
  let inbound: FactRow | null = null;
  let hiddenInbound: FactRow | null = null;
  // a conversation longer than the window: its newest messages only (short ones, the rule, are read as they are)
  const read = rows.length > window ? newestMessages(rows, window) : rows;
  for (const m of read) {
    if (ignored(m, ctx)) continue;
    const visible = visibleOf(m);
    if (visible && (!newest || later(m, newest))) newest = m;
    if (m.is_spam || mineOf(m, ctx)) continue;
    if (visible) {
      if (!inbound || later(m, inbound)) inbound = m;
    } else if (!hiddenInbound || later(m, hiddenInbound)) hiddenInbound = m;
  }
  return factsOnly(decide(newest, newest ? inbound : hiddenInbound, ctx));
}

/**
 * The same facts from the messages newest first (date, then id, descending),
 * reading only as far as it must: usually the first message or two, so one
 * huge conversation costs what a short one does (the backfill walks the
 * thread's index with it). Equal to threadFacts (a property test holds them).
 */
export function threadFactsNewestFirst(next: () => FactRow | undefined, ctx: FactContext, window: number = FACTS_WINDOW): ThreadFacts {
  return factsOnly(waitingFactsNewestFirst(next, ctx, window));
}

/** Plan 215: the same walk, with the message it judged waiting (Done and Later act on it, in the store's own transaction). */
export function waitingFactsNewestFirst(next: () => FactRow | undefined, ctx: FactContext, window: number = FACTS_WINDOW): WaitingFacts {
  let newest: FactRow | null = null;
  let inbound: FactRow | null = null;
  let hiddenInbound: FactRow | null = null;
  let read = 0;
  for (let m = read < window ? next() : undefined; m; m = ++read < window ? next() : undefined) {
    if (ignored(m, ctx)) continue;
    if (visibleOf(m)) {
      newest ??= m;
      if (!mineOf(m, ctx)) {
        inbound = m;
        break;
      }
    } else if (!newest && !hiddenInbound && !m.is_spam && !mineOf(m, ctx)) hiddenInbound = m;
  }
  return decide(newest, newest ? inbound : hiddenInbound, ctx);
}

/** Plan 278: your word on a sender: a person or not, whatever their mail looks like. */
export interface PersonRule {
  /** this entry's: an Undo takes back only the change it made */
  id: string;
  /** the sender's addressKey */
  key: string;
  email: string;
  name: string;
  /** true: a person; false: not */
  person: boolean;
  at: number;
}

/** At most this many senders have a rule (a change to one that has one is always taken). */
export const PERSON_RULES_MAX = 500;

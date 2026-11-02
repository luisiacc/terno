import { tIn, type LocaleId, type Messages } from "@terno/i18n";
import { formatAddressList, isValidEmail, MAX_RECIPIENTS } from "./address";
import type { Address } from "./types";

/**
 * Plan 116: new mail that lands in a category (or that a filter matches) is
 * forwarded to the addresses the user chose, from the account that received
 * it, 10 seconds later (Cancel meanwhile), while Terno runs.
 */

/** the wait before a forward goes, not configurable (the user's call) */
export const FORWARD_DELAY_MS = 10_000;
/** forwards per rule in FORWARD_CAP_WINDOW_MS before the next ones wait for the user's answer */
export const FORWARD_CAP = 100;
export const FORWARD_CAP_WINDOW_MS = 24 * 3_600_000;
/** "Keep forwarding": the rule isn't asked again for this long */
export const FORWARD_APPROVAL_MS = 24 * 3_600_000;
/** a new message can still be forwarded this long after it arrived (filed later by hand or by a suggestion) */
export const FORWARD_ELIGIBLE_MS = 24 * 3_600_000;
/** live mail older than this when it arrives (a catch-up after days offline) is never forwarded */
export const FORWARD_MAX_AGE_MS = 3 * 86_400_000;
/** a filter's match counts when it came this soon after the mail arrived (its body's filters too); applying it later never forwards */
export const FORWARD_FILTER_LAG_MS = 10 * 60_000;
/** held forwards nobody answered for are cancelled after this long */
export const FORWARD_HELD_MS = 3 * 86_400_000;
/** a forward whose files are still downloading waits for them at most this long, then goes with what is there */
export const FORWARD_FILES_WAIT_MS = 5 * 60_000;
/** settled forwards are listed (the reader's line) this long */
export const FORWARD_HISTORY_MS = 30 * 86_400_000;
/** a rule's addresses as stored (UTF-16 units): thousands of addresses, never an unbounded row */
export const FORWARD_ADDRESSES_MAX_CHARS = 256 * 1024;

export type ForwardRuleKind = "category" | "filter";

export interface ForwardRuleRef {
  kind: ForwardRuleKind;
  id: number;
}

/** A category's trigger (plan 116): where its new mail goes. */
export interface CategoryForward {
  addresses: Address[];
  enabled: boolean;
}

/**
 * Where a forward is:
 * - waiting: in its 10 seconds (or its files' wait); Cancel stops it
 * - held: past the rule's cap, waiting for the user's answer
 * - sending: queued or going out
 * - sent, failed (nothing went; Retry), unknown (may have gone; never retried by itself)
 * - partial: it went to some of its addresses and not others
 * - cancelled: by the user, or because the mail left the category, went to Spam or Trash, or the rule changed
 */
export type ForwardStatus = "waiting" | "held" | "sending" | "sent" | "partial" | "failed" | "unknown" | "cancelled";

export interface ForwardInfo {
  id: number;
  messageId: number;
  threadId: number;
  accountId: number;
  rule: ForwardRuleRef;
  /** the category's or the filter's name */
  ruleName: string;
  to: Address[];
  status: ForwardStatus;
  /** when it goes (waiting) */
  dueAt: number;
  /** when it last changed */
  at: number;
  /** the original's files that couldn't be included (sent without them) */
  filesMissing: boolean;
  /** why it failed or was cancelled by Terno, an i18n key (null: none, or the user cancelled it) */
  reason: string | null;
}

/** A rule past its cap: "Keep forwarding?" */
export interface ForwardQuestion {
  rule: ForwardRuleRef;
  ruleName: string;
  /** forwards it made in the last 24 hours */
  count: number;
  /** forwards waiting for the answer */
  held: number;
}

export interface ForwardSnapshot {
  /** waiting, held, sending, and what settled lately (bounded) */
  items: ForwardInfo[];
  questions: ForwardQuestion[];
}

/** A rule's addresses as stored: valid, trimmed, each once (case-insensitive), in the order given. */
export function forwardAddresses(list: readonly Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of list) {
    const email = a.email.trim();
    const key = email.toLowerCase();
    if (!isValidEmail(email) || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: a.name.trim(), email });
  }
  return out;
}

/** The sends a forward takes: at most MAX_RECIPIENTS addresses each. */
export function forwardChunks(to: readonly Address[]): Address[][] {
  const out: Address[][] = [];
  for (let i = 0; i < to.length; i += MAX_RECIPIENTS) out.push(to.slice(i, i + MAX_RECIPIENTS));
  return out;
}

/** What a forward quotes of its source message. */
export interface ForwardSource {
  from: Address;
  to: readonly Address[];
  subject: string;
  date: number;
  /** the body's text (its snippet when the body isn't here) */
  text: string;
}

/** How the text is phrased: the composer's active locale, or a given catalog on the backend. */
export interface ForwardWording {
  message(key: "compose.quote.forwarded", params: { from: string; date: string; subject: string; to: string }): string;
  message(key: "compose.prefix.forward", params: { subject: string }): string;
  date(ms: number): string;
}

export function catalogWording(locale: LocaleId, catalog: Messages, formatDate: (ms: number) => string): ForwardWording {
  return {
    message: (key: "compose.quote.forwarded" | "compose.prefix.forward", params: Record<string, string>) => tIn(locale, catalog, key, params as never),
    date: formatDate,
  } as ForwardWording;
}

/** A forward's quoted header and text ("---------- Forwarded message ----------", From, Date, Subject, To). */
export function forwardQuote(source: ForwardSource, wording: ForwardWording): string {
  const header = wording.message("compose.quote.forwarded", { from: formatAddressList([source.from]), date: wording.date(source.date), subject: source.subject, to: formatAddressList(source.to) });
  return `${header}\n\n${source.text}`;
}

/** A prefix already on the subject, from any language ("Fw:", Outlook's Spanish "RV:"): kept, never doubled. */
const FORWARDED = /^(fwd?|rv|reenv):/i;

export function forwardSubject(subject: string, wording: Pick<ForwardWording, "message">): string {
  return FORWARDED.test(subject) ? subject : wording.message("compose.prefix.forward", { subject });
}

/** The signature block appended below what is written (the "-- " line marks it, so clients can fold it). */
export function signatureBlock(signature: string): string {
  const sig = signature.replace(/\s+$/, "");
  return sig ? `-- \n${sig}` : "";
}

/** A forward with nothing written: the signature, then the quote (what the composer sends for an untouched Forward). */
export function forwardBody(quote: string, signature: string): string {
  const sig = signatureBlock(signature);
  return sig ? `${sig}\n\n${quote}` : quote;
}

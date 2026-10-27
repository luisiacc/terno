/**
 * Plan 38: what deserves the user's attention outside the window. The Dock's
 * number, and which new mail is worth a system notification and how a burst
 * of it is worded. Pure: the backend decides when, main and the page show.
 */
import { t } from "@terno/i18n";
import { addressKey, automatedLevel } from "./people";

/** The Dock badge: nothing at 0, the number up to 9,999, then "9999+" (five digits cover the icon). */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 9999 ? "9999+" : String(Math.floor(count));
}

/** A message only counts as just arrived if it is this recent (backfill and old mail moved in are not news). */
export const ARRIVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A newly inserted message as the store reads it back after its ingest (`store.sync.arrivals`). */
export interface ArrivalRow {
  id: number;
  threadId: number;
  accountId: number;
  date: number;
  fromName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  isRead: boolean;
  isSent: boolean;
  isDraft: boolean;
  /** the message and its conversation are both in the Inbox (a filter's archive takes either out) */
  inInbox: boolean;
  isTrash: boolean;
  isSpam: boolean;
  listId: string | null;
  isBulk: boolean;
  /** Gmail's label ids as stored (JSON text), null elsewhere */
  gmailLabels: string | null;
  /** the sender is one of your addresses */
  own: boolean;
  /** you have written to the sender */
  written: boolean;
  /** its conversation has mail of yours in it (a reply to you, or in a thread you joined) */
  yourConversation: boolean;
  /** its body is still to come (a filter that reads bodies hasn't seen it yet) */
  bodyPending: boolean;
}

/** Still news when looked at: recent, someone else's, unread, in the Inbox (not spam, trash or a filter's archive). */
export function stillNew(m: ArrivalRow, now: number): boolean {
  if (m.date < now - ARRIVAL_WINDOW_MS) return false;
  if (m.isSent || m.isDraft || m.own) return false;
  return !m.isRead && m.inInbox && !m.isTrash && !m.isSpam;
}

const GMAIL_STRONG = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];

/**
 * Why a message is important, or null (plan 38 §8.3):
 * - "written": someone you have written to, and not a machine (plan 17's automated level 0 or 1);
 * - "reply": a person (level 0, or 1 and written to) in a conversation you took part in;
 * - "gmail": Gmail marked it Important, it isn't list mail and it isn't in Promotions, Social or
 *   Forums. Bulk headers don't count against it: a security code says Auto-Submitted.
 * A stranger's first mail is important only when Gmail says so.
 */
export function importance(m: Pick<ArrivalRow, "fromEmail" | "listId" | "isBulk" | "gmailLabels" | "isSpam" | "written" | "yourConversation">): "written" | "reply" | "gmail" | null {
  if (m.isSpam) return null;
  const level = automatedLevel({ from_email: m.fromEmail, list_id: m.listId, is_bulk: m.isBulk ? 1 : 0, gmail_labels: m.gmailLabels, is_spam: 0 });
  if (m.written && level <= 1) return "written";
  if (m.yourConversation && level === 0) return "reply";
  const labels = m.gmailLabels;
  if (labels?.includes('"IMPORTANT"') && !m.listId && !GMAIL_STRONG.some((l) => labels.includes(`"${l}"`))) return "gmail";
  return null;
}

/** A notification, structured: main and the page word it in the user's language (noticeText). */
export interface MailNotice {
  /** the same burst keeps the same id (the web's tag: two tabs replace each other's) */
  id: string;
  /** important messages it stands for */
  count: number;
  /** what a click opens; null: the Inbox (several senders) */
  threadId: number | null;
  /** distinct senders, newest first, at most NOTICE_SENDERS */
  senders: string[];
  senderCount: number;
  /** the newest message's */
  subject: string;
  /** only for a single message */
  snippet: string;
}

export const NOTICE_SENDERS = 3;
export const NOTICE_SNIPPET = 140;
const MAX_FIELD = 300;

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1).trimEnd()}…` : flat;
};
const senderOf = (m: Pick<ArrivalRow, "fromName" | "fromEmail">) => clip(m.fromName || m.fromEmail, MAX_FIELD);

/** "Show sender and subject" off: nothing about the mail leaves the backend but how many there are. */
export function redact(n: MailNotice): MailNotice {
  return { ...n, senders: [], subject: "", snippet: "" };
}

/** One notice for a burst of important messages (any order in, newest first out); null for none. */
export function summarize(rows: readonly ArrivalRow[], id: string): MailNotice | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.date - a.date || b.id - a.id);
  const newest = sorted[0]!;
  const seen = new Set<string>();
  const senders: string[] = [];
  for (const m of sorted) {
    const key = addressKey(m.fromEmail) || m.fromName;
    if (seen.has(key)) continue;
    seen.add(key);
    if (senders.length < NOTICE_SENDERS) senders.push(senderOf(m));
  }
  return {
    id,
    count: sorted.length,
    threadId: seen.size === 1 ? newest.threadId : null,
    senders,
    senderCount: seen.size,
    subject: clip(newest.subject, MAX_FIELD),
    snippet: sorted.length === 1 ? clip(newest.snippet, NOTICE_SNIPPET) : "",
  };
}

/**
 * How a notice reads: one message is its sender, subject and opening words;
 * several from one sender, "3 new messages" and the newest subject; several
 * senders, "5 new messages" and who they're from.
 */
export function noticeText(n: MailNotice): { title: string; subtitle: string; body: string } {
  // redacted: only how many
  if (n.senders.length === 0) return { title: n.count <= 1 ? t("notify.new") : t("notify.count", { count: n.count }), subtitle: "", body: "" };
  const subject = n.subject || t("common.noSubject");
  if (n.count <= 1) return { title: n.senders[0] ?? "", subtitle: subject, body: n.snippet };
  if (n.senderCount <= 1) return { title: n.senders[0] ?? "", subtitle: t("notify.count", { count: n.count }), body: subject };
  const [a = "", b = ""] = n.senders;
  const from = n.senderCount === 2 ? t("notify.from.two", { a, b }) : t("notify.from.many", { a, b, count: n.senderCount - 2 });
  return { title: t("notify.count", { count: n.count }), subtitle: "", body: from };
}

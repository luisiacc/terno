import { formatAddressList, parseAddressList, type Account, type Address, type ThreadDetail } from "@terno/core";
import type { DraftMode } from "@terno/core/rpc";
import type { DraftFields } from "./drafts";

/**
 * The fields of a reply, reply-all, forward or new message, and converting a
 * draft between modes. Pure (no DOM, no backend): unit-tested on its own.
 */

const date = (ms: number) => new Date(ms).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });

/** The message a reply answers: the last one someone else sent (or the last one). */
export function answered(detail: ThreadDetail) {
  return [...detail.messages].reverse().find((m) => !m.isSent) ?? detail.messages[detail.messages.length - 1]!;
}

/** The quote a reply carries, or the block a forward carries. */
export function quoteFor(mode: Exclude<DraftMode, "new">, detail: ThreadDetail): string {
  const last = answered(detail);
  const text = last.bodyText ?? last.snippet;
  if (mode === "forward") {
    return `---------- Mensaje reenviado ----------\nDe: ${formatAddressList([last.from])}\nFecha: ${date(last.date)}\nAsunto: ${last.subject}\nPara: ${formatAddressList(last.to)}\n\n${text}`;
  }
  return `El ${date(last.date)}, ${last.from.name || last.from.email} escribió:\n${text.split("\n").map((l) => `> ${l}`).join("\n")}`;
}

/** Who a reply goes to (auto: Terno filled them in): the sender, plus everyone else on reply-all, never me. */
export function autoRecipients(mode: Exclude<DraftMode, "new">, detail: ThreadDetail, me: string): { to: Address[]; cc: Address[] } {
  if (mode === "forward") return { to: [], cc: [] };
  const last = answered(detail);
  const mine = me.toLowerCase();
  const to = last.isSent ? last.to : [last.from];
  const cc = mode === "replyAll" ? [...last.to, ...last.cc].filter((a) => a.email.toLowerCase() !== mine && !to.some((t) => t.email.toLowerCase() === a.email.toLowerCase())) : [];
  return { to, cc };
}

export function subjectFor(mode: DraftMode, subject: string): string {
  if (mode === "forward") return /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
  if (mode === "new") return "";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** A fresh reply/forward draft for a conversation. */
export function replyFields(mode: Exclude<DraftMode, "new">, detail: ThreadDetail, account: Account, opts: { quoteInBody?: boolean } = {}): DraftFields {
  const { to, cc } = autoRecipients(mode, detail, account.email);
  const quote = quoteFor(mode, detail);
  const last = answered(detail);
  return {
    accountId: account.id,
    threadId: detail.thread.id,
    mode,
    toText: formatAddressList(to),
    ccText: formatAddressList(cc),
    bccText: "",
    auto: { to: to.map((a) => a.email), cc: cc.map((a) => a.email), bcc: [] },
    subject: subjectFor(mode, detail.thread.subject),
    subjectEdited: false,
    // the floating composer shows the quote inside the text; the inline one keeps it apart
    bodyText: opts.quoteInBody ? `\n\n${quote}` : "",
    quotedText: opts.quoteInBody ? "" : quote,
    includeQuote: !opts.quoteInBody,
    inReplyToMessageId: mode === "forward" ? null : last.id,
    forwardOfMessageId: mode === "forward" ? last.id : null,
    uiState: "open",
  };
}

export function newFields(accountId: number): DraftFields {
  return { accountId, threadId: null, mode: "new", toText: "", ccText: "", bccText: "", auto: { to: [], cc: [], bcc: [] }, subject: "", subjectEdited: false, bodyText: "", quotedText: "", includeQuote: false, inReplyToMessageId: null, forwardOfMessageId: null, uiState: "open" };
}


/**
 * A draft turned into another mode (r → a, a → f, …), keeping what the user
 * wrote: the body, every recipient they typed, and a subject they edited.
 * Only what Terno filled in (auto recipients, subject, quote, threading) is
 * recomputed for the new mode.
 */
export function convertFields(d: DraftFields, mode: Exclude<DraftMode, "new">, detail: ThreadDetail, account: Account): DraftFields {
  const fresh = replyFields(mode, detail, account);
  const lower = (e: string) => e.toLowerCase();
  // what the user typed, field by field (Terno's own entries in that field excluded)
  const typed = (text: string, auto: readonly string[]) => {
    const mine = new Set(auto.map(lower));
    return parseAddressList(text).filter((a) => !mine.has(lower(a.email)));
  };
  const typedTo = typed(d.toText, d.auto.to);
  const typedCc = typed(d.ccText, d.auto.cc);
  const typedBcc = typed(d.bccText, d.auto.bcc);
  // Terno's recipients for the new mode, minus anyone the user already put in any field
  const taken = new Set([...typedTo, ...typedCc, ...typedBcc].map((a) => lower(a.email)));
  const autoTo = parseAddressList(fresh.toText).filter((a) => !taken.has(lower(a.email)));
  for (const a of autoTo) taken.add(lower(a.email));
  const autoCc = parseAddressList(fresh.ccText).filter((a) => !taken.has(lower(a.email)));
  return {
    ...d,
    mode,
    toText: formatAddressList([...typedTo, ...autoTo]),
    ccText: formatAddressList([...typedCc, ...autoCc]),
    bccText: formatAddressList(typedBcc),
    auto: { to: autoTo.map((a) => a.email), cc: autoCc.map((a) => a.email), bcc: [] },
    subject: d.subjectEdited ? d.subject : fresh.subject,
    quotedText: fresh.quotedText,
    includeQuote: fresh.includeQuote,
    inReplyToMessageId: fresh.inReplyToMessageId,
    forwardOfMessageId: fresh.forwardOfMessageId,
    uiState: "open",
  };
}


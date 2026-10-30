import { attachmentMessageBudget, type AttachmentRef, formatAddressList, parseAddressList, repairAddress, repairAddresses, type Account, type Address, type MessageDetail, type ThreadDetail } from "@terno/core";
import type { DraftMode } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import type { DraftFields } from "./drafts";
import { fullDate } from "./format";

/**
 * The fields of a reply, reply-all, forward or new message, and converting a
 * draft between modes. Pure (no DOM, no backend): unit-tested on its own.
 */

/** An address as an identity: lowercased, `+tag` dropped; Gmail ignores dots in its local parts. */
function identityKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at).replace(/\+.*$/, "");
  let domain = e.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/** Is an address mine? */
export type Mine = (email: string) => boolean;

/**
 * My identities in a conversation (plan 34): every account's address, and
 * the From of every message of mine in it (a Gmail send-as alias, another
 * identity), `me+tag@` and Gmail's dotted spellings included.
 */
export function identitiesIn(detail: ThreadDetail, accounts: readonly string[]): Mine {
  const keys = new Set(accounts.map(identityKey));
  for (const m of detail.messages) if (m.isSent && m.from.email) keys.add(identityKey(m.from.email));
  return (email) => keys.has(identityKey(email));
}

const asMine = (mine: Mine | string | readonly string[] | undefined, detail: ThreadDetail): Mine =>
  typeof mine === "function" ? mine : identitiesIn(detail, mine === undefined ? [] : typeof mine === "string" ? [mine] : mine);

/**
 * The message a reply answers: the last one someone else sent (not marked
 * sent, and not from one of my identities), or the last one. Recipients, the
 * quote and the threading all answer this one (Codex review 4).
 */
export function answered(detail: ThreadDetail, mine?: Mine | string | readonly string[]): MessageDetail {
  const isMine = asMine(mine, detail);
  return [...detail.messages].reverse().find((m) => !m.isSent && !isMine(m.from.email)) ?? detail.messages[detail.messages.length - 1]!;
}

/**
 * The quote a reply carries, or the block a forward carries. Its header is
 * written in the language of the moment, date included; from then on it is
 * the draft's text and never changes.
 */
export function quoteFor(mode: Exclude<DraftMode, "new">, detail: ThreadDetail, mine?: Mine | string | readonly string[]): string {
  const last = answered(detail, mine);
  const text = last.bodyText ?? last.snippet;
  const date = fullDate(last.date);
  if (mode === "forward") {
    return `${t("compose.quote.forwarded", { from: formatAddressList([last.from]), date, subject: last.subject, to: formatAddressList(last.to) })}\n\n${text}`;
  }
  return `${t("compose.quote.attribution", { date, name: last.from.name || last.from.email })}\n${text.split("\n").map((l) => `> ${l}`).join("\n")}`;
}

/**
 * Who a reply goes to (auto: Terno filled them in), plans 27 and 29:
 * - the sender, or every Reply-To address that isn't mine (plan 27: a Reply-To naming only me leaves To empty);
 * - my own message (or one from my alias): its To again (a note to myself: to me);
 * - reply-all adds its To and Cc in Cc;
 * - never me (any identity), never twice (any case), never a Bcc; addresses repaired as other clients mangle them.
 */
export function autoRecipients(mode: Exclude<DraftMode, "new">, detail: ThreadDetail, mine: Mine | string | readonly string[]): { to: Address[]; cc: Address[] } {
  if (mode === "forward") return { to: [], cc: [] };
  const isMine = asMine(mine, detail);
  const last = answered(detail, isMine);
  const from = repairAddress(last.from);
  const others = (list: readonly Address[], split = true) => repairAddresses(list, { split }).filter((a) => !isMine(a.email));
  const own = last.isSent || isMine(from.email);
  let to = own ? others(last.to) : last.replyTo?.length ? others(last.replyTo, false) : [from];
  // answering myself with nobody else on it: to me, as written
  if (!to.length && own) to = repairAddresses(last.to).slice(0, 1);
  if (!to.length && own) to = [from];
  const taken = new Set(to.map((a) => a.email.toLowerCase()));
  const cc = mode === "replyAll" ? others([...last.to, ...last.cc]).filter((a) => !taken.has(a.email.toLowerCase())) : [];
  return { to, cc };
}

/** The first name a reply goes to, for "Reply to Ana…": who autoRecipients puts in To. */
export function replyName(detail: ThreadDetail, mine: Mine | string | readonly string[]): string {
  const to = autoRecipients("reply", detail, mine).to[0];
  return to ? (to.name || to.email).split(/\s+/)[0]! : "";
}

/** A prefix already on the subject, from any language ("RE:", "Fw:", Outlook's Spanish "RV:"): kept, never doubled. */
const FORWARDED = /^(fwd?|rv|reenv):/i;
const REPLIED = /^re:/i;

/** A reply's or a forward's subject; the prefix Terno adds follows the language ("Re:", "Fwd:"). */
export function subjectFor(mode: DraftMode, subject: string): string {
  if (mode === "forward") return FORWARDED.test(subject) ? subject : t("compose.prefix.forward", { subject });
  if (mode === "new") return "";
  return REPLIED.test(subject) ? subject : t("compose.prefix.reply", { subject });
}

/** A fresh reply/forward draft for a conversation. */
/** `identities`: every account's address (plan 34: none of them is replied to); the draft's account's alone by default. */
/** `forwardRefs`: the original's files a forward carries (plan 60: those confirmed on this device); every stored part by default. */
export function replyFields(mode: Exclude<DraftMode, "new">, detail: ThreadDetail, account: Account, opts: { quoteInBody?: boolean; identities?: readonly string[]; forwardRefs?: readonly AttachmentRef[]; sourceId?: number } = {}): DraftFields {
  const mine = identitiesIn(detail, [account.email, ...(opts.identities ?? [])]);
  const source = opts.sourceId === undefined ? undefined : detail.messages.find((message) => message.id === opts.sourceId);
  const sourceDetail = source ? { ...detail, messages: [source] } : detail;
  const { to, cc } = autoRecipients(mode, sourceDetail, mine);
  const quote = quoteFor(mode, sourceDetail, mine);
  const last = answered(sourceDetail, mine);
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
    bodyHtml: "",
    attachments: mode === "forward" ? [...(opts.forwardRefs ?? storedRefs(last))] : [],
    quotedText: opts.quoteInBody ? "" : quote,
    includeQuote: !opts.quoteInBody,
    replyContext: mode === "forward" ? null : { subject: detail.thread.subject, sourceId: last.id, sourceAccountId: last.accountId, rfcMessageId: last.rfcMessageId },
    inReplyToMessageId: mode === "forward" ? null : last.id,
    forwardOfMessageId: mode === "forward" ? last.id : null,
    uiState: "open",
  };
}

export function newFields(accountId: number): DraftFields {
  return { accountId, threadId: null, mode: "new", toText: "", ccText: "", bccText: "", auto: { to: [], cc: [], bcc: [] }, subject: "", subjectEdited: false, bodyText: "", bodyHtml: "", quotedText: "", includeQuote: false, inReplyToMessageId: null, forwardOfMessageId: null, uiState: "open" };
}


/** Authored refs win; forwarding the same immutable asset never adds a duplicate part. */
export function mergeAttachmentRefs(current: readonly AttachmentRef[], incoming: readonly AttachmentRef[]): AttachmentRef[] {
  const refs = new Map<string, AttachmentRef>();
  for (const ref of [...current, ...incoming]) if (!refs.has(ref.assetId)) refs.set(ref.assetId, ref);
  return [...refs.values()];
}

/** The parts of a message whose bytes are on this device, as refs. */
export function storedRefs(m: MessageDetail): AttachmentRef[] {
  return m.attachments.filter((a) => a.assetId).map((a) => ({ assetId: a.assetId!, filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId ?? null }));
}

/** A forward's files belong to the original's account: another From can't carry them (`refs`: the files it would carry). */
export function forwardAccountMismatch(accountId: number, detail: ThreadDetail, identities: readonly string[] = [], refs?: readonly AttachmentRef[]): boolean {
  return accountId !== detail.thread.accountId && (refs ?? storedRefs(answered(detail, identities))).length > 0;
}

/**
 * A draft turned into another mode (r → a, a → f, …), keeping what the user
 * wrote: the body, every recipient they typed, and a subject they edited.
 * Only what Terno filled in (auto recipients, subject, quote, threading) is
 * recomputed for the new mode.
 */
export function convertFields(d: DraftFields, mode: Exclude<DraftMode, "new">, detail: ThreadDetail, account: Account, identities: readonly string[] = [], forwardRefs?: readonly AttachmentRef[]): DraftFields {
  if (mode === "forward" && forwardAccountMismatch(d.accountId, detail, identities, forwardRefs)) return d;
  const continuing = mode !== "forward" && d.mode !== "forward" && d.mode !== "new" && d.inReplyToMessageId !== null;
  if (continuing && !detail.messages.some((message) => message.id === d.inReplyToMessageId)) return d;
  const fresh = replyFields(mode, detail, account, { identities, forwardRefs, ...(continuing ? { sourceId: d.inReplyToMessageId! } : {}) });
  const attachments = mergeAttachmentRefs(d.attachments ?? [], mode === "forward" ? fresh.attachments ?? [] : []);
  if (!attachmentMessageBudget("", undefined, attachments)) return d;
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
    attachments,
    mode,
    toText: formatAddressList([...typedTo, ...autoTo]),
    ccText: formatAddressList([...typedCc, ...autoCc]),
    bccText: formatAddressList(typedBcc),
    auto: { to: autoTo.map((a) => a.email), cc: autoCc.map((a) => a.email), bcc: [] },
    subject: d.subjectEdited ? d.subject : continuing ? d.subject : fresh.subject,
    quotedText: fresh.quotedText,
    includeQuote: fresh.includeQuote,
    replyContext: mode !== "forward" && d.mode !== "forward" && d.mode !== "new" ? d.replyContext : fresh.replyContext,
    inReplyToMessageId: mode !== "forward" && d.mode !== "forward" && d.mode !== "new" ? d.inReplyToMessageId : fresh.inReplyToMessageId,
    forwardOfMessageId: fresh.forwardOfMessageId,
    uiState: "open",
  };
}


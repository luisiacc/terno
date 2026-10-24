import { formatAddressList, isValidEmail, parseAddressList, type Account, type Address, type ThreadDetail } from "@unica/core";
import type { DraftMode } from "@unica/core/rpc";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
import { invalidateThreads, loadThread } from "~/state/threads";
import { createDraft, draftForSend, forgetDraft, recipients, sendBody, threadDraftKey, useDrafts, type DraftFields } from "./drafts";

/**
 * Writing mail: which draft a reply, reply-all, forward or new message opens,
 * and sending it. Targets are always explicit (the thread a menu was opened
 * on, the open thread for the keyboard), never read later from the selection.
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

/** Who a reply goes to (auto: Única filled them in): the sender, plus everyone else on reply-all, never me. */
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
    auto: [...to, ...cc].map((a) => a.email),
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
  return { accountId, threadId: null, mode: "new", toText: "", ccText: "", bccText: "", auto: [], subject: "", subjectEdited: false, bodyText: "", quotedText: "", includeQuote: false, inReplyToMessageId: null, forwardOfMessageId: null, uiState: "open" };
}

let seq = 0;

/**
 * Opens the draft for `mode` on `threadId` (default: the open thread): the
 * conversation's existing draft if it has one, else a fresh one.
 */
export async function openCompose(mode: DraftMode = "new", threadId: number | null = getApp().selectedId): Promise<void> {
  const s = getApp();
  const defaultAccount = s.accountId ?? s.accounts[0]?.id;
  if (!defaultAccount) {
    toast("Conecta una cuenta para escribir correos");
    setApp({ dialog: "addAccount" });
    return;
  }
  if (mode === "new" || threadId === null) {
    setApp({ compose: { key: createDraft(newFields(defaultAccount)), seq: ++seq } });
    return;
  }
  const existing = threadDraftKey(useDrafts.getState().drafts, threadId);
  if (existing) return void setApp({ compose: { key: existing, seq: ++seq } });
  const detail = await loadThread(threadId);
  if (!detail) return;
  const account = s.accounts.find((a) => a.id === detail.thread.accountId) ?? s.accounts[0]!;
  setApp({ compose: { key: createDraft(replyFields(mode, detail, account, { quoteInBody: true })), seq: ++seq } });
}

/** Sends a draft: waits for its save in flight, checks the recipients, queues the send (which deletes the stored draft). */
export async function sendDraft(key: string): Promise<boolean> {
  const d = await draftForSend(key);
  if (!d) return false;
  const strip = (list: ReturnType<typeof recipients>) => list.map(({ name, email }) => ({ name, email }));
  const to = strip(recipients(d.toText, d.auto));
  const cc = strip(recipients(d.ccText, d.auto));
  const bcc = strip(recipients(d.bccText, d.auto));
  // something typed that isn't an address (or nobody at all): stay, and say so
  const invalid = [d.toText, d.ccText, d.bccText].some((t) => parseAddressList(t).some((a) => !isValidEmail(a.email)));
  if (to.length === 0 || invalid) {
    toast.error("Revisa los destinatarios");
    return false;
  }
  try {
    const res = await client.call("compose.send", {
      accountId: d.accountId,
      to,
      cc,
      bcc,
      subject: d.subject,
      bodyText: sendBody(d),
      inReplyToMessageId: d.inReplyToMessageId ?? undefined,
      forwardOfMessageId: d.forwardOfMessageId ?? undefined,
      draftId: d.id ?? undefined,
    });
    forgetDraft(key);
    if (getApp().compose?.key === key) setApp({ compose: null });
    invalidateThreads([res.threadId]);
    toast.success("Enviando…");
    return true;
  } catch (error) {
    toast.error(`No se pudo enviar: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

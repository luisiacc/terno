import { isValidEmail, parseAddressList } from "@unica/core";
import type { DraftMode } from "@unica/core/rpc";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
import { invalidateThreads, loadThread } from "~/state/threads";
import { setLastUndo } from "./actions";
import { convertFields, newFields, replyFields } from "./compose-fields";
export { answered, autoRecipients, convertFields, newFields, quoteFor, replyFields, subjectFor } from "./compose-fields";
import { createDraft, draftForSend, editDraft, fieldsOf, forgetDraft, recipients, sendBody, setDraftUi, threadDraftKey, useDrafts, type LocalDraft } from "./drafts";

/**
 * Writing mail: which draft a reply, reply-all, forward or new message opens,
 * and sending it. Targets are always explicit (the thread a menu was opened
 * on, the open thread for the keyboard), never read later from the selection.
 */

const MODE_LABEL: Record<DraftMode, string> = { new: "Mensaje nuevo", reply: "Responder", replyAll: "Responder a todos", forward: "Reenviar" };

let seq = 0;

/** Asks the inline draft to take focus (only an explicit open does; coming back to a thread never does). */
function focusDraft(key: string, target: "body" | "to") {
  setApp({ draftFocus: { key, target, seq: ++seq } });
}

/** Does a draft carry anything the user wrote? */
const written = (d: LocalDraft) => d.bodyText.trim() !== "" || d.subjectEdited || d.localRev > 0;

/**
 * Opens the draft for `mode` on `threadId` (default: the open thread).
 * A new message opens in the floating composer for now. A reply, reply-all or
 * forward opens inline in its conversation: the conversation's draft if it
 * has one (resumed as is in the same mode, converted keeping what was written
 * in another), else a fresh one. With a bulk selection there is no single
 * target: nothing happens.
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
  if (s.scope !== null || s.checked.size >= 2) return;
  const target = mode === "forward" ? "to" : "body";
  const existingKey = threadDraftKey(useDrafts.getState().drafts, threadId);
  const existing = existingKey ? useDrafts.getState().drafts[existingKey] : undefined;
  if (existing && existing.mode === mode) {
    setDraftUi(existing.key, "open");
    return focusDraft(existing.key, target);
  }
  const detail = await loadThread(threadId);
  if (!detail) return;
  const account = s.accounts.find((a) => a.id === detail.thread.accountId) ?? s.accounts[0]!;
  if (existing && existing.mode !== "new") {
    const before = fieldsOf(existing);
    if (!written(existing)) {
      // nothing written yet: simply the other mode, fresh
      editDraft(existing.key, { ...replyFields(mode, detail, account) });
      return focusDraft(existing.key, target);
    }
    editDraft(existing.key, convertFields(before, mode, detail, account));
    focusDraft(existing.key, target);
    // back to what it was, still open where the user is looking
    const undo = () => editDraft(existing.key, { ...before, uiState: "open" });
    setLastUndo(undo);
    toast(`Convertido en ${MODE_LABEL[mode]}`, { action: { label: "Deshacer", onClick: undo } });
    return;
  }
  const key = createDraft(replyFields(mode, detail, account));
  focusDraft(key, target);
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

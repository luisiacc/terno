import { attachmentUploading } from "./attachments";
import { breadcrumb, captureUi } from "~/lib/diag";
import { firstInvalid, SELECT_INVALID } from "./recipient-field";
import type { DraftMode } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { invalidateThreads, loadThread, useThreads } from "~/state/threads";
import { registerUndo, snack } from "./snack";
import { answered, convertFields, newFields, replyFields } from "./compose-fields";
export { answered, autoRecipients, convertFields, newFields, quoteFor, replyFields, subjectFor } from "./compose-fields";
import { authored, createDraft, draftForSend, editDraft, fieldsOf, flushDraft, forgetDraft, markSending, materialize, resumeDraft, validRecipients, sendBody, sendHtml, setDraftUi, shownDraftKey, useDrafts, type LocalDraft } from "./drafts";

/**
 * Writing mail: which draft a reply, reply-all, forward or new message opens,
 * and sending it. Targets are always explicit (the thread a menu was opened
 * on, the open thread for the keyboard), never read later from the selection.
 */

/** What a conversion to each mode says, and its undo's accessible name. */
const CONVERTED = {
  reply: ["compose.converted.reply", "compose.undoConvert.reply"],
  replyAll: ["compose.converted.replyAll", "compose.undoConvert.replyAll"],
  forward: ["compose.converted.forward", "compose.undoConvert.forward"],
} as const;

let seq = 0;

/**
 * The last compose intent wins: an open that had to wait for its conversation
 * (not loaded yet) does nothing if the user did something else with the draft
 * meanwhile (another r/a/f, Esc). Otherwise "r, Esc, r" typed fast reopened
 * the draft late, focused, and the second "r" went into the text.
 */
let intent = 0;
export const supersedeCompose = (): void => void ++intent;

/** Asks the inline draft to take focus (only an explicit open does; coming back to a thread never does). */
export function focusDraft(key: string, target: "body" | "to") {
  setApp({ draftFocus: { key, target, seq: ++seq } });
}

/** Does a draft carry anything the user wrote? */
const written = (d: LocalDraft) => d.bodyText.trim() !== "" || d.subjectEdited || d.localRev > 0 || (d.attachments?.length ?? 0) > 0;

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
    snack(t("compose.noAccount"));
    setApp({ dialog: "addAccount" });
    return;
  }
  if (mode === "new" || threadId === null) {
    // a new message takes the reader pane; a bulk selection steps aside for it
    // (List: the new message is the page, and leaving it lands on the list, not on the conversation it was opened over; plan 24, R1)
    setApp({ compose: { key: createDraft(newFields(defaultAccount)), seq: ++seq }, checked: new Set(), scope: null, readerOpen: false });
    return;
  }
  if (s.scope !== null || s.checked.size >= 2) return;
  const target = mode === "forward" ? "to" : "body";
  const existingKey = shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown);
  // its body as the editor has it now (what "written" and a conversion's undo look at)
  const existing = existingKey ? materialize(existingKey) : undefined;
  if (existing && existing.mode === mode) {
    setDraftUi(existing.key, "open");
    return focusDraft(existing.key, target);
  }
  const mine = ++intent;
  // the open conversation is loaded: no wait, so nothing can come in between
  const detail = useThreads.getState().details.get(threadId) ?? (await loadThread(threadId));
  if (!detail || mine !== intent) return;
  if (mode === "forward" && answered(detail).attachments.some((a) => !a.assetId)) { snack.error(t("attachments.unavailable")); return; }
  const account = s.accounts.find((a) => a.id === detail.thread.accountId) ?? s.accounts[0]!;
  // none of my addresses is replied to, whichever account the conversation is in (plan 32)
  const identities = s.accounts.map((a) => a.email);
  if (existing && existing.mode !== "new") {
    const before = fieldsOf(existing);
    if (!written(existing)) {
      // nothing written yet: simply the other mode, fresh
      editDraft(existing.key, { ...replyFields(mode, detail, account, { identities }) });
      return focusDraft(existing.key, target);
    }
    editDraft(existing.key, convertFields(before, mode, detail, account, identities));
    focusDraft(existing.key, target);
    // back to what it was, still open where the user is looking
    const undo = registerUndo(() => editDraft(existing.key, { ...before, uiState: "open" }));
    const [message, name] = CONVERTED[mode];
    snack(t(message), { action: { label: t("common.undo"), name: t(name), undo } });
    return;
  }
  const key = createDraft(replyFields(mode, detail, account, { identities }));
  focusDraft(key, target);
}

/** Shows a new-message draft in the reader pane again (from the drafts strip). */
export function showNewDraft(key: string): void {
  setApp({ compose: { key, seq: ++seq }, checked: new Set(), scope: null, readerOpen: false });
}

/**
 * The reader pane leaves the new message (Esc, a thread opened, sent, discarded).
 * What was written is kept (saved first); an untouched new draft just goes.
 */
export function leaveNewDraft(): void {
  const key = getApp().compose?.key;
  if (!key) return;
  setApp({ compose: null });
  const d = useDrafts.getState().drafts[key];
  if (d && !authored(d)) forgetDraft(key);
  else void flushDraft(key);
}

/** Opening a conversation (j/k, a click, the menu) while a new message is shown: the reader follows the conversation. */
export function installComposeFollowsSelection(): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.compose && s.compose === prev.compose && s.selectedId !== prev.selectedId) leaveNewDraft();
  });
}

/**
 * The written part as sent: plain text alone for a plain draft; for a rich one
 * the HTML and the text both come from a document (the editor's, or the stored
 * HTML read through the schema), so only schema HTML goes out and the two match.
 */
export async function bodyParts(d: Pick<LocalDraft, "bodyText" | "bodyHtml" | "canonical">): Promise<{ text: string; html: string | null }> {
  if (!d.bodyHtml) return { text: d.bodyText, html: null };
  if (d.canonical) return { text: d.bodyText, html: d.bodyHtml };
  const rt = await import("@terno/richtext");
  const doc = rt.parseHtml(d.bodyHtml);
  return { text: rt.toPlainText(doc), html: rt.toEmailHtml(doc) };
}

/** Sends in flight, per draft: a second send of the same draft (a remounted pane, a double ⌘↩) gets the first one's outcome. */
const pendingSends = new Map<string, Promise<boolean>>();

/**
 * Sends a draft: waits for its save in flight, checks the recipients, queues
 * the send (which deletes the stored draft). One send per draft at a time;
 * while it runs the draft can't be edited or discarded.
 */
export function sendDraft(key: string): Promise<boolean> {
  const pending = pendingSends.get(key);
  if (pending) return pending;
  const run = send(key).finally(() => pendingSends.delete(key));
  pendingSends.set(key, run);
  return run;
}

export const isSending = (key: string): boolean => pendingSends.has(key);

/** Focus moves to the field Send found wrong, its first invalid chip selected (once the draft shows again). */
function showRecipient(key: string, field: "to" | "cc" | "bcc") {
  if (typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() =>
    document.querySelector(`[data-draft-key="${CSS.escape(key)}"] [data-recipient-field="compose-${field}"]`)?.dispatchEvent(new CustomEvent(SELECT_INVALID)),
  );
}

async function send(key: string): Promise<boolean> {
  if (attachmentUploading(key)) { snack.error(t("attachments.adding")); return false; }
  // read-only from here: nothing typed while the save in flight settles can fall between it and the send
  markSending(key, true);
  const d = await draftForSend(key);
  if (!d) {
    markSending(key, false);
    return false;
  }
  const to = validRecipients(d.toText);
  const cc = validRecipients(d.ccText);
  const bcc = validRecipients(d.bccText);
  // something typed that isn't an address (or nobody at all): stay, say what is wrong, and show it (plan 32 §2.6)
  const bad = (["to", "cc", "bcc"] as const).map((field) => ({ field, entry: firstInvalid(d[`${field}Text`]) })).find((b) => b.entry !== null);
  if (to.length === 0 || bad) {
    markSending(key, false);
    resumeDraft(key);
    snack.error(bad ? t("compose.invalidRecipient", { entry: bad.entry! }) : t("compose.noRecipient"));
    showRecipient(key, bad?.field ?? "to");
    return false;
  }
  breadcrumb("action", "action.send");
  try {
    const body = await bodyParts(d);
    const signature = getApp().accounts.find((a) => a.id === d.accountId)?.signature;
    const res = await client.call("compose.send", {
      accountId: d.accountId,
      to,
      cc,
      bcc,
      subject: d.subject,
      bodyText: sendBody({ ...d, bodyText: body.text }, signature),
      bodyHtml: body.html === null ? undefined : sendHtml(body.html, d, signature),
      inReplyToMessageId: d.inReplyToMessageId ?? undefined,
      forwardOfMessageId: d.forwardOfMessageId ?? undefined,
      draftId: d.id ?? undefined,
      draftRevision: d.id ? d.revision : undefined,
      attachments: d.attachments ?? [],
    });
    forgetDraft(key);
    if (getApp().compose?.key === key) setApp({ compose: null });
    invalidateThreads([res.threadId]);
    snack.success(t("compose.sending"));
    return true;
  } catch (error) {
    markSending(key, false);
    resumeDraft(key);
    captureUi(error, { code: "compose.send_failed" });
    snack.error(t("compose.sendFailed", { error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

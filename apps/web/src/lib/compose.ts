import type { AttachmentRef } from "@terno/core";
import { attachmentUploading, draftAttachmentBudget } from "./attachments";
import { breadcrumb, captureUi } from "~/lib/diag";
import { firstInvalid, SELECT_INVALID } from "./recipient-field";
import type { DraftMode } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { invalidateThreads, loadThread } from "~/state/threads";
import { registerUndo, snack } from "./snack";
import { answered, convertFields, forwardAccountMismatch, newFields, replyFields, mergeAttachmentRefs } from "./compose-fields";
export { answered, autoRecipients, convertFields, newFields, quoteFor, replyFields, subjectFor } from "./compose-fields";
import { beginDraftWork, expireDraftPresentation, draftEditsHeld, authored, createDraft, draftForSend, editDraft, fieldsOf, flushDraft, forgetDraft, markDraftMissing, markSending, materialize, resumeDraft, validRecipients, sendBody, sendHtml, setDraftUi, shownDraftKey, useDrafts, type LocalDraft } from "./drafts";

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
type FocusLease = { intent: number; threadId: number; key?: string; seq?: number; valid: boolean; dispose: () => void };
let focusLease: FocusLease | null = null;
const focusLeaseListeners = new Set<(threadId: number, fallback: boolean) => void>();

function releaseFocusLease(lease: FocusLease, fallback: boolean, notify = true) {
  if (focusLease !== lease) return;
  focusLease = null;
  lease.valid = false;
  lease.dispose();
  if (!fallback && lease.seq !== undefined && getApp().draftFocus?.seq === lease.seq) setApp({ draftFocus: null });
  if (notify) for (const listener of focusLeaseListeners) listener(lease.threadId, fallback);
}

function beginFocusLease(owner: number, threadId: number): FocusLease {
  if (focusLease) releaseFocusLease(focusLease, false, false);
  const active = typeof document === "undefined" ? null : document.activeElement;
  const lease: FocusLease = { intent: owner, threadId, valid: true, dispose: () => {} };
  const moved = (event: FocusEvent) => {
    if (event.target !== active && event.target !== document.body) releaseFocusLease(lease, false);
  };
  if (typeof document !== "undefined") document.addEventListener?.("focusin", moved, true);
  const unsubApp = useApp.subscribe((state, previous) => {
    if (state.scope !== null || state.checked.size >= 2) {
      if (focusLease === lease && lease.intent === intent) supersedeCompose();
    } else if (state.selectedId !== threadId || (state.dialog !== previous.dialog && state.dialog !== null) || (state.fatal !== previous.fatal && state.fatal !== null)) releaseFocusLease(lease, false);
  });
  const unsubDrafts = useDrafts.subscribe((state) => {
    const draft = lease.key ? state.drafts[lease.key] : undefined;
    if (state.held || (lease.key && (!draft || draft.uiState !== "open" || draft.sending || draft.recovery))) releaseFocusLease(lease, false);
  });
  lease.dispose = () => {
    if (typeof document !== "undefined") document.removeEventListener?.("focusin", moved, true);
    unsubApp(); unsubDrafts();
  };
  focusLease = lease;
  return lease;
}

/** Reader's passive focus must wait for this conversation's explicit compose focus. */
export const composeFocusPending = (threadId: number, key?: string, focusSeq?: number): boolean => focusLease?.threadId === threadId && focusLease.valid && getApp().selectedId === threadId && (key === undefined || (focusLease.key === key && focusLease.seq === focusSeq));
export const subscribeComposeFocus = (listener: (threadId: number, fallback: boolean) => void): (() => void) => {
  focusLeaseListeners.add(listener);
  return () => { focusLeaseListeners.delete(listener); };
};
export function finishComposeFocus(key: string, focusSeq: number, fallback: boolean): void {
  const lease = focusLease;
  if (lease?.key === key && lease.seq === focusSeq) releaseFocusLease(lease, fallback);
}
export const supersedeCompose = (): void => {
  ++intent;
  if (focusLease) releaseFocusLease(focusLease, false);
};

/** Asks the inline draft to take focus (only an explicit open does; coming back to a thread never does). */
export function focusDraft(key: string, target: "body" | "to", owner?: number) {
  const focusSeq = ++seq;
  if (focusLease && focusLease.intent === owner) { focusLease.key = key; focusLease.seq = focusSeq; }
  else if (focusLease) releaseFocusLease(focusLease, false);
  setApp({ draftFocus: { key, target, seq: focusSeq } });
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
  const finish = beginDraftWork();
  if (!finish) return;
  const mine = ++intent;
  const state = getApp();
  const lease = mode !== "new" && threadId !== null && state.selectedId === threadId && state.scope === null && state.checked.size < 2
    ? beginFocusLease(mine, threadId) : null;
  if (!lease && focusLease) releaseFocusLease(focusLease, false);
  const unsubSelection = !lease && mode !== "new" && threadId !== null ? useApp.subscribe((current) => {
    if (mine === intent && (current.scope !== null || current.checked.size >= 2)) supersedeCompose();
  }) : undefined;
  try { await openComposeNow(mode, threadId, mine, lease); } finally {
    unsubSelection?.();
    if (lease && lease.seq === undefined) releaseFocusLease(lease, true);
    finish();
  }
}

async function openComposeNow(mode: DraftMode, threadId: number | null, mine: number, lease: FocusLease | null): Promise<void> {
  let takeFocus = true;
  const active = typeof document === "undefined" ? null : document.activeElement;
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
  let existing = existingKey ? materialize(existingKey) : undefined;
  if (existing?.showSourceContext) {
    const snapshot = existing;
    const sourceId = snapshot.mode === "forward" ? snapshot.forwardOfMessageId : snapshot.mode === "new" ? null : snapshot.inReplyToMessageId;
    let context: { threadId: number; accountId: number } | null;
    try { context = sourceId ? await client.call("drafts.sourceContext", { messageId: sourceId }) : null; } catch { return; }
    const current = existingKey ? materialize(existingKey) : undefined;
    if (mine !== intent || getApp().selectedId !== s.selectedId || (lease && !lease.valid) || !current || current.id !== snapshot.id || current.generation !== snapshot.generation || current.revision !== snapshot.revision || current.localRev !== snapshot.localRev || current.accountId !== snapshot.accountId || current.mode !== snapshot.mode || current.inReplyToMessageId !== snapshot.inReplyToMessageId || current.forwardOfMessageId !== snapshot.forwardOfMessageId || current.showSourceContext !== snapshot.showSourceContext) return;
    if (!context || context.threadId !== threadId) {
      editDraft(current.key, { threadId: null, showSourceContext: false });
      showNewDraft(current.key);
      return;
    }
    existing = current;
  }
  if (existing && existing.mode === mode) {
    setDraftUi(existing.key, "open");
    return focusDraft(existing.key, target, mine);
  }
  const selected = s.selectedId;
  const detail = await loadThread(threadId);
  const currentIntent = () => mine === intent && getApp().selectedId === selected && shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) === existingKey;
  if (!detail || !currentIntent()) return;
  takeFocus = typeof document === "undefined" || document.activeElement === active;
  existing = existingKey ? materialize(existingKey) : undefined;
  if (existingKey && (!existing || existing.sending || existing.recovery)) return;
  const accounts = getApp().accounts;
  const source = accounts.find((a) => a.id === detail.thread.accountId);
  // none of my addresses is replied to, whichever account the conversation is in (plan 34)
  const identities = accounts.map((a) => a.email);
  if (mode === "forward") {
    const message = answered(detail, identities);
    const parts = message.attachments;
    const unavailable = () => snack.error(t("compose.forwardUnavailable"), { action: { label: t("common.retry"), onClick: () => {
      void client.call("attachments.retry", { accountId: message.accountId, messageId: message.id })
        .then(() => loadThread(threadId, true))
        .catch(() => snack.error(t("attachments.readerUnavailable")));
    } } });
    if (message.attachmentState !== "complete" || parts.some((a) => !a.assetId)) { unavailable(); return; }
    if (parts.length && !source) { snack.error(t("errors.accountGone")); return; }
    if (existing && forwardAccountMismatch(existing.accountId, detail, identities)) {
      snack.error(t("compose.forwardAccountMismatch", { account: source!.email }));
      return;
    }
    const snapshot = existing;
    try {
      const checked = new Map<string, AttachmentRef>();
      for (const part of parts) {
        const info = checked.get(part.assetId!) ?? await client.call("attachments.info", { accountId: message.accountId, assetId: part.assetId! });
        checked.set(part.assetId!, info);
        if (info.filename !== part.filename || info.mime !== part.mime || info.size !== part.size || (info.contentId ?? null) !== (part.contentId ?? null)) { unavailable(); return; }
      }
    } catch { if (currentIntent()) unavailable(); return; }
    if (!currentIntent() || await loadThread(threadId) !== detail) return;
    if (parts.length && !getApp().accounts.some((a) => a.id === source!.id)) { snack.error(t("errors.accountGone")); return; }
    existing = existingKey ? materialize(existingKey) : undefined;
    if (existingKey && (!existing || existing.sending || existing.recovery || existing.accountId !== snapshot?.accountId || existing.id !== snapshot?.id || existing.generation !== snapshot?.generation || existing.localRev !== snapshot?.localRev)) return;
    takeFocus = typeof document === "undefined" || document.activeElement === active;
    if (parts.length && existing && !existing.attachments?.length) {
      // Save the empty From transition before introducing that account's attachment owners.
      const active = typeof document === "undefined" ? null : document.activeElement;
      await flushDraft(existing.key);
      if (!currentIntent() || await loadThread(threadId) !== detail) return;
      takeFocus = takeFocus && (typeof document === "undefined" || document.activeElement === active);
      existing = materialize(existing.key);
      if (!existing || existing.sending || existing.recovery || existing.savedRev !== existing.localRev) return;
      const pristine = existing.id === null && existing.status === "clean" && existing.localRev === 0 && !authored(existing);
      if (existing.status !== "saved" && !pristine) return;
      if (!getApp().accounts.some((a) => a.id === source!.id)) { snack.error(t("errors.accountGone")); return; }
      if (forwardAccountMismatch(existing.accountId, detail, getApp().accounts.map((a) => a.email))) {
        snack.error(t("compose.forwardAccountMismatch", { account: source!.email }));
        return;
      }
    }
  }
  const account = source ?? accounts[0]!;
  const before = existing ? fieldsOf(existing) : undefined;
  const converted = existing && existing.mode !== "new" && written(existing)
    ? convertFields(before!, mode, detail, account, identities)
    : replyFields(mode, detail, account, { identities });
  if (converted === before) { snack.error(t("attachments.tooLarge")); return; }
  converted.showSourceContext = true;
  converted.attachments = mergeAttachmentRefs([], converted.attachments ?? []);
  const snapshot = existing;
  const signature = getApp().accounts.find((a) => a.id === converted.accountId)?.signature;
  const admitted = await draftAttachmentBudget(converted, signature);
  if (!currentIntent() || await loadThread(threadId) !== detail) return;
  const sourceId = converted.mode === "forward" ? converted.forwardOfMessageId : converted.inReplyToMessageId;
  let sourceContext: { threadId: number; accountId: number } | null;
  try { sourceContext = sourceId ? await client.call("drafts.sourceContext", { messageId: sourceId }) : null; } catch { return; }
  if (!currentIntent() || (lease && !lease.valid) || !sourceContext || sourceContext.threadId !== threadId || sourceContext.accountId !== detail.thread.accountId) return;
  existing = existingKey ? materialize(existingKey) : undefined;
  if (existingKey && (!existing || existing.sending || existing.recovery || existing.accountId !== snapshot?.accountId || existing.id !== snapshot?.id || existing.generation !== snapshot?.generation || existing.localRev !== snapshot?.localRev || existing.bodyVersion !== snapshot?.bodyVersion || existing.bodyText !== snapshot?.bodyText || existing.bodyHtml !== snapshot?.bodyHtml)) return;
  if (!getApp().accounts.some((a) => a.id === converted.accountId)) { snack.error(t("errors.accountGone")); return; }
  if (getApp().accounts.find((a) => a.id === converted.accountId)?.signature !== signature) return;
  if (!admitted) { snack.error(t("attachments.tooLarge")); return; }
  takeFocus = takeFocus && (typeof document === "undefined" || document.activeElement === active);
  if (existing && existing.mode !== "new") {
    if (!written(existing)) {
      // nothing written yet: simply the other mode, fresh
      editDraft(existing.key, converted);
      if (takeFocus && (!lease || lease.valid)) focusDraft(existing.key, target, mine);
      return;
    }
    editDraft(existing.key, converted);
    if (takeFocus && (!lease || lease.valid)) focusDraft(existing.key, target, mine);
    // back to what it was, still open where the user is looking
    const undo = registerUndo(() => editDraft(existing.key, { ...before!, uiState: "open" }));
    const [message, name] = CONVERTED[mode];
    snack(t(message), { action: { label: t("common.undo"), name: t(name), undo } });
    return;
  }
  const key = createDraft(converted);
  if (takeFocus && (!lease || lease.valid)) focusDraft(key, target, mine);
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
    if (prev.selectedId !== null && (s.selectedId !== prev.selectedId || (!prev.compose && s.compose) || (prev.checked.size < 2 && s.checked.size >= 2) || (prev.scope === null && s.scope !== null))) expireDraftPresentation(prev.selectedId);
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
  if (draftEditsHeld()) return false;
  if (useDrafts.getState().drafts[key]?.recovery) { snack.error(t("compose.recovery.sendBlocked")); return false; }
  if (attachmentUploading(key)) { snack.error(t("attachments.adding")); return false; }
  // read-only from here: nothing typed while the save in flight settles can fall between it and the send
  markSending(key, true);
  let preparing = true;
  try {
    const d = await draftForSend(key);
    preparing = false;
    if (!d || d.recovery) {
      markSending(key, false);
      resumeDraft(key);
      return false;
    }
    const to = validRecipients(d.toText);
    const cc = validRecipients(d.ccText);
    const bcc = validRecipients(d.bccText);
    // something typed that isn't an address (or nobody at all): stay, say what is wrong, and show it (plan 34 §2.6)
    const bad = (["to", "cc", "bcc"] as const).map((field) => ({ field, entry: firstInvalid(d[`${field}Text`]) })).find((b) => b.entry !== null);
    if (to.length === 0 || bad) {
      markSending(key, false);
      resumeDraft(key);
      snack.error(bad ? t("compose.invalidRecipient", { entry: bad.entry! }) : t("compose.noRecipient"));
      showRecipient(key, bad?.field ?? "to");
      return false;
    }
    breadcrumb("action", "action.send");
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
      draftGeneration: d.generation,
      attachments: d.attachments ?? [],
    });
    forgetDraft(key);
    if (getApp().compose?.key === key) setApp({ compose: null });
    invalidateThreads([res.threadId]);
    snack.success(t("compose.sending"));
    return true;
  } catch (error) {
    markSending(key, false);
    const e = error as { code?: string; details?: { reason?: string } } | null;
    if (e?.code === "STALE" && e.details?.reason === "draftMissing") {
      markDraftMissing(key);
      resumeDraft(key);
      snack.error(t("compose.recovery.sendBlocked"));
      return false;
    }
    resumeDraft(key, !preparing);
    if (e?.code === "STALE") { snack.error(t("compose.recovery.conflict")); return false; }
    captureUi(error, { code: "compose.send_failed" });
    snack.error(t("compose.sendFailed", { error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

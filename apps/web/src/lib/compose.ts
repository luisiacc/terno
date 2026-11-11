import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { formatAddressList, UNDO_SEND_MS, type Address, type AttachmentRef, type ThreadDetail } from "@terno/core";
import { attachmentUploading, draftAttachmentBudget } from "./attachments";
import { breadcrumb, captureUi } from "~/lib/diag";
import { useDraftRecovery } from "~/lib/draft-recovery-ui";
import { firstInvalid, SELECT_INVALID } from "./recipient-field";
import { clearEmptySend, sayProblem, useEmptySend } from "./send-problem";
import type { DraftMode } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { revealSent } from "./sent-reveal";
import { chooseOpenThread, getApp, getSelectionWriteRevision, markSelectionIntent, setApp, subscribeComposeSelectionIntent, useApp } from "~/state/app";
import { invalidateThreads, loadThread, useThreads } from "~/state/threads";
import { registerUndo, snack, useSnack } from "./snack";
import { answered, convertFields, forwardAccountMismatch, newFields, replyFields, mergeAttachmentRefs, subjectFor } from "./compose-fields";
import { sentRefs, withSentImages } from "./inline-images";
import { ensureForwardFiles, fetchForwardFiles, setForwardOpenProbe } from "./forward-files";
export { answered, autoRecipients, convertFields, newFields, quoteFor, replyFields, subjectFor } from "./compose-fields";
import { beginDraftAckRead, beginComposeBodyAckRead, beginForwardEmptyOwnerRead, sealForwardEmptyOwnerRead, readDraftAck, endDraftAckRead, beginDraftWork, comingHome, draftIndex, invalidateDraftPresentation, loseDraftHome, returnDraftToThread, draftPresentationThread, expireDraftPresentation, validateDraftPresentation, draftEditsHeld, draftHoldRevision, authored, createDraft, createDraftWithReceipt, discardIfEmpty, draftForSend, editDraft, emptyMessage, fieldsOf, flushDraft, forgetDraft, markDraftMissing, markSending, materialize, nothingWrittenIn, resumeDraft, validRecipients, sendBody, sendHtml, setDraftUi, shownDraftKey, useDrafts, validBodyCheckpoint, type BodyCheckpoint, type DraftAckRead, type DraftFields, type LocalDraft } from "./drafts";
import { focusPinned, pinnedKey, usePinned } from "./pinned-draft-state";
import { focusField, focusSelector, prepareEarlyComposeInput, prepareInlineFocusMove, type ComposeFocusTarget, type EarlyComposeInput } from "./compose-focus-move";
import { aiDraftHooks, isNote } from "./ai-draft-state";
import { fromPlainText, parseHtml, toEmailHtml, toPlainText } from "@terno/richtext";
import { parseAddressList } from "@terno/core";
import { controllerFor } from "~/components/composer/controller";
import { cancelHeldSend, scheduledSnack, sendingSnack } from "./scheduled";
import { holdSend } from "./held-sends";
import { playSendSound, primeSendSound } from "./sounds";

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
type ReaderDestination = { token: object; active: boolean; generation: number };
type FocusLease = { mode?: DraftMode; earlyInput?: EarlyComposeInput; selectionRevision: number; ackRead?: DraftAckRead; stopSelection?: () => void; stopContext?: () => void; intent: number; threadId: number | null; composeSeq?: number; accountId?: number; key?: string; seq?: number; valid: boolean; dispose: () => void; view?: { id: LocalDraft["id"]; generation: LocalDraft["generation"]; revision: number; localRev: number; uiState: LocalDraft["uiState"]; recovery: LocalDraft["recovery"]; missingAccount: boolean; sending: boolean }; destination?: ReaderDestination };
const readerDestinations = new Map<number, ReaderDestination>();
const failedReaderHosts = new Map<object, { threadId: number }>();
const readerFailed = (threadId: number): boolean => {
  for (const host of failedReaderHosts.values()) if (host.threadId === threadId) return true;
  return false;
};
const destinationAvailable = (lease: FocusLease | null): boolean => !lease ||
  ((lease.threadId === null || !readerFailed(lease.threadId)) && (!lease.destination || lease.destination.active));
let focusLease: FocusLease | null = null;
const focusLeaseListeners = new Set<(threadId: number, fallback: boolean) => void>();

function notifyReleased(lease: FocusLease, owner: number, fallback: boolean) {
  if (lease.threadId !== null) for (const listener of focusLeaseListeners) {
    if (intent !== owner || focusLease) break;
    listener(lease.threadId, fallback);
  }
}

function releaseFocusLease(lease: FocusLease, fallback: boolean, notify = true) {
  if (!lease.valid) return;
  const current = focusLease === lease, releaseIntent = intent;
  lease.valid = false;
  lease.stopSelection?.(); lease.stopSelection = undefined;
  lease.stopContext?.(); lease.stopContext = undefined;
  if (lease.ackRead) { endDraftAckRead(lease.ackRead); lease.ackRead = undefined; }
  lease.dispose();
  if (!current) return;
  focusLease = null;
  if (!fallback && lease.seq !== undefined && getApp().draftFocus?.seq === lease.seq) setApp({ draftFocus: null });
  if (notify) notifyReleased(lease, releaseIntent, fallback);
}

function releaseForAcquisition(lease: FocusLease, notify = false): boolean {
  const owner = intent, revision = getSelectionWriteRevision();
  const active = typeof document === "undefined" ? null : document.activeElement;
  let changed = false;
  const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) changed = true; };
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.selectedId !== previous.selectedId || state.readerOpen !== previous.readerOpen || state.compose !== previous.compose || state.checked !== previous.checked || state.scope !== previous.scope || state.accountId !== previous.accountId || state.dialog !== previous.dialog || state.fatal !== previous.fatal || state.view !== previous.view || state.categoryId !== previous.categoryId || state.query !== previous.query) changed = true;
  });
  if (typeof document !== "undefined") document.addEventListener?.("focusin", observe, true);
  try { releaseFocusLease(lease, false, notify); }
  finally { unsubscribe(); if (typeof document !== "undefined") document.removeEventListener?.("focusin", observe, true); }
  changed ||= getSelectionWriteRevision() !== revision;
  if (changed && !notify) notifyReleased(lease, owner, false);
  return changed;
}

/** The current Reader owns focus work only until this exact destination leaves. */
export function registerReaderFocusDestination(threadId: number, token: object): () => void {
  const previous = readerDestinations.get(threadId);
  const destination = previous?.token === token ? previous : { token, active: false, generation: 0 };
  destination.active = true;
  const generation = ++destination.generation;
  readerDestinations.set(threadId, destination);
  if (focusLease?.threadId === threadId && (!focusLease.destination || !focusLease.destination.active)) focusLease.destination = destination;
  return () => {
    if (destination.generation !== generation || !destination.active) return;
    destination.active = false;
    if (focusLease?.destination === destination) { focusLease.stopSelection?.(); focusLease.stopSelection = undefined; focusLease.stopContext?.(); focusLease.stopContext = undefined; }
    if (focusLease?.destination === destination && focusLease.ackRead) { endDraftAckRead(focusLease.ackRead); focusLease.ackRead = undefined; }
    const captured = focusLease?.destination === destination ? focusLease : null;
    queueMicrotask(() => {
      if (destination.active || destination.generation !== generation || readerDestinations.get(threadId) !== destination) return;
      readerDestinations.delete(threadId);
      expireDraftPresentation(threadId);
      if (captured && focusLease === captured && captured.destination === destination && captured.intent === intent) supersedeCompose();
    });
  };
}

/** A failed Reader cannot accept focus work until this exact fallback leaves. */
export function registerReaderPaneFailure(threadId: number, token: object): () => void {
  const host = { threadId };
  failedReaderHosts.set(token, host);
  if (focusLease?.threadId === threadId && focusLease.intent === intent) supersedeCompose();
  return () => { if (failedReaderHosts.get(token) === host) failedReaderHosts.delete(token); };
}

function beginFocusLease(owner: number, threadId: number | null, standalone?: { key: string; seq: number }): FocusLease | undefined {
  if (owner !== intent) return;
  const before = getApp();
  const previous = focusLease;
  if (previous && releaseForAcquisition(previous)) return;
  const after = getApp();
  if (owner !== intent || after.selectedId !== before.selectedId || after.accountId !== before.accountId || after.compose !== before.compose || after.scope !== before.scope || after.checked !== before.checked || after.dialog !== before.dialog || after.fatal !== before.fatal || draftEditsHeld()) {
    if (previous) notifyReleased(previous, owner, false);
    return;
  }
  const active = typeof document === "undefined" ? null : document.activeElement;
  const selected = getApp().selectedId, account = getApp().accountId;
  const destination = threadId === null ? undefined : readerDestinations.get(threadId);
  const viewed = standalone ? useDrafts.getState().drafts[standalone.key] : undefined;
  const lease: FocusLease = { intent: owner, threadId, selectionRevision: getSelectionWriteRevision(), valid: true, dispose: () => {}, destination, ...(viewed ? { view: { id: viewed.id, generation: viewed.generation, revision: viewed.revision, localRev: viewed.localRev, uiState: viewed.uiState, recovery: viewed.recovery, sending: viewed.sending, missingAccount: !getApp().accounts.some((a) => a.id === viewed.accountId) } } : {}), ...(standalone ? { key: standalone.key, composeSeq: standalone.seq, accountId: useDrafts.getState().drafts[standalone.key]?.accountId } : {}) };
  const moved = (event: FocusEvent) => {
    if (event.target !== active && event.target !== document.body && !lease.earlyInput?.owns(event.target as Element)) releaseFocusLease(lease, false);
  };
  if (typeof document !== "undefined") document.addEventListener?.("focusin", moved, true);
  const unsubApp = useApp.subscribe((state, previous) => {
    if (state.scope !== null || state.checked.size >= 2) {
      if (focusLease === lease && lease.intent === intent) supersedeCompose();
    } else if ((threadId === null ? state.selectedId !== selected || state.compose?.key !== lease.key || state.compose?.seq !== lease.composeSeq : state.selectedId !== threadId) || state.accountId !== account || (!lease.view?.missingAccount && lease.accountId !== undefined && !state.accounts.some((a) => a.id === lease.accountId)) || (state.dialog !== previous.dialog && state.dialog !== null) || (state.fatal !== previous.fatal && state.fatal !== null)) releaseFocusLease(lease, false);
  });
  const unsubDrafts = useDrafts.subscribe((state) => {
    const draft = lease.key ? state.drafts[lease.key] : undefined;
    if (state.held || (lease.key && (!draft || (lease.view ? draft.sending !== lease.view.sending : draft.sending) || (lease.view ? draft.uiState !== lease.view.uiState || draft.localRev !== lease.view.localRev || draft.id !== lease.view.id || draft.generation !== lease.view.generation || draft.revision !== lease.view.revision || draft.recovery !== lease.view.recovery : draft.uiState !== "open" || draft.recovery) || (lease.accountId !== undefined && draft.accountId !== lease.accountId)))) releaseFocusLease(lease, false);
  });
  lease.dispose = () => {
    if (typeof document !== "undefined") document.removeEventListener?.("focusin", moved, true);
    lease.earlyInput?.cancel();
    unsubApp(); unsubDrafts();
  };
  focusLease = lease;
  if (destination && !destination.active) queueMicrotask(() => {
    if (focusLease === lease && lease.destination === destination && !destination.active && lease.intent === intent) supersedeCompose();
  });
  return lease;
}

/** What an open still on its way to this conversation will be: ⌘J arriving meanwhile goes along with it, Reply all staying Reply all. */
export const composeOpening = (threadId: number): DraftMode | undefined => focusLease?.valid && focusLease.threadId === threadId ? focusLease.mode : undefined;

/**
 * Words typed while an open was on its way, whose open ended before they could go in: by conversation, until a draft lands
 * on it. They're the text's, whatever that open's focus is for. Only for the moment that takes: with no open left, they
 * become that conversation's draft, put away as Esc would have put it (`keepStrandedWords`), so they're saved like typing.
 * What's known of the conversation when they're stranded (its account and subject) comes along, so that a conversation
 * that can't be read by then still gets them saved: as a new message on its account (Codex series review).
 */
const strandedWords = new Map<number, { words: string; accountId?: number; subject?: string }>();

/** They go in as what's next in the text, with the editor's own undo when it's on screen; false if the draft can't change now. */
function addWords(key: string, words: string): boolean {
  const c = controllerFor(key);
  if (c) return c.insertGenerated(words, "below") !== null;
  const d = materialize(key);
  if (!d) return false;
  if (d.bodyHtml) return editDraft(key, { bodyHtml: `${d.bodyHtml}${toEmailHtml(fromPlainText(words))}`, bodyText: `${d.bodyText}\n\n${words}` });
  return editDraft(key, { bodyText: d.bodyText ? `${d.bodyText}\n\n${words}` : words });
}

function strandWords(threadId: number, words: string, key: string | null): void {
  if (key && addWords(key, words)) return;
  const before = strandedWords.get(threadId), known = useThreads.getState().details.get(threadId)?.thread;
  strandedWords.set(threadId, { words: [before?.words, words].filter(Boolean).join("\n\n"), accountId: known?.accountId ?? before?.accountId, subject: known?.subject ?? before?.subject });
}

function placeStrandedWords(threadId: number, key: string): void {
  const words = strandedWords.get(threadId)?.words;
  if (words && addWords(key, words)) strandedWords.delete(threadId);
}

/** Words that can't go in yet (drafts held, no account to keep them on) wait for that to change, not for a timer. */
const strandRetry = new Set<number>();
function retryStrandedOnChange(threadId: number): void {
  if (strandRetry.has(threadId)) return;
  strandRetry.add(threadId);
  const again = () => {
    if (!strandRetry.delete(threadId)) return;
    stopDrafts(); stopApp();
    void keepStrandedWords(threadId);
  };
  const stopDrafts = useDrafts.subscribe((state, previous) => { if (previous.held && !state.held) again(); });
  const stopApp = useApp.subscribe((state, previous) => { if (state.accounts !== previous.accounts) again(); });
}

/** Nothing landed for them: a reply on that conversation, collapsed, or the draft it has. */
async function keepStrandedWords(threadId: number): Promise<void> {
  const detail = await loadThread(threadId);
  const stranded = strandedWords.get(threadId);
  // another open came meanwhile: its landing takes them
  if (!stranded || openingNow > 0) return;
  if (draftEditsHeld()) return retryStrandedOnChange(threadId);
  const drafts = useDrafts.getState().drafts;
  const existing = shownDraftKey(drafts, threadId, getApp().draftShown) ?? comingHome(drafts, threadId)[0]?.key;
  if (existing) return placeStrandedWords(threadId, existing);
  const accounts = getApp().accounts;
  const account = detail && accounts.find((a) => a.id === detail.thread.accountId);
  let key: string;
  if (detail && account) key = createDraft({ ...replyFields("reply", detail, account, { identities: accounts.map((a) => a.email) }), showSourceContext: true, uiState: "collapsed", bodyText: stranded.words });
  else {
    // the conversation can't be read (gone, or the backend didn't answer): they're kept as a new message, which needs nothing from it
    const accountId = accounts.find((a) => a.id === (detail?.thread.accountId ?? stranded.accountId))?.id ?? getApp().accountId ?? accounts[0]?.id;
    if (accountId === undefined) return retryStrandedOnChange(threadId);
    const subject = detail?.thread.subject ?? stranded.subject;
    key = createDraft({ ...newFields(accountId), ...(subject ? { subject: subjectFor("reply", subject), subjectEdited: true } : {}), uiState: "collapsed", bodyText: stranded.words });
  }
  strandedWords.delete(threadId);
  editDraft(key, {});
  void flushDraft(key);
  if (getApp().selectedId !== threadId) expireDraftPresentation(threadId);
}

/** Reader's passive focus must wait for this conversation's explicit compose focus. */
/** How many opens have begun: one begun after a given count supersedes those before it (plan 175's drafts row). */
export const composeIntent = (): number => intent;
export const composeFocusPending = (threadId: number | null, key?: string, focusSeq?: number): boolean => focusLease?.threadId === threadId && focusLease.valid && focusLease.selectionRevision === getSelectionWriteRevision() && (threadId === null ? getApp().compose?.key === focusLease.key && getApp().compose?.seq === focusLease.composeSeq : getApp().selectedId === threadId) && (key === undefined || (focusLease.key === key && focusLease.seq === focusSeq));
export const subscribeComposeFocus = (listener: (threadId: number, fallback: boolean) => void): (() => void) => {
  focusLeaseListeners.add(listener);
  return () => { focusLeaseListeners.delete(listener); };
};
export function finishComposeFocus(key: string, focusSeq: number, fallback: boolean): boolean {
  const lease = focusLease;
  if (!lease?.valid || lease.intent !== intent || lease.key !== key || lease.seq !== focusSeq) return false;
  const owner = intent, revision = getSelectionWriteRevision(), focusRevision = seq;
  let changed = draftEditsHeld() || lease.selectionRevision !== revision;
  const unsubscribeDrafts = useDrafts.subscribe((state, previous) => { if (state.held || previous.held) changed = true; });
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.draftFocus !== previous.draftFocus && !(state.draftFocus === null && previous.draftFocus?.seq === focusSeq)) changed = true;
    if (state.selectedId !== previous.selectedId || state.readerOpen !== previous.readerOpen || state.compose !== previous.compose || state.checked !== previous.checked || state.scope !== previous.scope || state.accountId !== previous.accountId || state.dialog !== previous.dialog || state.fatal !== previous.fatal || state.view !== previous.view || state.categoryId !== previous.categoryId || state.reviewCategoryId !== previous.reviewCategoryId || state.query !== previous.query || state.listFilters !== previous.listFilters) changed = true;
  });
  try { releaseFocusLease(lease, changed ? false : fallback); }
  finally { unsubscribe(); unsubscribeDrafts(); }
  return !changed && !draftEditsHeld() && seq === focusRevision && getSelectionWriteRevision() === revision && intent === owner && focusLease === null;
}
export const supersedeCompose = (): void => {
  ++intent;
  if (focusLease) releaseFocusLease(focusLease, false);
};

/** Asks the inline draft to take focus (only an explicit open does; coming back to a thread never does). */
export function focusDraft(key: string, target: ComposeFocusTarget, owner?: number) {
  const current = intent;
  if (owner !== undefined && owner !== current) return;
  const originalLease = focusLease && focusLease.intent === owner ? focusLease : null;
  const hold = draftHoldRevision();
  const selection = getSelectionWriteRevision();
  if (!originalLease && draftEditsHeld()) return;
  const previousSeq = seq;
  let expectedSeq = previousSeq, published: ReturnType<typeof getApp>["draftFocus"];
  const valid = () => intent === current && seq === expectedSeq && !draftEditsHeld() && draftHoldRevision() === hold && getSelectionWriteRevision() === selection;
  const move = !originalLease && typeof document !== "undefined" ? prepareInlineFocusMove(valid, () => {
    if (published && getApp().draftFocus === published) setApp({ draftFocus: null });
  }) : undefined;
  let committed = false;
  try {
    if (focusLease && focusLease.intent !== owner) releaseFocusLease(focusLease, false);
    if (intent !== current || seq !== previousSeq || (!originalLease && (!valid() || (move && !move.active()))) || (originalLease && (focusLease !== originalLease || !originalLease.valid))) return;
    const focusSeq = ++seq;
    expectedSeq = focusSeq;
    if (originalLease) { originalLease.key = key; originalLease.seq = focusSeq; originalLease.earlyInput?.arm(key, target); }
    published = { key, target, seq: focusSeq, ...(originalLease ? { leased: true as const } : { move }) };
    setApp({ draftFocus: published });
    committed = true;
  } finally {
    if (!committed) move?.cancel();
  }
}

/** Is the conversation's draft the pinned one (its placement may have expired since it was pinned)? */
function pinnedFor(threadId: number, shown: ReturnType<typeof getApp>["draftShown"]): boolean {
  const pinned = usePinned.getState();
  return pinned.key !== null && (pinned.threadId === threadId || shownDraftKey(useDrafts.getState().drafts, threadId, shown) === pinned.key);
}

/** Does a draft carry anything the user wrote? */
const written = (d: LocalDraft) => d.bodyText.trim() !== "" || d.subjectEdited || d.localRev > 0 || (d.attachments?.length ?? 0) > 0;

const activeSourceId = (d: LocalDraft) => d.mode === "forward" ? d.forwardOfMessageId : d.mode === "new" ? null : d.inReplyToMessageId;
function sameStoredDraft(snapshot: LocalDraft, viewing = false): boolean {
  const d = materialize(snapshot.key);
  return Boolean(d && d === useDrafts.getState().drafts[snapshot.key] && (viewing || !d.sending) && shallow(d, snapshot));
}
const openedDraft = (d: LocalDraft): LocalDraft => d.uiState === "open" ? d : { ...d, uiState: "open", ...(d.id !== null ? { localRev: d.localRev + 1, status: d.status === "saving" ? "saving" : "dirty" } : {}) };

/** Collapse one draft without letting its exit focus overtake a newer choice. */
export function collapseInlineDraft(key: string): (() => boolean) | undefined {
  const baseline = getApp(), revision = getSelectionWriteRevision();
  const active = typeof document === "undefined" ? null : document.activeElement;
  let changed = false;
  const owner = ++intent;
  const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) changed = true; };
  const unsubscribeDrafts = useDrafts.subscribe((state, previous) => { if (state.held || previous.held) changed = true; });
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.selectedId !== previous.selectedId || state.readerOpen !== previous.readerOpen || state.compose !== previous.compose || state.checked !== previous.checked || state.scope !== previous.scope || state.accountId !== previous.accountId || state.dialog !== previous.dialog || state.fatal !== previous.fatal || state.view !== previous.view || state.categoryId !== previous.categoryId || state.reviewCategoryId !== previous.reviewCategoryId || state.query !== previous.query || state.listFilters !== previous.listFilters) changed = true;
  });
  if (typeof document !== "undefined") document.addEventListener?.("focusin", observe, true);
  try {
    if (focusLease) releaseFocusLease(focusLease, false);
    if (owner !== intent || changed || getSelectionWriteRevision() !== revision) return;
    setDraftUi(key, "collapsed");
    void flushDraft(key);
  } finally {
    unsubscribe(); unsubscribeDrafts();
    if (typeof document !== "undefined") document.removeEventListener?.("focusin", observe, true);
  }
  if (changed) return;
  return () => {
    const state = getApp(), draft = useDrafts.getState().drafts[key];
    return owner === intent && getSelectionWriteRevision() === revision && !draftEditsHeld() && Boolean(draft && !draft.sending && draft.uiState === "collapsed") && state.selectedId === baseline.selectedId && state.readerOpen === baseline.readerOpen && state.compose === baseline.compose && state.checked === baseline.checked && state.scope === baseline.scope && state.accountId === baseline.accountId && state.dialog === baseline.dialog && state.fatal === baseline.fatal && state.view === baseline.view && state.categoryId === baseline.categoryId && state.reviewCategoryId === baseline.reviewCategoryId && state.query === baseline.query && state.listFilters === baseline.listFilters;
  };
}

/** Reopen the visible collapsed draft under the same focus ownership as an explicit compose. */
export function reopenInlineDraft(threadId: number, key: string, checkpoint?: BodyCheckpoint, beforeCheckpointOpen?: () => () => void): void {
  const finish = beginDraftWork();
  if (!finish) return;
  markSelectionIntent();
  chooseOpenThread();
  const mine = ++intent;
  if (checkpoint) {
    try {
      const recovery = useDraftRecovery.getState(), draft = useDrafts.getState().drafts[key];
      if (!recovery.open || recovery.key !== key || recovery.checkpoint !== checkpoint || checkpoint.key !== key || !validBodyCheckpoint(checkpoint) || !draft) return;
      const expected = openedDraft(draft);
      const cancel = beforeCheckpointOpen?.();
      let accepted = false;
      try {
        const current = () => { const state = useDraftRecovery.getState(); return mine === intent && state.open && state.key === key && state.checkpoint === checkpoint && validBodyCheckpoint(checkpoint); };
        if (!current() || useDrafts.getState().drafts[key] !== draft) return;
        setDraftUi(key, "open");
        if (!current() || !shallow(useDrafts.getState().drafts[key], expected)) return;
        accepted = true;
      } finally { if (!accepted) cancel?.(); }
    } finally { finish(); }
    return;
  }
  const leased = getApp().selectedId === threadId;
  const lease = leased ? beginFocusLease(mine, threadId) : null;
  if (leased && !lease) { finish(); return; }
  const active = typeof document === "undefined" ? null : document.activeElement;
  let moved = false;
  const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) moved = true; };
  if (typeof document !== "undefined") document.addEventListener?.("focusin", observe, true);
  try {
    const draft = materialize(key);
    if (!draft || !sameStoredDraft(draft)) return;
    const expected = openedDraft(draft);
    setDraftUi(key, "open");
    if (!moved && mine === intent && (!lease || (lease.valid && focusLease === lease && destinationAvailable(lease))) && sameStoredDraft(expected)) focusDraft(key, "body", mine);
  } finally {
    if (typeof document !== "undefined") document.removeEventListener?.("focusin", observe, true);
    if (lease && lease.seq === undefined) releaseFocusLease(lease, true);
    finish();
  }
}

const invalidatedPresentation = (d: LocalDraft, homeLost = false): LocalDraft => ({ ...d, departedThreadId: d.departedThreadId ?? draftPresentationThread(d) ?? undefined, presentationThreadId: undefined, presentationExpired: true, presentationEpoch: (d.presentationEpoch ?? 0) + 1, ...(homeLost ? { homeLost } : {}) });
const validatedPresentation = (d: LocalDraft, threadId: number): LocalDraft => ({ ...d, presentationThreadId: undefined, sourceContextThreadId: threadId, presentationExpired: false, homeLost: undefined, presentationEpoch: (d.presentationEpoch ?? 0) + 1 });

/** The conversation whose drafts are being checked on the way back: its slot waits rather than offer a blank Reply for a moment. */
export const useDraftsReturning = create<{ threadId: number | null }>(() => ({ threadId: null }));

/**
 * The reader arrives at a conversation (plan 158): what was written there comes back with it, as the one line it was put
 * away as. Leaving retired the draft's place (plan 44), so its source is checked first, one point read each, and only then
 * does its text show; a draft the check turns away stays in the strip. An explicit open under way owns the draft and does
 * its own check. Focus stays where it is, and a conversation with no such draft costs one map read: this runs on j/k.
 */
export function returnDraftsTo(threadId: number): () => void {
  const candidates = comingHome(useDrafts.getState().drafts, threadId).filter((d) => d.key !== pinnedKey() && !aiDraftHooks.working(d.key) && !openingStored.has(d.key));
  if (candidates.length === 0) return () => {};
  const before = intent, owner = {};
  let left = false;
  returning = owner;
  useDraftsReturning.setState({ threadId });
  const settled = () => { if (returning === owner) { returning = null; useDraftsReturning.setState({ threadId: null }); } };
  void Promise.all(candidates.map(async (d) => {
    const source = activeSourceId(d);
    // asked by each arrival: an answer from before leaving may be about where the source was then
    const context = source === null ? null : await client.call("drafts.sourceContext", { messageId: source }).catch(() => null);
    if (left) return;
    const now = useDrafts.getState().drafts[d.key];
    if (!now?.presentationExpired || intent !== before || openingStored.has(d.key) || draftEditsHeld()) return;
    // the answer is about the draft as it was asked for: anything else about it (a save's normalization) is asked again
    if (now.presentationEpoch !== d.presentationEpoch || now.id !== d.id || now.generation !== d.generation || now.revision !== d.revision || now.accountId !== d.accountId || now.mode !== d.mode || activeSourceId(now) !== source || !now.showSourceContext || now.recovery) return;
    if (context?.threadId !== threadId) loseDraftHome(d.key);
    else if (getApp().selectedId === threadId) returnDraftToThread(d.key, threadId);
  })).finally(settled);
  return () => { left = true; settled(); };
}
let returning: object | null = null;
/** drafts `openStoredDraft` is opening, and how many times: it checks them itself, and a change under it would call its open off */
const openingStored = new Map<string, number>();

function showStoredStandalone(key: string, owner: number, allowed: () => boolean = () => true, transfer?: FocusLease | null): FocusLease | null {
  let snapshot = materialize(key);
  const previous = getApp(), { selectedId, accountId } = previous;
  const permitted = () => owner === intent && allowed() && !draftEditsHeld() && !getApp().dialog && !getApp().fatal && getApp().selectedId === selectedId && getApp().accountId === accountId && snapshot !== undefined && sameStoredDraft(snapshot, true);
  const transferable = () => !transfer || (focusLease === transfer && transfer.valid && destinationAvailable(transfer));
  if (!permitted() || !transferable()) return null;
  if (focusLease && focusLease !== transfer && releaseForAcquisition(focusLease)) return null;
  if (!permitted() || !snapshot) return null;
  // opened on its own: it's the strip's from here on, not a row's
  snapshot = invalidatedPresentation(snapshot, true);
  const active = typeof document === "undefined" ? null : document.activeElement;
  const selectionRevision = getSelectionWriteRevision();
  let changed = false, locationChanged = false, expected = getApp();
  const baseline = expected;
  let publicationOwner: typeof expected.compose = null;
  const sameLocation = (a: typeof expected, b: typeof expected) => a.selectedId === b.selectedId && a.readerOpen === b.readerOpen && a.compose === b.compose && a.checked === b.checked && a.scope === b.scope && a.accountId === b.accountId && a.dialog === b.dialog && a.fatal === b.fatal && a.view === b.view && a.categoryId === b.categoryId && a.reviewCategoryId === b.reviewCategoryId && a.query === b.query && a.listFilters === b.listFilters;
  const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) changed = true; };
  const unsubscribe = useApp.subscribe((state, previousState) => {
    const ownPublication = publicationOwner !== null && state.compose === publicationOwner && sameLocation(previousState, baseline);
    if (!sameLocation(state, expected) || (!sameLocation(previousState, expected) && !ownPublication)) { changed = true; locationChanged = true; }
  });
  const current = () => !changed && getSelectionWriteRevision() === selectionRevision && permitted();
  if (typeof document !== "undefined") document.addEventListener?.("focusin", observe, true);
  try {
    invalidateDraftPresentation(key, true);
    if (!current() || !transferable()) return null;
    const compose = { key, seq: ++seq, storedFocusSeq: ++seq };
    const lease = beginFocusLease(owner, null, compose);
    if (!lease) return null;
    lease.seq = compose.storedFocusSeq;
    if (!current() || focusLease !== lease || !lease.valid) { releaseFocusLease(lease, false); return null; }
    const publication = { compose, checked: new Set<number>(), scope: null, readerOpen: false, draftFocus: { key, target: resumeTarget(key), seq: compose.storedFocusSeq, leased: true as const } };
    expected = { ...getApp(), ...publication };
    publicationOwner = publication.compose;
    setApp(publication);
    if (!current() || focusLease !== lease || !lease.valid || getApp().compose !== compose) {
      releaseFocusLease(lease, false);
      const state = getApp();
      if (state.compose === compose && (owner !== intent || locationChanged)) setApp({ compose: null, ...(owner !== intent && state.selectedId === selectedId && state.accountId === accountId ? { readerOpen: previous.readerOpen } : {}) });
      return null;
    }
    return lease;
  } finally {
    unsubscribe();
    if (typeof document !== "undefined") document.removeEventListener?.("focusin", observe, true);
  }
}

/**
 * Plan 175: the drafts row counts drafts that are open on screen too. One of those is focused where it is (the
 * editor keeps its caret, the pane its scroll), as a later choice than any open still on its way; nothing is looked
 * up or opened again. False when it isn't open on screen: then it's for `openStoredDraft`.
 */
export function focusDraftOnScreen(key: string): boolean {
  if (typeof document === "undefined" || useDrafts.getState().drafts[key]?.uiState !== "open") return false;
  const form = document.querySelector<HTMLElement>(`form[data-testid=composer][data-draft-key="${CSS.escape(key)}"]`);
  const el = form && !form.closest("[inert]") ? form.querySelector<HTMLElement>(focusSelector(resumeTarget(key))) : null;
  if (!el) return false;
  markSelectionIntent();
  ++intent;
  focusField(el);
  return true;
}

/** Open stored work under the same private intent and destination ownership as Reply/Forward. */
export async function openStoredDraft(key: string): Promise<void> {
  if (key === pinnedKey()) { focusPinned(); return; }
  if (getApp().compose?.key === key && useDrafts.getState().drafts[key]?.sending) return;
  const finish = beginDraftWork();
  if (!finish) return;
  markSelectionIntent();
  const mine = ++intent;
  if (focusLease && releaseForAcquisition(focusLease)) { finish(); return; }
  if (mine !== intent) { finish(); return; }
  openingStored.set(key, (openingStored.get(key) ?? 0) + 1);
  let lease: FocusLease | null = null, cancelled = false, missingFromAtStart = false;
  let expected = getApp();
  let publicationBefore: typeof expected | undefined;
  const active = typeof document === "undefined" ? null : document.activeElement;
  const moved = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) cancelled = true; };
  if (typeof document !== "undefined") document.addEventListener?.("focusin", moved, true);
  const sameLocation = (state: typeof expected, baseline: typeof expected) => state.selectedId === baseline.selectedId && state.readerOpen === baseline.readerOpen && state.compose === baseline.compose && state.checked === baseline.checked && state.scope === baseline.scope && state.accountId === baseline.accountId && state.dialog === baseline.dialog && state.fatal === baseline.fatal && state.view === baseline.view && state.categoryId === baseline.categoryId && state.reviewCategoryId === baseline.reviewCategoryId && state.query === baseline.query && state.listFilters === baseline.listFilters;
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (!sameLocation(state, expected) || (!sameLocation(previous, expected) && (!publicationBefore || !sameLocation(previous, publicationBefore)))) cancelled = true;
  });
  const locationCurrent = () => sameLocation(getApp(), expected);
  const current = (d: LocalDraft) => locationCurrent() && mine === intent && !cancelled && !draftEditsHeld() && !getApp().dialog && !getApp().fatal && destinationAvailable(lease) && (!lease || lease.valid) && (missingFromAtStart || getApp().accounts.some((a) => a.id === d.accountId)) && sameStoredDraft(d, true);
  try {
    let snapshot = materialize(key);
    if (!snapshot) return;
    const fromAccount = snapshot.accountId;
    missingFromAtStart = !getApp().accounts.some((a) => a.id === fromAccount);
    if (!current(snapshot)) return;
    const standalone = () => {
      if (!snapshot || !current(snapshot)) return;
      unsubscribe();
      lease = showStoredStandalone(key, mine, () => !cancelled);
    };
    if (snapshot.recovery || missingFromAtStart) { standalone(); return; }
    const sourceId = activeSourceId(snapshot);
    const canonical = sourceId === null && snapshot.mode !== "new" && !snapshot.showSourceContext ? snapshot.threadId : null;
    if ((sourceId === null && canonical === null) || (!snapshot.showSourceContext && snapshot.threadId === null)) { standalone(); return; }
    const context = canonical !== null ? { threadId: canonical, accountId: snapshot.accountId } : await client.call("drafts.sourceContext", { messageId: sourceId! });
    if (!current(snapshot)) return;
    if (!context) { standalone(); return; }
    snapshot = invalidatedPresentation(snapshot);
    invalidateDraftPresentation(key);
    if (!current(snapshot)) return;
    const selectionRevision = getSelectionWriteRevision();
    const destination = { selectedId: context.threadId, readerOpen: true, compose: null, checked: new Set<number>(), scope: null };
    publicationBefore = expected;
    expected = { ...getApp(), ...destination };
    try { setApp(destination); } finally { publicationBefore = undefined; }
    if (getSelectionWriteRevision() !== selectionRevision + 1 || !current(snapshot)) return;
    lease = beginFocusLease(mine, context.threadId) ?? null;
    if (!lease) return;
    lease.accountId = snapshot.accountId;
    const detail = canonical !== null ? await loadThread(context.threadId, true) : await loadThread(context.threadId);
    if (!current(snapshot)) return;
    const latest = canonical !== null ? context : await client.call("drafts.sourceContext", { messageId: sourceId! });
    if (!current(snapshot)) return;
    if (!detail || detail.thread.id !== context.threadId || !latest || latest.threadId !== context.threadId || latest.accountId !== detail.thread.accountId) { standalone(); return; }
    // A settled unavailable pane has no destination to consume this request.
    if (!lease.destination?.active) return;
    snapshot = validatedPresentation(snapshot, context.threadId);
    validateDraftPresentation(key, context.threadId);
    if (!current(snapshot)) return;
    const opening = snapshot.uiState !== "open";
    snapshot = { ...snapshot, uiState: "open", ...(opening && snapshot.id !== null ? { localRev: snapshot.localRev + 1, status: snapshot.status === "saving" ? "saving" as const : "dirty" as const } : {}) };
    setDraftUi(key, "open");
    if (!current(snapshot)) return;
    setApp({ draftShown: { threadId: context.threadId, key } });
    if (current(snapshot)) focusDraft(key, snapshot.mode === "forward" ? "to" : "body", mine);
  } catch { /* A refused lookup leaves the exact stored work available for another explicit open. */ }
  finally {
    unsubscribe();
    if (typeof document !== "undefined") document.removeEventListener?.("focusin", moved, true);
    if (lease && lease.seq === undefined) releaseFocusLease(lease, false);
    const opening = openingStored.get(key)! - 1;
    if (opening) openingStored.set(key, opening); else openingStored.delete(key);
    finish();
  }
}

/**
 * Opens the draft for `mode` on `threadId` (default: the open thread).
 * A new message opens in the floating composer for now. A reply, reply-all or
 * forward opens inline in its conversation: the conversation's draft if it
 * has one (resumed as is in the same mode, converted keeping what was written
 * in another), else a fresh one. With a bulk selection there is no single
 * target: nothing happens.
 */
/** Why an open that still mattered stopped short: the conversation was refreshed under it, or loading it failed. */
type OpenOutcome = "stale" | "failed" | undefined;

/** Plan 133: where an open landed: the draft it made, the one it resumed or converted, the pinned one, or nowhere. */
export const composeHooks: { composing: ((threadId: number) => void) | null } = { composing: null };

export type ComposeLanding = { kind: "created" | "resumed" | "converted" | "pinned"; key: string } | { kind: "none" };
const NOWHERE: ComposeLanding = { kind: "none" };

export interface ComposeOpenOptions {
  /** where focus goes in the draft it lands on, instead of To or the body */
  target?: "ai";
  /** the message it answers or forwards, chosen by the person (plan 158): a draft on another message turns to this one */
  sourceId?: number;
  /**
   * plan 180, "Reply to Mei only": the reply goes to this one address, To alone (no Cc, no Bcc, whatever Reply-To says). A
   * draft here that goes to anyone else is readdressed as a retarget is: converted, with Undo when it held their words.
   */
  only?: Address;
  /** told the moment the draft is known, before anything takes focus or paints, so its row shows with it */
  onLanded?: (landing: Exclude<ComposeLanding, { kind: "none" }>) => void;
}
type LandingCell = { landing: ComposeLanding; options: ComposeOpenOptions | undefined };
function land(cell: LandingCell, kind: "created" | "resumed" | "converted" | "pinned", key: string): void {
  const landing = { kind, key };
  cell.landing = landing;
  cell.options?.onLanded?.(landing);
}

/** opens in flight: the background forward files (plan 60) never edit a draft under one */
let openingNow = 0;
setForwardOpenProbe(() => openingNow > 0);

/**
 * `prefill` (plan 93, a new message from a snippet): the fields the new
 * message starts with, in the same step that creates it. `from` (plan 106,
 * an account's menu): the account a new message is from. Resolves to where it
 * landed (plan 133 §5.2's seam): `none` when a newer choice took over, it
 * failed, or there's no single target.
 */
export async function composeLanding(mode: DraftMode = "new", threadId: number | null = getApp().selectedId, attempt = 0, prefill?: (accountId: number) => Partial<DraftFields>, from?: number, options?: ComposeOpenOptions): Promise<ComposeLanding> {
  const landing = await openLanding(mode, threadId, attempt, prefill, from, options);
  if (strandedWords.size) {
    // a new message opened over the conversation isn't what they were written for (it only says which one's selected)
    if (threadId !== null && landing.kind !== "none" && mode !== "new") placeStrandedWords(threadId, landing.key);
    // with no open left, nothing else will take them, whichever conversation they're from
    if (openingNow === 0) for (const from of strandedWords.keys()) void keepStrandedWords(from);
  }
  return landing;
}

async function openLanding(mode: DraftMode, threadId: number | null, attempt: number, prefill: ((accountId: number) => Partial<DraftFields>) | undefined, from: number | undefined, options: ComposeOpenOptions | undefined): Promise<ComposeLanding> {
  const finish = beginDraftWork();
  if (!finish) return NOWHERE;
  markSelectionIntent();
  // plan 158: answering what's open is choosing it; a new message says nothing about it
  if (mode !== "new") chooseOpenThread();
  // plan 144: the person asked for something else, which proceeds as it always did
  if (threadId !== null) composeHooks.composing?.(threadId);
  const mine = ++intent;
  const state = getApp();
  const cell: LandingCell = { landing: NOWHERE, options };
  // plan 115: the conversation's draft is pinned: r / a / f go to its card (never a second editor, never a conversion)
  if (mode !== "new" && threadId !== null && pinnedFor(threadId, state.draftShown)) {
    finish();
    const pinned = pinnedKey();
    // plan 163: ⌘J's row has no field any more: the card's body takes the keys, as for r / a / f
    focusPinned();
    if (pinned) land(cell, "pinned", pinned);
    // plan 180 (Codex code review): "Reply to Mei only" never quietly sends to more: the pinned draft keeps its own, and says so
    const only = options?.only, held = pinned ? useDrafts.getState().drafts[pinned] : undefined;
    if (only && held && !goesOnlyTo(held, only.email)) snack(t("compose.pinnedKeepsRecipients", { name: only.name || only.email }));
    return cell.landing;
  }
  const wantsLease = mode !== "new" && threadId !== null && state.selectedId === threadId && state.scope === null && state.checked.size < 2;
  const lease = wantsLease ? beginFocusLease(mine, threadId) : null;
  if (wantsLease && !lease) { finish(); return NOWHERE; }
  if (!lease && focusLease && releaseForAcquisition(focusLease, true)) { finish(); return NOWHERE; }
  if (mine !== intent) { finish(); return NOWHERE; }
  const unsubSelection = !lease && mode !== "new" && threadId !== null ? useApp.subscribe((current) => {
    if (mine === intent && (current.scope !== null || current.checked.size >= 2)) supersedeCompose();
  }) : undefined;
  if (lease) lease.mode = mode;
  if (lease && typeof document !== "undefined") lease.earlyInput = prepareEarlyComposeInput(
    () => lease.valid && focusLease === lease && mine === intent && lease.selectionRevision === getSelectionWriteRevision() && destinationAvailable(lease) && !draftEditsHeld(),
    () => { if (focusLease === lease) supersedeCompose(); }, t("compose.body"),
    (words, key) => { if (threadId !== null) strandWords(threadId, words, key); },
  );
  let outcome: OpenOutcome;
  openingNow++;
  try { outcome = await openComposeNow(mode, threadId, mine, lease ?? null, prefill, from, cell); } finally {
    openingNow--;
    lease?.stopSelection?.(); if (lease) lease.stopSelection = undefined;
    lease?.stopContext?.(); if (lease) lease.stopContext = undefined;
    if (lease?.ackRead) { endDraftAckRead(lease.ackRead); lease.ackRead = undefined; }
    unsubSelection?.();
    if (lease && lease.seq === undefined) releaseFocusLease(lease, true);
    finish();
  }
  // nothing newer was asked for: a refresh that replaced the conversation mid-open (a sync, its own read state, a send
  // landing) is retried with it, and a failure says so instead of leaving the click without an answer
  if (mine !== intent || !outcome) return cell.landing;
  if (outcome === "stale" && attempt < 2) return openLanding(mode, threadId, attempt + 1, prefill, from, options);
  snack.error(t(mode === "forward" ? "compose.openFailed.forward" : "compose.openFailed.reply"));
  return cell.landing;
}

/** The same open, for every caller that doesn't need to know where it landed. */
export const openCompose = composeLanding as unknown as (mode?: DraftMode, threadId?: number | null, attempt?: number, prefill?: (accountId: number) => Partial<DraftFields>, from?: number) => Promise<void>;

async function openComposeNow(mode: DraftMode, threadId: number | null, mine: number, lease: FocusLease | null, prefill: ((accountId: number) => Partial<DraftFields>) | undefined, from: number | undefined, cell: LandingCell): Promise<OpenOutcome> {
  const focusAllowed = () => !lease || (lease.valid && focusLease === lease && lease.selectionRevision === getSelectionWriteRevision() && destinationAvailable(lease));
  if (mine !== intent || (lease && !lease.valid)) return;
  if (!destinationAvailable(lease)) {
    await Promise.resolve();
    if (mine !== intent || !destinationAvailable(lease) || (lease && !lease.valid)) return;
  }
  let takeFocus = true;
  const active = typeof document === "undefined" ? null : document.activeElement;
  const focusUnchanged = () => typeof document === "undefined" || document.activeElement === active || Boolean(lease?.earlyInput?.owns(document.activeElement)) || Boolean(lease?.valid && active && !active.isConnected && document.activeElement === document.body);
  const s = getApp();
  // plan 106: a new message from an account's menu is from that account
  const asked = mode === "new" && s.accounts.some((a) => a.id === from) ? from : undefined;
  const defaultAccount = asked ?? s.accountId ?? s.accounts[0]?.id;
  if (!defaultAccount) {
    snack(t("compose.noAccount"));
    setApp({ dialog: "addAccount" });
    return;
  }
  if (mode === "new" || threadId === null) {
    // a new message takes the reader pane; a bulk selection steps aside for it
    // (List: the new message is the page, and leaving it lands on the list, not on the conversation it was opened over; plan 24, R1)
    const key = createDraft(newFields(defaultAccount));
    // a snippet's content is written content: saved like typing, kept when the message is closed (Codex code review 1)
    const filled = prefill?.(defaultAccount);
    if (filled) editDraft(key, filled);
    if (mine !== intent) return;
    land(cell, "created", key);
    setApp({ compose: { key, seq: ++seq, ...(cell.options?.target ? { target: cell.options.target } : {}) }, checked: new Set(), scope: null, readerOpen: false });
    return;
  }
  if (s.scope !== null || s.checked.size >= 2) return;
  const target: ComposeFocusTarget = cell.options?.target ?? (mode === "forward" ? "to" : "body");
  let drafts = useDrafts.getState().drafts;
  let existingKey = shownDraftKey(drafts, threadId, getApp().draftShown);
  const candidate = (sources: readonly number[] = []) => {
    const index = draftIndex(useDrafts.getState().drafts);
    const matches = new Map((index.expiredByThread.get(threadId) ?? []).map((d) => [d.key, d]));
    for (const id of sources) for (const d of index.expiredBySource.get(id) ?? []) matches.set(d.key, d);
    let best: LocalDraft | undefined;
    for (const d of matches.values()) {
      if (s.draftShown?.threadId === threadId && d.key === s.draftShown.key) return d.key;
      if (!best || d.updatedAt > best.updatedAt) best = d;
    }
    return best?.key ?? null;
  };
  let loaded: ThreadDetail | null | undefined;
  if (!existingKey) {
    loaded = await loadThread(threadId);
    if (mine !== intent || !destinationAvailable(lease) || getApp().selectedId !== s.selectedId || (lease && !lease.valid)) return;
    drafts = useDrafts.getState().drafts;
    existingKey = shownDraftKey(drafts, threadId, getApp().draftShown) ?? candidate(loaded?.messages.map((m) => m.id));
  }
  // its body as the editor has it now (what "written" and a conversion's undo look at)
  let existing = existingKey ? materialize(existingKey) : undefined;
  if (existing && !sameStoredDraft(existing)) return;
  // plan 115: a pinned draft is answered in its card, never opened (or converted) a second time
  if (existing && existing.key === pinnedKey()) {
    focusPinned();
    land(cell, "pinned", existing.key);
    return;
  }
  let proof: DraftAckRead | undefined, noWriter = false;
  const chosenSource = cell.options?.sourceId;
  const only = cell.options?.only;
  // the draft answers another message than the one chosen, or goes to more than the one person asked for: a conversion, as a
  // change of mode is
  const retarget = Boolean(existing && ((chosenSource !== undefined && activeSourceId(existing) !== chosenSource) || (only && !goesOnlyTo(existing, only.email))));
  const sameModeSource = Boolean(existing && !retarget && existing.mode === mode && existing.showSourceContext && !existing.presentationExpired && !existing.recovery && activeSourceId(existing) !== null && lease);
  if (existing && (existing.mode !== mode || retarget || sameModeSource) && !existing.presentationExpired && lease) {
    if (mine !== intent || !focusAllowed()) return;
    const admission = existing.mode !== mode || retarget ? beginComposeBodyAckRead(existing) : beginDraftAckRead(existing);
    if (admission.kind === "refused") return;
    noWriter = admission.kind === "no-writer";
    proof = admission.kind === "proof" ? admission.proof : admission.continuity;
    if (mine !== intent || !focusAllowed() || readDraftAck(proof) !== existing) { endDraftAckRead(proof); return; }
  }
  const originalSourceId = existing ? activeSourceId(existing) : null;
  const canonicalNullSource = Boolean(!retarget && proof && existing && existing.threadId === null && existing.showSourceContext === true && !existing.presentationExpired && originalSourceId !== null && draftPresentationThread(existing) === threadId);
  let originalContext: { threadId: number; accountId: number } | null | undefined;
  if (lease && proof) {
    lease.ackRead = proof;
    const owner = lease;
    const retire = () => {
      if (focusLease !== owner || !owner.ackRead) return;
      endDraftAckRead(owner.ackRead); owner.ackRead = undefined;
      owner.stopSelection?.(); owner.stopSelection = undefined;
      owner.stopContext?.(); owner.stopContext = undefined;
    };
    owner.stopSelection = subscribeComposeSelectionIntent(retire);
    owner.stopContext = useApp.subscribe((state, previous) => {
      if (state.selectedId !== previous.selectedId || state.readerOpen !== previous.readerOpen || state.compose !== previous.compose || state.checked !== previous.checked || state.scope !== previous.scope || state.accountId !== previous.accountId || state.dialog !== previous.dialog || state.fatal !== previous.fatal || state.view !== previous.view || state.categoryId !== previous.categoryId || state.reviewCategoryId !== previous.reviewCategoryId || state.query !== previous.query || state.listFilters !== previous.listFilters) retire();
    });
  }
  if (existing?.presentationExpired && activeSourceId(existing) === null && (existing.mode === "new" || (existing.threadId === null && existing.departedThreadId === threadId && authored(existing)))) {
    if (showStoredStandalone(existing.key, mine, undefined, lease)) land(cell, "resumed", existing.key);
    return;
  }
  // (a retarget answers to the chosen message, checked below: the one it leaves may be gone, and that's no reason to refuse it)
  if (existing?.showSourceContext && !retarget) {
    let snapshot = existing;
    const destination = sameModeSource && proof ? loaded ?? await loadThread(threadId) : undefined;
    if (sameModeSource && proof) {
      const current = readDraftAck(proof);
      if (!destination || destination.thread.id !== threadId || mine !== intent || !focusAllowed() || getApp().selectedId !== s.selectedId || !current || shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) !== existingKey) return;
      snapshot = current;
    }
    const sourceId = snapshot.mode === "forward" ? snapshot.forwardOfMessageId : snapshot.mode === "new" ? null : snapshot.inReplyToMessageId;
    let context: { threadId: number; accountId: number } | null;
    try { context = sourceId ? await client.call("drafts.sourceContext", { messageId: sourceId }) : null; } catch { return; }
    const current = proof ? readDraftAck(proof) : existingKey ? materialize(existingKey) : undefined;
    if (mine !== intent || !destinationAvailable(lease) || getApp().selectedId !== s.selectedId || (lease && !lease.valid) || !current || (!proof && !sameStoredDraft(snapshot))) return;
    if (!context || context.threadId !== threadId) {
      if (showStoredStandalone(current.key, mine, undefined, lease)) land(cell, "resumed", current.key);
      return;
    }
    if (sameModeSource && proof) {
      if (!destination || context.accountId !== destination.thread.accountId) return;
      if (await loadThread(threadId) !== destination || mine !== intent || !focusAllowed() || getApp().selectedId !== s.selectedId || readDraftAck(proof) !== current || shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) !== existingKey) return;
      endDraftAckRead(proof);
      if (lease?.ackRead === proof) lease.ackRead = undefined;
      proof = undefined;
    }
    if (canonicalNullSource) originalContext = context;
    if (current.presentationExpired) {
      const validated = validatedPresentation(snapshot, threadId);
      validateDraftPresentation(current.key, threadId);
      if (mine !== intent || (lease && !lease.valid) || !sameStoredDraft(validated)) return;
      existing = validated;
    } else existing = current;
  } else if (retarget && existing?.presentationExpired) {
    // a draft whose conversation it had left: back here first, as the check above would, and the conversion below finds it shown
    const validated = validatedPresentation(existing, threadId);
    validateDraftPresentation(existing.key, threadId);
    if (mine !== intent || (lease && !lease.valid) || !sameStoredDraft(validated)) return;
    existing = validated;
  }
  if (existing && existing.mode === mode && !retarget) {
    const expected = openedDraft(existing);
    let transitions = 0, receipt: LocalDraft | undefined;
    const stop = sameModeSource ? useDrafts.subscribe((state, previous) => {
      if (state.drafts[existing!.key] !== previous.drafts[existing!.key]) { transitions++; receipt = state.drafts[existing!.key]; }
    }) : undefined;
    try { setDraftUi(existing.key, "open"); } finally { stop?.(); }
    const exact = !sameModeSource || (expected === existing ? transitions === 0 : transitions === 1 && receipt === useDrafts.getState().drafts[existing.key] && !!receipt && shallow(receipt, expected));
    if (exact) land(cell, "resumed", existing.key);
    if (exact && focusAllowed() && sameStoredDraft(expected)) focusDraft(existing.key, target, mine);
    // Forward again: files that didn't come (or were never asked for, after a reload) are asked for again (plan 60)
    if (mode === "forward" && exact && mine === intent) void ensureForwardFiles(existing.key, threadId);
    return;
  }
  const selected = s.selectedId;
  const selectionRevision = getSelectionWriteRevision();
  const detail = loaded === undefined ? await loadThread(threadId) : loaded;
  const currentIntent = () => mine === intent && destinationAvailable(lease) && getSelectionWriteRevision() === selectionRevision && (!proof || Boolean(readDraftAck(proof))) && getApp().selectedId === selected && shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) === existingKey;
  // an outcome counts only while the user is still waiting on this one: the lease still held (focus didn't move on)
  const stillAsked = () => currentIntent() && (!lease || (lease.valid && focusLease === lease));
  if (!detail) return stillAsked() ? "failed" : undefined;
  if (canonicalNullSource && (!originalContext || detail.thread.id !== threadId || originalContext.threadId !== threadId || originalContext.accountId !== detail.thread.accountId)) return;
  if (!currentIntent()) {
    if (mode === "forward" && mine === intent && destinationAvailable(lease) && (!lease || (lease.valid && focusLease === lease)) && getSelectionWriteRevision() === selectionRevision && getApp().selectedId === selected && shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) === existingKey) {
      const current = existingKey ? useDrafts.getState().drafts[existingKey] : undefined, accounts = getApp().accounts;
      const message = detail.messages.find((m) => m.id === chosenSource) ?? answered(detail, accounts.map((a) => a.email)), source = accounts.find((a) => a.id === detail.thread.accountId);
      if (current && message.attachmentState === "complete" && message.attachments.length && message.attachments.every((a) => a.assetId)) {
        if (!source) snack.error(t("errors.accountGone"));
        else if (forwardAccountMismatch(current.accountId, detail, accounts.map((a) => a.email))) snack.error(t("compose.forwardAccountMismatch", { account: source.email }));
      }
    }
    return;
  }
  if (chosenSource !== undefined && !detail.messages.some((m) => m.id === chosenSource)) { snack.error(t("compose.sourceGone")); return; }
  takeFocus = focusUnchanged();
  existing = proof ? readDraftAck(proof) : existingKey ? materialize(existingKey) : undefined;
  if (existingKey && (!existing || existing.sending || existing.recovery)) return;
  const accounts = getApp().accounts;
  const source = accounts.find((a) => a.id === detail.thread.accountId);
  // none of my addresses is replied to, whichever account the conversation is in (plan 34)
  const identities = accounts.map((a) => a.email);
  let forwardRefs: AttachmentRef[] | undefined, forwardSource: { threadId: number; messageId: number; accountId: number } | undefined;
  if (mode === "forward") {
    const message = detail.messages.find((m) => m.id === chosenSource) ?? answered(detail, identities);
    // plan 60: only the files confirmed on this device go in now; one not ready never stops the forward (it follows)
    const parts = message.attachments.filter((a) => a.assetId);
    if (parts.length && !source) { snack.error(t("errors.accountGone")); return; }
    const snapshot = existing;
    const checked = new Map<string, AttachmentRef | null>();
    for (const part of parts) {
      // the same file named twice with different details: neither is trusted (it stays out, and is asked for)
      if (checked.has(part.assetId!)) {
        const known = checked.get(part.assetId!);
        if (known && (known.filename !== part.filename || known.mime !== part.mime || known.size !== part.size || (known.contentId ?? null) !== (part.contentId ?? null))) checked.set(part.assetId!, null);
        continue;
      }
      let info: AttachmentRef | null = null;
      try { info = await client.call("attachments.info", { accountId: message.accountId, assetId: part.assetId! }); } catch { /* not ready: it follows */ }
      checked.set(part.assetId!, info && info.filename === part.filename && info.mime === part.mime && info.size === part.size && (info.contentId ?? null) === (part.contentId ?? null) ? { assetId: part.assetId!, filename: part.filename, mime: part.mime, size: part.size, contentId: part.contentId ?? null } : null);
    }
    forwardRefs = [...checked.values()].filter((r): r is AttachmentRef => r !== null);
    forwardSource = { threadId, messageId: message.id, accountId: message.accountId };
    if (existing && forwardAccountMismatch(existing.accountId, detail, identities, forwardRefs)) {
      snack.error(t("compose.forwardAccountMismatch", { account: source!.email }));
      return;
    }
    if (!currentIntent() || await loadThread(threadId) !== detail) return;
    if (forwardRefs.length && !getApp().accounts.some((a) => a.id === source!.id)) { snack.error(t("errors.accountGone")); return; }
    existing = proof ? readDraftAck(proof) : existingKey ? materialize(existingKey) : undefined;
    if (existingKey && (!existing || existing.sending || existing.recovery || (!proof && (existing.accountId !== snapshot?.accountId || existing.id !== snapshot?.id || existing.generation !== snapshot?.generation || existing.localRev !== snapshot?.localRev)))) return;
    takeFocus = focusUnchanged();
    if (forwardRefs.length && existing && !existing.attachments?.length) {
      // Save the empty From transition before introducing that account's attachment owners.
      const active = typeof document === "undefined" ? null : document.activeElement;
      const beforeFlush = existing;
      if (proof && !noWriter) {
        if (!lease || focusLease !== lease || !lease.valid || lease.ackRead !== proof) return;
        const phase = beginForwardEmptyOwnerRead(proof);
        if (!phase || focusLease !== lease || !lease.valid || lease.ackRead !== proof) { if (phase) endDraftAckRead(phase); return; }
        proof = phase; lease.ackRead = phase;
      }
      await flushDraft(existing.key);
      if (!currentIntent()) return;
      existing = proof ? readDraftAck(proof) : sameStoredDraft(beforeFlush) ? beforeFlush : undefined;
      if (!existing || existing.sending || existing.recovery || existing.savedRev !== existing.localRev) return;
      const pristine = existing.id === null && existing.status === "clean" && existing.localRev === 0 && !authored(existing);
      if (existing.status !== "saved" && !pristine) return;
      if (proof && (!lease || focusLease !== lease || !lease.valid || lease.ackRead !== proof || existing.attachments?.length || existing.attachmentOwner)) return;
      if (proof && !noWriter) {
        if (!lease) return;
        const sealed = sealForwardEmptyOwnerRead(proof);
        if (!sealed || focusLease !== lease || !lease.valid || lease.ackRead !== proof) { if (sealed) endDraftAckRead(sealed); return; }
        proof = sealed; lease.ackRead = sealed;
      }
      if (await loadThread(threadId) !== detail || !currentIntent()) return;
      takeFocus = takeFocus && (typeof document === "undefined" || document.activeElement === active);
      if (!getApp().accounts.some((a) => a.id === source!.id)) { snack.error(t("errors.accountGone")); return; }
      if (forwardAccountMismatch(existing.accountId, detail, getApp().accounts.map((a) => a.email))) {
        snack.error(t("compose.forwardAccountMismatch", { account: source!.email }));
        return;
      }
    }
  }
  const account = source ?? accounts[0]!;
  const before = existing ? fieldsOf(existing) : undefined;
  if (proof && readDraftAck(proof) !== existing) return;
  const converted = existing && existing.mode !== "new" && (written(existing) || (mode !== "forward" && existing.mode !== "forward"))
    ? convertFields(before!, mode, detail, account, identities, forwardRefs, chosenSource)
    : replyFields(mode, detail, account, { identities, forwardRefs, ...(chosenSource !== undefined ? { sourceId: chosenSource } : {}) });
  if (converted === before) { snack.error(t("attachments.tooLarge")); return; }
  if (only) Object.assign(converted, { toText: formatAddressList([only]), ccText: "", bccText: "", auto: { to: [only.email], cc: [], bcc: [] } });
  converted.showSourceContext = true;
  converted.attachments = mergeAttachmentRefs([], converted.attachments ?? []);
  const snapshot = existing;
  const signature = getApp().accounts.find((a) => a.id === converted.accountId)?.signature;
  const admitted = await draftAttachmentBudget(converted, signature);
  if (!currentIntent()) return;
  if (!canonicalNullSource && await loadThread(threadId) !== detail) return stillAsked() ? "stale" : undefined;
  const sourceId = converted.mode === "forward" ? converted.forwardOfMessageId : converted.inReplyToMessageId;
  let sourceContext: { threadId: number; accountId: number } | null, finalOriginalContext: typeof sourceContext;
  try {
    sourceContext = sourceId ? await client.call("drafts.sourceContext", { messageId: sourceId }) : null;
    if (canonicalNullSource && originalSourceId !== sourceId) {
      if (!currentIntent() || !lease?.valid || focusLease !== lease || lease.ackRead !== proof) return;
      finalOriginalContext = originalSourceId ? await client.call("drafts.sourceContext", { messageId: originalSourceId }) : null;
    } else finalOriginalContext = sourceContext;
  } catch { return stillAsked() ? "failed" : undefined; }
  // what was chosen is gone: nothing answers another message in its place, and the person hears why
  if (chosenSource !== undefined && currentIntent() && (!sourceContext || sourceContext.threadId !== threadId)) { snack.error(t("compose.sourceGone")); return; }
  if (!currentIntent() || (lease && !lease.valid) || !sourceContext || sourceContext.threadId !== threadId || sourceContext.accountId !== detail.thread.accountId) return;
  if (canonicalNullSource && (!finalOriginalContext || finalOriginalContext.threadId !== threadId || finalOriginalContext.accountId !== detail.thread.accountId)) return;
  if (canonicalNullSource && (await loadThread(threadId) !== detail || !currentIntent() || !lease?.valid || focusLease !== lease || lease.ackRead !== proof)) return;
  existing = proof ? readDraftAck(proof) : existingKey ? materialize(existingKey) : undefined;
  if (existingKey && (!existing || existing.sending || existing.recovery || (!proof && (existing.accountId !== snapshot?.accountId || existing.id !== snapshot?.id || existing.generation !== snapshot?.generation || existing.revision !== snapshot?.revision || existing.threadId !== snapshot?.threadId || existing.mode !== snapshot?.mode || existing.inReplyToMessageId !== snapshot?.inReplyToMessageId || existing.forwardOfMessageId !== snapshot?.forwardOfMessageId || existing.showSourceContext !== snapshot?.showSourceContext || existing.presentationEpoch !== snapshot?.presentationEpoch || existing.localRev !== snapshot?.localRev || existing.bodyVersion !== snapshot?.bodyVersion || existing.bodyText !== snapshot?.bodyText || existing.bodyHtml !== snapshot?.bodyHtml)))) return;
  if (!getApp().accounts.some((a) => a.id === converted.accountId)) { snack.error(t("errors.accountGone")); return; }
  if (getApp().accounts.find((a) => a.id === converted.accountId)?.signature !== signature) return;
  if (!admitted) { snack.error(t("attachments.tooLarge")); return; }
  takeFocus = takeFocus && focusUnchanged();
  if (proof) { if (readDraftAck(proof) !== existing) return; endDraftAckRead(proof); if (lease?.ackRead === proof) lease.ackRead = undefined; proof = undefined; }
  if (existing && existing.mode !== "new") {
    const original = existing;
    if (materialize(original.key) !== original || useDrafts.getState().drafts[original.key] !== original) return;
    let count = 0, receipt: LocalDraft | undefined;
    const unsubscribe = useDrafts.subscribe((state, previous) => {
      if (state.drafts[original.key] !== previous.drafts[original.key]) { count++; receipt = state.drafts[original.key]; }
    });
    let edited = false;
    try { edited = editDraft(original.key, converted); } finally { unsubscribe(); }
    if (!edited || count !== 1 || !receipt || useDrafts.getState().drafts[original.key] !== receipt) return;
    if (forwardSource) fetchForwardFiles(original.key, forwardSource, converted.attachments ?? []);
    const sourceChanged = converted.mode !== original.mode || (converted.mode === "forward" ? converted.forwardOfMessageId !== undefined && converted.forwardOfMessageId !== original.forwardOfMessageId : converted.inReplyToMessageId !== undefined && converted.inReplyToMessageId !== original.inReplyToMessageId);
    const resetContext = converted.threadId !== undefined || sourceChanged;
    const bodyChanged = (converted.bodyText !== undefined && converted.bodyText !== original.bodyText) || (converted.bodyHtml !== undefined && converted.bodyHtml !== original.bodyHtml);
    const expected: LocalDraft = {
      ...original, ...converted,
      ...(resetContext ? { departedThreadId: undefined, presentationThreadId: converted.showSourceContext && converted.threadId === null ? draftPresentationThread(original) ?? undefined : undefined, sourceContextThreadId: undefined, presentationExpired: false, presentationEpoch: (original.presentationEpoch ?? 0) + 1 } : {}),
      ...(converted.attachments?.length === 0 && original.recovery && (original.recovery.state === "missing" || original.recovery.state === "refused") ? { attachmentOwner: false } : {}),
      localRev: original.localRev + 1, status: original.status === "saving" ? "saving" : "dirty", updatedAt: receipt.updatedAt, tooLong: false,
      ...(bodyChanged ? { bodyVersion: original.bodyVersion + 1, canonical: false } : {}),
    };
    const fresh = () => mine === intent && currentIntent() && sameStoredDraft(expected);
    if (!shallow(receipt, expected) || !fresh()) return;
    land(cell, "converted", original.key);
    if (takeFocus && focusAllowed()) focusDraft(original.key, target, mine);
    if (!fresh()) { if (lease && focusLease === lease) releaseFocusLease(lease, false); return; }
    if (!written(original)) return;
    const undo = registerUndo(() => editDraft(original.key, { ...before!, uiState: "open" }));
    if (!fresh()) { if (lease && focusLease === lease) releaseFocusLease(lease, false); if (useSnack.getState().undo === undo) useSnack.setState({ undo: null }); return; }
    // the same kind of draft, on another message: "Converted to a reply" would say nothing true
    // plan 180: the same reply, now to one person
    if (only && original.mode === mode && !sourceChanged) return void snack(t("compose.onlyTo.message", { name: only.name || only.email }), { action: { label: t("common.undo"), name: t("compose.undoOnlyTo"), undo } });
    const [message, name] = original.mode === mode ? (["compose.converted.message", "compose.undoConvert.message"] as const) : CONVERTED[mode];
    snack(t(message), { action: { label: t("common.undo"), name: t(name), undo } });
    return;
  }
  const { key, created } = createDraftWithReceipt(converted);
  land(cell, "created", key);
  if (forwardSource) fetchForwardFiles(key, forwardSource, converted.attachments ?? []);
  if (takeFocus && mine === intent && destinationAvailable(lease) && focusAllowed() && getApp().selectedId === selected && useDrafts.getState().drafts[key] === created && shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) === key) focusDraft(key, target, mine);
}

/**
 * Plan 133 §5.2: a reply to someone who may not be its last sender: it answers their newest message, to them alone,
 * whatever Reply-To that message names (a Cc'd person with no message keeps the reply's source). Only for a draft Terno
 * filled in: a person's own recipients are never replaced. False when nothing changed.
 */
export async function addressReply(key: string, threadId: number, person: { name: string; address: string }, o: { keepBody?: boolean } = {}): Promise<boolean> {
  const detail = await loadThread(threadId);
  const d = materialize(key);
  // plan 163: the instruction typed in the body makes the draft "written", but not its recipients: while they're still the
  // ones Terno filled in, it's addressed as an untouched reply would be, and the body stays as it is
  const chosen = !!d && authored(d) && !(o.keepBody && recipientsUnchosen(d));
  if (!detail || !d || d.sending || d.mode === "new" || d.mode === "forward" || chosen) return false;
  const accounts = getApp().accounts;
  const account = accounts.find((a) => a.id === detail.thread.accountId) ?? accounts.find((a) => a.id === d.accountId);
  if (!account) return false;
  const address = person.address.toLowerCase();
  const source = [...detail.messages].reverse().find((m) => !m.isSent && m.from.email.toLowerCase() === address);
  const fields = replyFields("reply", detail, account, { identities: accounts.map((a) => a.email), ...(source ? { sourceId: source.id } : {}) });
  const to = { name: source?.from.name || person.name, email: source?.from.email ?? person.address };
  const patch: Partial<DraftFields> = { ...fields, showSourceContext: true, toText: formatAddressList([to]), ccText: "", auto: { to: [to.email], cc: [], bcc: [] } };
  // the body is left alone: it holds what they typed
  if (o.keepBody) {
    delete patch.bodyText;
    delete patch.bodyHtml;
  }
  return editDraft(key, patch);
}

/** Plan 180: To is that one address, and there's no Cc or Bcc. */
function goesOnlyTo(d: LocalDraft, email: string): boolean {
  const to = parseAddressList(d.toText);
  return to.length === 1 && to[0]!.email.toLowerCase() === email.toLowerCase() && parseAddressList(d.ccText).length === 0 && parseAddressList(d.bccText).length === 0;
}

/** To, Cc and Bcc are still only what Terno filled in (plan 163). */
export function recipientsUnchosen(d: LocalDraft): boolean {
  return (["to", "cc", "bcc"] as const).every((field) => {
    const auto = d.auto[field].map((email) => email.toLowerCase());
    return parseAddressList(d[`${field}Text`]).every((a) => auto.includes(a.email.toLowerCase()));
  });
}

/** Opened again, a draft resumes in its text (where the editor kept the caret); To only while a recipient still needs attention (plan 158). */
export function resumeTarget(key: string): ComposeFocusTarget {
  const d = useDrafts.getState().drafts[key];
  return !d || d.toText.trim() === "" || firstInvalid(d.toText) !== null ? "to" : "body";
}

/** Shows a new-message draft in the reader pane again (from the drafts strip). */
export function showNewDraft(key: string): void {
  if (key === pinnedKey()) { focusPinned(); return; }
  markSelectionIntent();
  setApp({ compose: { key, seq: ++seq }, checked: new Set(), scope: null, readerOpen: false });
}

/** Closing this draft leaves nothing to keep: nothing written, and no file on its way. */
export const closesEmpty = (key: string): boolean => !attachmentUploading(key) && nothingWrittenIn(key);

/**
 * The reader pane leaves the new message (Esc, a thread opened, sent, discarded).
 * What was written is kept (saved first); an untouched new draft just goes.
 */
export function leaveNewDraft(): void {
  const key = getApp().compose?.key;
  if (!key) return;
  setApp({ compose: null });
  const d = useDrafts.getState().drafts[key];
  // plan 115: a pinned draft lives on in its card, untouched or not; a file on its way is something written
  if (d && !authored(d) && key !== pinnedKey() && !attachmentUploading(key)) forgetDraft(key);
  // written and taken out again, or saved on the way: nothing to keep (plan 158), unless it's opened again meanwhile
  else if (d && key !== pinnedKey() && closesEmpty(key)) void discardIfEmpty(key, () => getApp().compose?.key !== key && !attachmentUploading(key));
  else void flushDraft(key);
}

/** The explicit Escape exit owns its pending strip focus until another choice. */
export function leaveNewDraftWithFocus(key: string): { valid: () => boolean; watch: (cancel: () => void) => () => void } | undefined {
  const baseline = getApp(), compose = baseline.compose;
  if (!compose || compose.key !== key) return;
  const owner = ++intent, revision = getSelectionWriteRevision(), focusRevision = seq;
  const active = typeof document === "undefined" ? null : document.activeElement;
  let changed = draftEditsHeld(), clearing = false;
  const sameLocation = (a: typeof baseline, b: typeof baseline) => a.selectedId === b.selectedId && a.readerOpen === b.readerOpen && a.compose === b.compose && a.checked === b.checked && a.scope === b.scope && a.accountId === b.accountId && a.dialog === b.dialog && a.fatal === b.fatal && a.view === b.view && a.categoryId === b.categoryId && a.reviewCategoryId === b.reviewCategoryId && a.query === b.query && a.listFilters === b.listFilters;
  const expected = { ...baseline, compose: null };
  const observe = (event: FocusEvent) => { if (event.target !== active && event.target !== document.body) changed = true; };
  const app = useApp.subscribe((state, previous) => {
    const ownClear = clearing && sameLocation(state, expected) && sameLocation(previous, baseline);
    if ((!sameLocation(state, baseline) || !sameLocation(previous, baseline)) && !ownClear && !(clearing && sameLocation(state, expected) && sameLocation(previous, expected))) changed = true;
    if (state.draftFocus !== previous.draftFocus && !(state.draftFocus === null && previous.draftFocus?.seq === compose.storedFocusSeq)) changed = true;
  });
  const drafts = useDrafts.subscribe((state, previous) => { if (state.held || previous.held) changed = true; });
  if (typeof document !== "undefined") document.addEventListener?.("focusin", observe, true);
  try {
    if (focusLease) releaseFocusLease(focusLease, false);
    if (owner !== intent || changed || getSelectionWriteRevision() !== revision || seq !== focusRevision || getApp().compose !== compose) return;
    clearing = true;
    leaveNewDraft();
  } finally {
    app(); drafts();
    if (typeof document !== "undefined") document.removeEventListener?.("focusin", observe, true);
  }
  if (changed || owner !== intent || seq !== focusRevision || getSelectionWriteRevision() !== revision) return;
  const valid = () => owner === intent && seq === focusRevision && getSelectionWriteRevision() === revision && !draftEditsHeld() && sameLocation(getApp(), expected) && Boolean(useDrafts.getState().drafts[key]);
  const watch = (cancel: () => void) => {
    const stopApp = useApp.subscribe((state, previous) => { if (!valid() || !sameLocation(state, previous) || state.draftFocus !== previous.draftFocus) cancel(); });
    const stopDrafts = useDrafts.subscribe((state, previous) => { if (state.held || previous.held || !valid()) cancel(); });
    return () => { stopApp(); stopDrafts(); };
  };
  return { valid, watch };
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
  const doc = parseHtml(d.bodyHtml);
  return { text: toPlainText(doc), html: toEmailHtml(doc) };
}

/** Sends in flight, per draft: a second send of the same draft (a remounted pane, a double ⌘↩) gets the first one's outcome. */
const pendingSends = new Map<string, Promise<boolean>>();

/**
 * Sends a draft: waits for its save in flight, checks the recipients, queues
 * the send (which deletes the stored draft). One send per draft at a time;
 * while it runs the draft can't be edited or discarded. With `sendAt` (plan
 * 89) the very same message is prepared and scheduled instead: the stored
 * draft stays, out of the composers, until it goes.
 */
export function sendDraft(key: string, sendAt?: number): Promise<boolean> {
  const pending = pendingSends.get(key);
  if (pending) return pending;
  let resolve!: (value: boolean) => void;
  let reject!: (error: unknown) => void;
  const run = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; });
  pendingSends.set(key, run);
  const finish = () => { if (pendingSends.get(key) === run) pendingSends.delete(key); };
  try { void send(key, sendAt).then((result) => { finish(); resolve(result); }, (error) => { finish(); reject(error); }); }
  catch (error) { finish(); reject(error); }
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

/** Nobody to send to, or something typed that isn't an address: said at the field when it's on screen (plan 158), its first invalid chip selected. */
function recipientProblem(d: LocalDraft): { field: "to" | "cc" | "bcc"; message: string } | null {
  const bad = (["to", "cc", "bcc"] as const).map((field) => ({ field, entry: firstInvalid(d[`${field}Text`]) })).find((b) => b.entry !== null);
  if (bad) return { field: bad.field, message: t("compose.invalidRecipient", { entry: bad.entry! }) };
  return validRecipients(d.toText).length === 0 ? { field: "to", message: t("compose.noRecipient") } : null;
}
function sayRecipientProblem(key: string, problem: { field: "to" | "cc" | "bcc"; message: string }): void {
  const shown = typeof document !== "undefined" && document.querySelector(`[data-draft-key="${CSS.escape(key)}"] [data-recipient-field="compose-${problem.field}"]`) !== null;
  if (shown) sayProblem({ key, ...problem });
  else snack.error(problem.message);
  showRecipient(key, problem.field);
}

async function send(key: string, sendAt?: number): Promise<boolean> {
  if (draftEditsHeld()) return false;
  // plan 133 §10.4: buttons, shortcuts, the palette and Send Later all come through here
  if (aiDraftHooks.blocksSend(key, sendAt)) return false;
  if (useDrafts.getState().drafts[key]?.recovery) { snack.error(t("compose.recovery.sendBlocked")); return false; }
  const draft = useDrafts.getState().drafts[key];
  if (draft && !getApp().accounts.some((a) => a.id === draft.accountId)) { snack.error(t("errors.accountGone")); return false; }
  if (attachmentUploading(key)) { snack.error(t("compose.stillAdding")); return false; }
  // before anything is saved: a refused send leaves no draft behind that wasn't there
  const refused = draft && recipientProblem(draft);
  if (refused) { sayRecipientProblem(key, refused); return false; }
  // asked already whether to send no message (below): this Send is the answer, at the time Send later asked for if it did
  const pending = useEmptySend.getState();
  const asked = pending.key === key;
  if (asked && sendAt === undefined) sendAt = pending.sendAt;
  // plan 162 (after ai162-r04): a note for AI would go as the email: asked once, at the action row, Write it first
  if (!asked && isNote(key)) {
    useEmptySend.setState({ key, sendAt, reason: "note" });
    return false;
  }
  clearEmptySend(key);
  // plan 170 (Codex critique #2): still in the click or the key, where WebKit lets an element play later
  primeSendSound();
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
    const problem = recipientProblem(d);
    if (problem) {
      markSending(key, false);
      resumeDraft(key);
      sayRecipientProblem(key, problem);
      return false;
    }
    // no message (nothing written, nothing attached): asked once, at the action row, before it goes (plan 158)
    if (!asked && emptyMessage(d)) {
      markSending(key, false);
      resumeDraft(key);
      useEmptySend.setState({ key, sendAt });
      return false;
    }
    breadcrumb("action", "action.send");
    await aiDraftHooks.provenance(key);
    const body = await bodyParts(d);
    const signature = getApp().accounts.find((a) => a.id === d.accountId)?.signature;
    // plan 76: an image taken out of the text (and not put back) isn't sent
    const attachments = sentRefs(d.attachments ?? [], body.html ?? undefined);
    const bodyHtml = body.html === null ? undefined : sendHtml(withSentImages(body.html, attachments), d, signature);
    const params = {
      accountId: d.accountId,
      to,
      cc,
      bcc,
      subject: d.subject,
      bodyText: sendBody({ ...d, bodyText: body.text }, signature),
      bodyHtml,
      inReplyToMessageId: d.inReplyToMessageId ?? undefined,
      forwardOfMessageId: d.forwardOfMessageId ?? undefined,
      draftId: d.id ?? undefined,
      draftRevision: d.id ? d.revision : undefined,
      draftGeneration: d.generation,
      attachments,
      // plan 133 §8: the body as the user left it, before signature and quote: without it the message counts as the model's
      authoredText: body.text,
    };
    if (sendAt !== undefined) {
      // draftForSend gave a saved draft (id, generation, revision): those fence the schedule
      await client.call("compose.schedule", { ...params, draftId: d.id!, draftGeneration: d.generation!, draftRevision: d.revision, sendAt });
      forgetDraft(key);
      if (getApp().compose?.key === key) setApp({ compose: null });
      scheduledSnack(d.id!, sendAt);
      return true;
    }
    // plan 158: Send's Undo window is a schedule of a few seconds: the backend holds it, durably, and the draft stays until it goes
    if (getApp().settings?.undoSend === true) {
      // plan 182: taken before the backend's clock starts, so the window shown here never outlasts its own
      const goesAt = Date.now() + UNDO_SEND_MS;
      const hold = await client.call("compose.hold", { ...params, draftId: d.id!, draftGeneration: d.generation!, draftRevision: d.revision });
      // (no room to hold it: the backend queued it as a plain send)
      // plan 170: the whoosh as it leaves the composer, held or not
      playSendSound();
      if (hold.held) {
        const pinned = pinnedKey() === key;
        // plan 182: a new message written in the pane shows there, sent, through its window; from the pinned card it doesn't take the pane
        const inPane = getApp().compose?.key === key;
        forgetDraft(key);
        const draftId = d.id!;
        // the pane first (Codex review #1: a send that already went opens its copy from it); one change, so List's page never passes through the list on its way from the message to the sent view
        if (inPane) setApp({ compose: null, ...(d.mode === "new" && !pinned ? { heldView: draftId } : {}) });
        holdSend({
          draftId,
          accountId: d.accountId,
          threadId: d.mode === "new" ? null : d.threadId,
          mode: d.mode,
          subject: d.subject,
          to,
          cc,
          bodyHtml: bodyHtml ?? null,
          bodyText: params.bodyText,
          attachments,
          goesAt,
          cancel: (cancelled) => cancelHeldSend(draftId, pinned, cancelled),
        });
        return true;
      }
      sentAway(key, d, hold);
      return true;
    }
    const sent = await client.call("compose.send", params);
    playSendSound();
    sentAway(key, d, sent);
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
    snack.error(t(sendAt !== undefined ? "sendLater.scheduleFailed" : "compose.sendFailed", { error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

/** It's queued: the draft is gone, and the reader goes to its copy in the conversation. */
function sentAway(key: string, d: LocalDraft, res: { threadId: number; messageId: number }): void {
  forgetDraft(key);
  // sent from a thread: the reader goes to its copy in the conversation
  if (d.threadId !== null) revealSent(res.messageId);
  if (getApp().compose?.key === key) setApp({ compose: null });
  invalidateThreads([res.threadId]);
  sendingSnack();
}

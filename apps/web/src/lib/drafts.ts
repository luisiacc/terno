import { formatAddressList, isValidEmail, parseAddressList, type Address } from "@terno/core";
import type { Draft, DraftAddress, DraftMode } from "@terno/core/rpc";
import { create } from "zustand";
import { emailDocument, GAP, signatureHtml, textToHtml } from "@terno/richtext/quote";
import { client } from "~/rpc/connection";
import { exposeForTests } from "~/lib/render-probe";

/**
 * Drafts in the renderer: one entry per draft, keyed by a stable client key
 * (the server id arrives with the first acknowledged save), and their write
 * lifecycle.
 *
 * - Every edit bumps a local revision and marks the draft dirty. A save goes
 *   out 800 ms after the last edit, and at least every 5 s while typing.
 * - At most one save is in flight per draft; its answer applies to the draft
 *   (key) it was sent for, never to "the current draft".
 * - "Draft saved" means the acknowledged revision is the local one.
 * - A failed save says so and retries (1, 2, 5 s); the text stays in memory.
 * - Send, discard and flush first cancel the debounce and wait for the save
 *   in flight. The server's revision travels with every save: an edit made on
 *   a revision another writer replaced becomes its own draft, never an
 *   overwrite. A save answered with null means the draft is gone.
 *
 * What can be lost in a crash: edits since the last acknowledgement (≤ 800 ms
 * after a pause, ≤ 5 s while typing).
 *
 * Rich text (plan 16): the editor owns the body while it is mounted. Each
 * change marks the draft dirty (an edit with no fields) and its body source
 * dirty; the body is serialized (mail HTML and its plain-text alternative,
 * from the same document) only when it is needed: before a save, a flush, a
 * send, a discard or a snapshot of the fields. A body patch from anywhere
 * else bumps `bodyVersion`, and a mounted editor that didn't write it
 * reloads its document.
 */

export type DraftStatus = "clean" | "dirty" | "saving" | "saved" | "error";

/** Per field, the addresses Terno put there (anything else in that field the user typed). */
export interface AutoRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}
export const NO_AUTO: AutoRecipients = { to: [], cc: [], bcc: [] };

export interface LocalDraft {
  key: string;
  /** server id, once a save was acknowledged */
  id: number | null;
  /** the server revision this draft's content is based on */
  revision: number;
  status: DraftStatus;
  /** bumped by every edit; saved = what the server acknowledged */
  localRev: number;
  savedRev: number;
  accountId: number;
  threadId: number | null;
  mode: DraftMode;
  /** recipients as typed (comma-separated); `auto` remembers, per field, which addresses Terno filled in there */
  toText: string;
  ccText: string;
  bccText: string;
  auto: AutoRecipients;
  subject: string;
  subjectEdited: boolean;
  /** the written part's plain text (always the alternative of bodyHtml when there is one) */
  bodyText: string;
  /** the written part as mail HTML ('' = a plain draft, opened as its text) */
  bodyHtml: string;
  quotedText: string;
  includeQuote: boolean;
  inReplyToMessageId: number | null;
  forwardOfMessageId: number | null;
  uiState: "open" | "collapsed";
  updatedAt: number;
  /** a send is in flight: the draft can't be edited or discarded until it settles */
  sending: boolean;
  /** bumped when the body changes other than through its editor (not stored) */
  bodyVersion: number;
  /** bodyHtml came from this session's editor (a stored one is re-read through the schema before it is sent) */
  canonical: boolean;
  attachments?: import("@terno/core").AttachmentRef[];
  /** A stored or in-flight revision still owns files; only an empty save acknowledgement unlocks From. */
  attachmentOwner?: boolean;
  /** the last save was refused for good (too long): no automatic retries */
  tooLong: boolean;
}

export type DraftFields = Pick<
  LocalDraft,
  "attachments" | "accountId" | "threadId" | "mode" | "toText" | "ccText" | "bccText" | "auto" | "subject" | "subjectEdited" | "bodyText" | "bodyHtml" | "quotedText" | "includeQuote" | "inReplyToMessageId" | "forwardOfMessageId" | "uiState"
>;

interface DraftsState {
  drafts: Record<string, LocalDraft>;
}

export const useDrafts = create<DraftsState>(() => ({ drafts: {} }));

const get = (key: string): LocalDraft | undefined => useDrafts.getState().drafts[key];
const put = (d: LocalDraft) => useDrafts.setState((s) => ({ drafts: { ...s.drafts, [d.key]: d } }));
const drop = (key: string) =>
  useDrafts.setState((s) => {
    const { [key]: _, ...rest } = s.drafts;
    return { drafts: rest };
  });

// ───────────────────────────── pure helpers ─────────────────────────────

/**
 * Recipients as typed, for saving: everything, unfinished addresses too
 * ("bob@" must survive a reload), `auto` on the ones Terno filled in.
 */
export function recipients(text: string, auto: readonly string[]): DraftAddress[] {
  const autoSet = new Set(auto.map((e) => e.toLowerCase()));
  return parseAddressList(text).map((a) => (autoSet.has(a.email.toLowerCase()) ? { ...a, auto: true as const } : a));
}

/** Recipients for sending: valid addresses only (sendDraft refuses to send when anything typed isn't one). */
export function validRecipients(text: string): Address[] {
  return parseAddressList(text).filter((a) => isValidEmail(a.email));
}

/** The signature block appended below what is written (the "-- " line marks it, so clients can fold it). */
export function signatureBlock(signature: string): string {
  const sig = signature.replace(/\s+$/, "");
  return sig ? `-- \n${sig}` : "";
}

/** What is sent: what the user wrote, the From account's signature, then the quoted original when it is kept. */
export function sendBody(d: Pick<LocalDraft, "bodyText" | "quotedText" | "includeQuote">, signature = ""): string {
  const parts = [d.bodyText.replace(/\s+$/, ""), signatureBlock(signature)].filter(Boolean);
  const body = parts.join("\n\n");
  return d.includeQuote && d.quotedText ? `${body}\n\n${d.quotedText}` : body;
}

/** sendBody's HTML twin (plan 16): the written part's mail HTML (trailing empty lines dropped), the signature, the quote. */
export function sendHtml(bodyHtml: string, d: Pick<LocalDraft, "quotedText" | "includeQuote">, signature = ""): string {
  const body = bodyHtml.replace(/(<div><br><\/div>)+$/, "");
  let html = [body, signatureHtml(signature)].filter(Boolean).join(GAP);
  if (d.includeQuote && d.quotedText) html += (html ? GAP : "") + textToHtml(d.quotedText);
  return emailDocument(html);
}

/** A draft as the backend stored it, in the renderer's shape. */
export function fromServer(d: Draft): LocalDraft {
  const text = (list: DraftAddress[]) => formatAddressList(list.map(({ name, email }) => ({ name, email })));
  return {
    key: `srv-${d.id}`,
    id: d.id,
    revision: d.revision,
    status: "saved",
    localRev: 0,
    savedRev: 0,
    accountId: d.accountId,
    threadId: d.threadId,
    mode: d.mode,
    toText: text(d.to),
    ccText: text(d.cc),
    bccText: text(d.bcc),
    auto: { to: d.to.filter((a) => a.auto).map((a) => a.email), cc: d.cc.filter((a) => a.auto).map((a) => a.email), bcc: d.bcc.filter((a) => a.auto).map((a) => a.email) },
    subject: d.subject,
    subjectEdited: d.subjectEdited,
    bodyText: d.bodyText,
    bodyHtml: d.bodyHtml ?? "",
    attachments: d.attachments ?? [],
    attachmentOwner: Boolean(d.attachments?.length),
    quotedText: d.quotedText,
    includeQuote: d.includeQuote,
    inReplyToMessageId: d.inReplyToMessageId,
    forwardOfMessageId: d.forwardOfMessageId,
    uiState: d.uiState,
    updatedAt: d.updatedAt,
    sending: false,
    bodyVersion: 0,
    canonical: false,
    tooLong: false,
  };
}

/** A draft's content, without its identity or save state (its body as the editor has it now). */
export function fieldsOf(d: LocalDraft): DraftFields {
  const cur = materialize(d.key) ?? d;
  const { attachments, accountId, threadId, mode, toText, ccText, bccText, auto, subject, subjectEdited, bodyText, bodyHtml, quotedText, includeQuote, inReplyToMessageId, forwardOfMessageId, uiState } = cur;
  return { attachments, accountId, threadId, mode, toText, ccText, bccText, auto, subject, subjectEdited, bodyText, bodyHtml, quotedText, includeQuote, inReplyToMessageId, forwardOfMessageId, uiState };
}

// ───────────────────────────── the editor's body ─────────────────────────────

/** What the editor gives for a draft's body: mail HTML ('' when empty) and its plain text, from one document. */
export type BodyReader = () => { html: string; text: string };
interface BodySource {
  read: BodyReader;
  dirty: boolean;
  /** its HTML comes from the schema (the editor's): a stand-in carrying a stored body isn't, and is re-read before sending */
  canonical: boolean;
}
const sources = new Map<string, BodySource>();

/**
 * The editor of a draft takes its body: `changed()` after each document change
 * (an edit: dirty, saved later), `dispose()` when it unmounts (what it has is
 * written to the draft first). A source of a draft that is gone does nothing.
 */
export function attachBody(key: string, read: BodyReader, options: { canonical?: boolean } = {}): { changed(): void; reset(): void; dispose(): void } {
  const source: BodySource = { read, dirty: false, canonical: options.canonical ?? true };
  sources.set(key, source);
  return {
    changed() {
      const d = get(key);
      if (!d || d.sending) return;
      // an unsaved revision is already pending for this body: the save will serialize the latest document, so only
      // the debounce moves (no store update per keystroke: nothing re-renders while typing)
      if (source.dirty && d.localRev > d.savedRev) return schedule(key);
      source.dirty = true;
      put({ ...d, localRev: d.localRev + 1, status: d.status === "saving" ? "saving" : "dirty", updatedAt: now(), tooLong: false });
      schedule(key);
    },
    // the editor reloaded what the draft has: nothing of its own to write
    reset() {
      source.dirty = false;
    },
    dispose() {
      if (sources.get(key) !== source) return;
      materialize(key);
      sources.delete(key);
    },
  };
}

/** Writes a dirty editor body into the draft (same revision: the edit was counted when it was made). */
export function materialize(key: string): LocalDraft | undefined {
  const d = get(key);
  const source = sources.get(key);
  if (!d || !source?.dirty) return d;
  source.dirty = false;
  const { html, text } = source.read();
  const next = { ...d, bodyHtml: html, bodyText: text, canonical: source.canonical };
  put(next);
  return next;
}

/** Has the user written anything worth keeping? A reply only prefilled by Terno isn't saved. */
export const authored = (d: LocalDraft): boolean => d.localRev > 0 || d.id !== null;

// ───────────────────────────── the writer ─────────────────────────────

const DEBOUNCE_MS = 800;
const MAX_WAIT_MS = 5000;
const RETRY_MS = [1000, 2000, 5000];

interface Writer {
  timer: ReturnType<typeof setTimeout> | null;
  /** the save in flight */
  inflight: Promise<void> | null;
  /** when the oldest unsaved edit was made (for the 5 s ceiling) */
  dirtySince: number | null;
  attempts: number;
}
const writers = new Map<string, Writer>();
const writer = (key: string): Writer => {
  let w = writers.get(key);
  if (!w) writers.set(key, (w = { timer: null, inflight: null, dirtySince: null, attempts: 0 }));
  return w;
};

type Call = (method: "drafts.save" | "drafts.delete", params: unknown) => Promise<unknown>;
let call: Call = (method, params) => client.call(method as "drafts.save", params as never) as Promise<unknown>;
let now = () => Date.now();
/** Tests: a fake backend and clock. */
export function setDraftTransport(c: Call, clock?: () => number): void {
  call = c;
  if (clock) now = clock;
}

let seq = 0;
const newKey = () => `local-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** A new draft (not saved until the user writes something). Returns its key. */
export function createDraft(fields: DraftFields): string {
  const key = newKey();
  put({ key, id: null, revision: 0, status: "clean", localRev: 0, savedRev: 0, updatedAt: now(), sending: false, bodyVersion: 0, canonical: false, tooLong: false, ...fields });
  return key;
}

export const draftSenderLocked = (d: LocalDraft): boolean => Boolean(d.attachments?.length || d.attachmentOwner);

/** An edit: the content changes now, the save follows (800 ms after the last edit, ≤ 5 s while typing). */
export function editDraft(key: string, patch: Partial<DraftFields>): void {
  // a body patch is compared with the body as the editor has it now
  const d = "bodyText" in patch || "bodyHtml" in patch ? materialize(key) : get(key);
  // nothing changes under a send in flight (it is sending what is there now)
  if (!d || d.sending) return;
  if (patch.accountId !== undefined && patch.accountId !== d.accountId && draftSenderLocked(d)) return;
  const bodyChanged = (patch.bodyText !== undefined && patch.bodyText !== d.bodyText) || (patch.bodyHtml !== undefined && patch.bodyHtml !== d.bodyHtml);
  put({
    ...d,
    ...patch,
    localRev: d.localRev + 1,
    status: d.status === "saving" ? "saving" : "dirty",
    updatedAt: now(),
    tooLong: false,
    ...(bodyChanged ? { bodyVersion: d.bodyVersion + 1, canonical: false } : {}),
  });
  if (bodyChanged) {
    const source = sources.get(key);
    if (source) source.dirty = false;
  }
  schedule(key);
}

/** UI state (open/collapsed) changes: saved with the draft, but not an authored edit. */
export function setDraftUi(key: string, uiState: LocalDraft["uiState"]): void {
  const d = get(key);
  if (!d || d.uiState === uiState) return;
  put({ ...d, uiState });
  if (d.id !== null) {
    put({ ...get(key)!, localRev: d.localRev + 1, status: d.status === "saving" ? "saving" : "dirty" });
    schedule(key);
  }
}

function schedule(key: string): void {
  const w = writer(key);
  w.dirtySince ??= now();
  if (w.timer) clearTimeout(w.timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now() - w.dirtySince)));
  w.timer = setTimeout(() => {
    w.timer = null;
    void save(key);
  }, wait);
}

/** Sends the current content unless a save is in flight (it re-saves when that one answers). */
function save(key: string): Promise<void> {
  const w = writer(key);
  if (w.inflight) return w.inflight;
  // the editor's body, serialized once for this save (same document as the revision it saves)
  const d = materialize(key);
  if (!d || !authored(d) || d.savedRev === d.localRev) return Promise.resolve();
  const rev = d.localRev;
  w.dirtySince = null;
  put({ ...d, status: "saving", attachmentOwner: d.attachmentOwner || Boolean(d.attachments?.length) });
  const params = {
    id: d.id ?? undefined,
    baseRevision: d.id !== null ? d.revision : undefined,
    accountId: d.accountId,
    threadId: d.threadId,
    mode: d.mode,
    to: recipients(d.toText, d.auto.to),
    cc: recipients(d.ccText, d.auto.cc),
    bcc: recipients(d.bccText, d.auto.bcc),
    subject: d.subject,
    subjectEdited: d.subjectEdited,
    bodyText: d.bodyText,
    bodyHtml: d.bodyHtml,
    attachments: d.attachments ?? [],
    quotedText: d.quotedText,
    includeQuote: d.includeQuote,
    inReplyToMessageId: d.inReplyToMessageId,
    forwardOfMessageId: d.forwardOfMessageId,
    uiState: d.uiState,
  };
  w.inflight = call("drafts.save", params).then(
    (res) => {
      w.inflight = null;
      w.attempts = 0;
      const cur = get(key);
      if (!cur) return;
      const saved = res as Draft | null;
      if (!saved) {
        // gone (sent or discarded elsewhere): nothing left to save into
        drop(key);
        writers.delete(key);
        return;
      }
      const done = cur.localRev === rev;
      put({ ...cur, id: saved.id, revision: saved.revision, savedRev: rev, status: done ? "saved" : "dirty", attachmentOwner: Boolean(saved.attachments?.length) });
      if (!done) return save(key);
    },
    (error: unknown) => {
      w.inflight = null;
      const cur = get(key);
      if (!cur) return;
      // refused as invalid (past the size limits): trying again won't help until it changes; Retry stays
      if ((error as { code?: string } | null)?.code === "BAD_REQUEST") {
        put({ ...cur, status: "error", tooLong: true });
        return;
      }
      put({ ...cur, status: "error" });
      const delay = RETRY_MS[Math.min(w.attempts, RETRY_MS.length - 1)]!;
      w.attempts++;
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        w.timer = null;
        void save(key);
      }, delay);
    },
  );
  return w.inflight;
}

/** "Retry" after an error: now. */
export function retryDraft(key: string): void {
  const w = writer(key);
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  void save(key);
}

/** Cancels the debounce and waits until what is written now is saved (or the save fails). */
export async function flushDraft(key: string): Promise<void> {
  const w = writers.get(key);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  for (let i = 0; i < 5; i++) {
    if (w.inflight) await w.inflight;
    const d = get(key);
    if (!d || d.status === "error" || !authored(d) || d.savedRev === d.localRev) return;
    await save(key);
  }
}

/** Every dirty draft, before the page goes away or hands the mailbox over; gives up after `capMs`. */
export async function flushAllDrafts(capMs = 1000): Promise<void> {
  const all = Promise.all(Object.keys(useDrafts.getState().drafts).map((k) => flushDraft(k).catch(() => {})));
  await Promise.race([all, new Promise((r) => setTimeout(r, capMs))]);
}

/**
 * Before something that would drop the page (a new build taking over): every
 * draft flushed, and true only if each is saved as written. A save that is
 * slow past `capMs` or failed says false, and the caller doesn't go ahead.
 */
export async function draftsSaved(capMs = 5000): Promise<boolean> {
  await flushAllDrafts(capMs);
  return Object.values(useDrafts.getState().drafts).every((d) => !authored(d) || (d.savedRev === d.localRev && d.status !== "error"));
}

/** Waits for the save in flight (if any) and stops further saves: the draft is about to be sent or discarded. */
async function settle(key: string): Promise<LocalDraft | undefined> {
  const w = writers.get(key);
  if (w?.timer) clearTimeout(w.timer);
  if (w) w.timer = null;
  if (w?.inflight) await w.inflight.catch(() => {});
  // after the wait: what was typed while that save was out (and it may have failed) is in what this returns
  return materialize(key);
}

/** The draft as it is now, after any save in flight answered, ready to send. */
export async function draftForSend(key: string): Promise<LocalDraft | undefined> {
  return settle(key);
}

/** A send started or settled: while it runs the draft can't be edited or discarded. */
export function markSending(key: string, sending: boolean): void {
  const d = get(key);
  if (d && d.sending !== sending) put({ ...d, sending });
}

/** A send didn't happen (refused or failed): the autosave it paused picks up whatever isn't saved yet. */
export function resumeDraft(key: string): void {
  const d = get(key);
  if (d && authored(d) && d.savedRev !== d.localRev) schedule(key);
}

/** After a successful send (the backend deleted the stored draft with it). */
export function forgetDraft(key: string): void {
  const w = writers.get(key);
  if (w?.timer) clearTimeout(w.timer);
  writers.delete(key);
  drop(key);
}

/** Deletes a draft; returns what it was, for "Undo". */
export async function discardDraft(key: string): Promise<LocalDraft | undefined> {
  // a send in flight decides: sent, it is gone; failed, it stays for another try
  if (get(key)?.sending) return undefined;
  const d = await settle(key);
  if (!d || d.sending) return undefined;
  forgetDraft(key);
  if (d.id !== null) await call("drafts.delete", { id: d.id }).catch(() => {});
  return d;
}

/** "Undo" a discard: the same content as a new draft (saved at once). */
export function restoreDiscarded(d: LocalDraft): string {
  const key = createDraft({ ...fieldsOf(d), uiState: "open" });
  editDraft(key, {});
  void flushDraft(key);
  return key;
}

// ───────────────────────────── restore and lookups ─────────────────────────────

/** At startup: every stored draft, as the backend has it. */
export async function loadDrafts(list: () => Promise<Draft[]> = () => client.call("drafts.list", {})): Promise<void> {
  const stored = await list();
  useDrafts.setState((s) => {
    const drafts = { ...s.drafts };
    for (const d of stored) if (!Object.values(drafts).some((x) => x.id === d.id)) drafts[`srv-${d.id}`] = fromServer(d);
    return { drafts };
  });
}

interface DraftIndex {
  /** each conversation's most recently edited draft */
  newest: Map<number, LocalDraft>;
  /** conversations with a draft that has something written in it */
  written: Set<number>;
}
/** One pass per drafts update (the map is replaced on every change), shared by every row, the reader and the strip. */
const indexes = new WeakMap<Record<string, LocalDraft>, DraftIndex>();
export function draftIndex(drafts: Record<string, LocalDraft>): DraftIndex {
  let index = indexes.get(drafts);
  if (index) return index;
  index = { newest: new Map(), written: new Set() };
  for (const d of Object.values(drafts)) {
    if (d.threadId === null || d.mode === "new") continue;
    const best = index.newest.get(d.threadId);
    if (!best || d.updatedAt > best.updatedAt) index.newest.set(d.threadId, d);
    if (authored(d) && (d.bodyText.trim() || d.id !== null || sources.get(d.key)?.dirty)) index.written.add(d.threadId);
  }
  indexes.set(drafts, index);
  return index;
}

/** The draft shown inline in a conversation: the most recently edited one there. */
export function threadDraftKey(drafts: Record<string, LocalDraft>, threadId: number): string | null {
  return draftIndex(drafts).newest.get(threadId)?.key ?? null;
}

/** The draft a conversation shows inline: the one opened explicitly for it, else its most recent. */
export function shownDraftKey(drafts: Record<string, LocalDraft>, threadId: number, shown: { threadId: number; key: string } | null): string | null {
  if (shown && shown.threadId === threadId && drafts[shown.key]) return shown.key;
  return threadDraftKey(drafts, threadId);
}

/** For list rows: does this conversation have a draft with something written in it? (one boolean per row) */
export function useHasDraft(threadId: number): boolean {
  return useDrafts((s) => draftIndex(s.drafts).written.has(threadId));
}

export function toAddressList(text: string): Address[] {
  return parseAddressList(text);
}

// test builds: a send held in flight, to check that nothing edits under it
exposeForTests({ holdSending: (sending: boolean) => Object.keys(useDrafts.getState().drafts).forEach((k) => markSending(k, sending)) });

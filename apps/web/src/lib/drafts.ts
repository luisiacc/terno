import { formatAddressList, isValidEmail, parseAddressList, type Address } from "@unica/core";
import type { Draft, DraftAddress, DraftMode } from "@unica/core/rpc";
import { create } from "zustand";
import { client } from "~/rpc/connection";

/**
 * Drafts in the renderer: one entry per draft, keyed by a stable client key
 * (the server id arrives with the first acknowledged save), and their write
 * lifecycle.
 *
 * - Every edit bumps a local revision and marks the draft dirty. A save goes
 *   out 800 ms after the last edit, and at least every 5 s while typing.
 * - At most one save is in flight per draft; its answer applies to the draft
 *   (key) it was sent for, never to "the current draft".
 * - "Borrador guardado" means the acknowledged revision is the local one.
 * - A failed save says so and retries (1, 2, 5 s); the text stays in memory.
 * - Send, discard and flush first cancel the debounce and wait for the save
 *   in flight. The server's revision travels with every save: an edit made on
 *   a revision another writer replaced becomes its own draft, never an
 *   overwrite. A save answered with null means the draft is gone.
 *
 * What can be lost in a crash: edits since the last acknowledgement (≤ 800 ms
 * after a pause, ≤ 5 s while typing).
 */

export type DraftStatus = "clean" | "dirty" | "saving" | "saved" | "error";

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
  /** recipients as typed (comma-separated); `auto` remembers which addresses Única filled in */
  toText: string;
  ccText: string;
  bccText: string;
  auto: string[];
  subject: string;
  subjectEdited: boolean;
  bodyText: string;
  quotedText: string;
  includeQuote: boolean;
  inReplyToMessageId: number | null;
  forwardOfMessageId: number | null;
  uiState: "open" | "collapsed";
  updatedAt: number;
}

export type DraftFields = Pick<
  LocalDraft,
  "accountId" | "threadId" | "mode" | "toText" | "ccText" | "bccText" | "auto" | "subject" | "subjectEdited" | "bodyText" | "quotedText" | "includeQuote" | "inReplyToMessageId" | "forwardOfMessageId" | "uiState"
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

/** Recipients from what was typed: valid addresses only, `auto` kept on the ones Única filled in. */
export function recipients(text: string, auto: readonly string[]): DraftAddress[] {
  const autoSet = new Set(auto.map((e) => e.toLowerCase()));
  return parseAddressList(text)
    .filter((a) => isValidEmail(a.email))
    .map((a) => (autoSet.has(a.email.toLowerCase()) ? { ...a, auto: true as const } : a));
}

/** What is sent: what the user wrote, then the quoted original when it is kept. */
export function sendBody(d: Pick<LocalDraft, "bodyText" | "quotedText" | "includeQuote">): string {
  const body = d.bodyText.replace(/\s+$/, "");
  return d.includeQuote && d.quotedText ? `${body}\n\n${d.quotedText}` : body;
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
    auto: [...d.to, ...d.cc, ...d.bcc].filter((a) => a.auto).map((a) => a.email),
    subject: d.subject,
    subjectEdited: d.subjectEdited,
    bodyText: d.bodyText,
    quotedText: d.quotedText,
    includeQuote: d.includeQuote,
    inReplyToMessageId: d.inReplyToMessageId,
    forwardOfMessageId: d.forwardOfMessageId,
    uiState: d.uiState,
    updatedAt: d.updatedAt,
  };
}

/** A draft's content, without its identity or save state. */
export function fieldsOf(d: LocalDraft): DraftFields {
  const { accountId, threadId, mode, toText, ccText, bccText, auto, subject, subjectEdited, bodyText, quotedText, includeQuote, inReplyToMessageId, forwardOfMessageId, uiState } = d;
  return { accountId, threadId, mode, toText, ccText, bccText, auto, subject, subjectEdited, bodyText, quotedText, includeQuote, inReplyToMessageId, forwardOfMessageId, uiState };
}

/** Has the user written anything worth keeping? A reply only prefilled by Única isn't saved. */
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
  put({ key, id: null, revision: 0, status: "clean", localRev: 0, savedRev: 0, updatedAt: now(), ...fields });
  return key;
}

/** An edit: the content changes now, the save follows (800 ms after the last edit, ≤ 5 s while typing). */
export function editDraft(key: string, patch: Partial<DraftFields>): void {
  const d = get(key);
  if (!d) return;
  put({ ...d, ...patch, localRev: d.localRev + 1, status: d.status === "saving" ? "saving" : "dirty", updatedAt: now() });
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
  const d = get(key);
  if (!d || !authored(d) || d.savedRev === d.localRev) return Promise.resolve();
  const rev = d.localRev;
  w.dirtySince = null;
  put({ ...d, status: "saving" });
  const params = {
    id: d.id ?? undefined,
    baseRevision: d.id !== null ? d.revision : undefined,
    accountId: d.accountId,
    threadId: d.threadId,
    mode: d.mode,
    to: recipients(d.toText, d.auto),
    cc: recipients(d.ccText, d.auto),
    bcc: recipients(d.bccText, d.auto),
    subject: d.subject,
    subjectEdited: d.subjectEdited,
    bodyText: d.bodyText,
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
      put({ ...cur, id: saved.id, revision: saved.revision, savedRev: rev, status: done ? "saved" : "dirty" });
      if (!done) return save(key);
    },
    () => {
      w.inflight = null;
      const cur = get(key);
      if (!cur) return;
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

/** "Reintentar" after an error: now. */
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

/** Waits for the save in flight (if any) and stops further saves: the draft is about to be sent or discarded. */
async function settle(key: string): Promise<LocalDraft | undefined> {
  const w = writers.get(key);
  if (w?.timer) clearTimeout(w.timer);
  if (w) w.timer = null;
  if (w?.inflight) await w.inflight.catch(() => {});
  return get(key);
}

/** The draft as it is now, after any save in flight answered, ready to send. */
export async function draftForSend(key: string): Promise<LocalDraft | undefined> {
  return settle(key);
}

/** After a successful send (the backend deleted the stored draft with it). */
export function forgetDraft(key: string): void {
  const w = writers.get(key);
  if (w?.timer) clearTimeout(w.timer);
  writers.delete(key);
  drop(key);
}

/** Deletes a draft; returns what it was, for "Deshacer". */
export async function discardDraft(key: string): Promise<LocalDraft | undefined> {
  const d = await settle(key);
  if (!d) return undefined;
  forgetDraft(key);
  if (d.id !== null) await call("drafts.delete", { id: d.id }).catch(() => {});
  return d;
}

/** "Deshacer" a discard: the same content as a new draft (saved at once). */
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

/** The draft shown inline in a conversation: the most recently edited one there. */
export function threadDraftKey(drafts: Record<string, LocalDraft>, threadId: number): string | null {
  let best: LocalDraft | null = null;
  for (const d of Object.values(drafts)) if (d.threadId === threadId && d.mode !== "new" && (!best || d.updatedAt > best.updatedAt)) best = d;
  return best?.key ?? null;
}

/** For list rows: does this conversation have a draft with something written in it? (one boolean per row) */
export function useHasDraft(threadId: number): boolean {
  return useDrafts((s) => {
    for (const d of Object.values(s.drafts)) if (d.threadId === threadId && authored(d) && (d.bodyText.trim() || d.id !== null)) return true;
    return false;
  });
}

export function toAddressList(text: string): Address[] {
  return parseAddressList(text);
}

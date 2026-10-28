import type { AttachmentRef, ThreadDetail } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp } from "~/state/app";
import { loadThread, useThreads } from "~/state/threads";
import { draftAttachmentBudget } from "./attachments";
import { mergeAttachmentRefs } from "./compose-fields";
import { beginDraftWork, editDraft, fieldsOf, flushDraft, materialize, useDrafts, type LocalDraft } from "./drafts";

/**
 * Plan 60: a forward never waits for the original's files. It opens with the
 * ones on this device; the rest are asked for again (a capture retry, at most
 * three tries per Forward) and join the draft as they arrive. The draft says
 * what's still coming, what couldn't come (Try again), or which From can carry them.
 */
export type ForwardFiles =
  | { status: "fetching"; names: string[] }
  | { status: "failed"; names: string[] }
  | { status: "tooLarge" }
  | { status: "account"; account: string };

/** per draft key: what its forward is still missing (no entry: nothing) */
export const useForwardFiles = create<Record<string, ForwardFiles>>(() => ({}));

/** when each try starts after the one before: now, ~4 s, ~15 s; then the draft offers Try again */
export const FORWARD_FILE_DELAYS = [0, 4_000, 15_000] as const;

interface Source { threadId: number; messageId: number; accountId: number }
interface Session extends Source {
  key: string;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** looks run one at a time: one asked for meanwhile waits for it (and makes it look once more) */
  running: Promise<boolean> | null;
  again: boolean;
  /** waiting for the original's account in From (no try runs meanwhile) */
  paused: boolean;
  /** parts this try couldn't confirm: asked again on the next try, not on every keystroke */
  unconfirmed: Set<string>;
  /** the original's parts this device confirmed (attachments.info), by asset */
  verified: Map<string, AttachmentRef>;
  detail: ThreadDetail | null;
  unsubscribe: () => void;
}

/** tries in progress (or waiting for From), by draft key */
const sessions = new Map<string, Session>();
/** every forward draft this module speaks for, until it goes or stops forwarding its original (then all of it is forgotten) */
const sources = new Map<string, Source>();
/** refs a draft already had from its original (placed at open or adopted later): a file the user removes never comes back */
const offered = new Map<string, Set<string>>();
/** one capture retry per original at a time, whichever drafts forward it */
const retrying = new Map<number, Promise<void>>();
/** one drafts watch for all of them: a draft that goes, or stops forwarding, takes its status and memory with it */
let janitor: (() => void) | null = null;
/** compose.ts: an open (Reply/Forward) in flight owns the draft until it settles; nothing is adopted under it */
let opening: () => boolean = () => false;
export function setForwardOpenProbe(probe: () => boolean): void {
  opening = probe;
}

const offeredKey = (key: string, messageId: number) => `${key}:${messageId}`;
const isForwardOf = (d: LocalDraft | undefined, messageId: number): d is LocalDraft => !!d && d.mode === "forward" && d.forwardOfMessageId === messageId && !d.recovery;
const same = (a: ForwardFiles | undefined, b: ForwardFiles) => JSON.stringify(a) === JSON.stringify(b);
const setState = (key: string, state: ForwardFiles | null) =>
  useForwardFiles.setState((s) => {
    if (!state) {
      if (!(key in s)) return s;
      const next = { ...s };
      delete next[key];
      return next;
    }
    return same(s[key], state) ? s : { ...s, [key]: state };
  }, true);

function retryCapture(accountId: number, messageId: number): Promise<void> {
  let running = retrying.get(messageId);
  if (!running) {
    running = client
      .call("attachments.retry", { accountId, messageId })
      .then(() => {}, () => {})
      .finally(() => retrying.delete(messageId));
    retrying.set(messageId, running);
  }
  return running;
}

/**
 * Starts (or starts over) bringing a forward's missing files from its original:
 * after Forward opened or converted the draft (`placed`: the refs it already
 * carries), on Forward again, and on Try again. Nothing is asked for when the
 * original's files are all on the draft already.
 */
export function fetchForwardFiles(key: string, source: Source, placed: readonly AttachmentRef[] = []): void {
  stopSession(key);
  const d = useDrafts.getState().drafts[key];
  if (!isForwardOf(d, source.messageId)) return;
  const previous = sources.get(key);
  if (previous && previous.messageId !== source.messageId) offered.delete(offeredKey(key, previous.messageId));
  sources.set(key, source);
  janitor ??= useDrafts.subscribe(sweep);
  const id = offeredKey(key, source.messageId);
  const seen = offered.get(id) ?? new Set((d.attachments ?? []).map((a) => a.assetId));
  for (const ref of placed) seen.add(ref.assetId);
  offered.set(id, seen);
  const session: Session = { ...source, key, attempt: 0, running: null, again: false, paused: false, unconfirmed: new Set(), verified: new Map(), detail: null, unsubscribe: () => {} };
  sessions.set(key, session);
  const stopDrafts = useDrafts.subscribe((state, previous) => {
    const live = state.drafts[key];
    if (live === previous.drafts[key] || !isForwardOf(live, source.messageId)) return;
    // From set to the original's account: the tries go on
    if (session.paused && live.accountId === source.accountId) { session.paused = false; void attempt(session); return; }
    // a send that didn't go, a save that settled: look again
    look(session);
  });
  // the conversation open in the reader refetches on change: a capture that lands meanwhile counts at once
  const stopThreads = useThreads.subscribe((state, previous) => {
    const detail = state.details.get(source.threadId);
    if (detail && detail !== previous.details.get(source.threadId)) look(session, detail);
  });
  session.unsubscribe = () => { stopDrafts(); stopThreads(); };
  void attempt(session);
}

/** Forward pressed on a forward already open: a fetch that failed (or never ran, after a reload) runs again. */
export async function ensureForwardFiles(key: string, threadId: number): Promise<void> {
  if (sessions.get(key)?.timer || sessions.get(key)?.running) return;
  const d = useDrafts.getState().drafts[key];
  if (!d || d.mode !== "forward" || d.forwardOfMessageId === null || d.forwardOfMessageId === undefined) return;
  const known = sources.get(key);
  if (known?.messageId === d.forwardOfMessageId) return fetchForwardFiles(key, known);
  const detail = await loadThread(threadId);
  const message = detail?.messages.find((m) => m.id === d.forwardOfMessageId);
  if (message && useDrafts.getState().drafts[key] === d) fetchForwardFiles(key, { threadId, messageId: message.id, accountId: message.accountId });
}

/** The draft's Try again. */
export function retryForwardFiles(key: string): void {
  const source = sources.get(key);
  if (source) fetchForwardFiles(key, source);
}

function sweep(state: { drafts: Record<string, LocalDraft> }, previous: { drafts: Record<string, LocalDraft> }): void {
  if (state.drafts === previous.drafts) return;
  for (const [key, source] of sources) {
    const live = state.drafts[key];
    if (live !== previous.drafts[key] && !isForwardOf(live, source.messageId)) forget(key);
  }
}

/** The draft went or stopped forwarding its original: its tries, status and memory go too. */
function forget(key: string): void {
  const source = sources.get(key);
  stopSession(key);
  setState(key, null);
  if (source) offered.delete(offeredKey(key, source.messageId));
  sources.delete(key);
  if (!sources.size && janitor) { janitor(); janitor = null; }
}

function stopSession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  clearTimeout(session.timer);
  session.unsubscribe();
}

const alive = (s: Session) => sessions.get(s.key) === s;

/** One try: what's on the device now, else a capture retry and a fresh look; then the next try, or Try again. */
async function attempt(s: Session): Promise<void> {
  s.timer = undefined;
  s.unconfirmed.clear();
  if (await settle(s, await loadThread(s.threadId).catch(() => null))) return;
  if (!alive(s)) return;
  const d = useDrafts.getState().drafts[s.key];
  // another From can't carry them: wait for the original's account (the draft says so)
  if (d && d.accountId !== s.accountId) { s.paused = true; return; }
  await retryCapture(s.accountId, s.messageId);
  if (!alive(s) || await settle(s, await loadThread(s.threadId, true).catch(() => null))) return;
  if (!alive(s)) return;
  s.attempt++;
  if (s.attempt < FORWARD_FILE_DELAYS.length) {
    s.timer = setTimeout(() => void attempt(s), FORWARD_FILE_DELAYS[s.attempt]);
    return;
  }
  const current = useForwardFiles.getState()[s.key];
  setState(s.key, { status: "failed", names: current && "names" in current ? current.names : [] });
  // nothing more on its own (Try again or Forward again start over); the status stays until the draft goes
  stopSession(s.key);
}

/** A look outside the tries (a draft or thread change), with the last thread seen unless a newer one came. */
function look(s: Session, detail?: ThreadDetail): void {
  if (detail || s.detail) void settle(s, detail ?? null);
}

/**
 * Takes in what the original has on the device that the draft hasn't had yet, and
 * says what's still missing. true: nothing more to do (all here, the original gone, too large).
 */
function settle(s: Session, detail: ThreadDetail | null): Promise<boolean> {
  if (!alive(s)) return Promise.resolve(true);
  if (detail) s.detail = detail;
  // one already running (a thread refetch started it): its answer, after one more look with the newest thread
  if (s.running) { s.again = true; return s.running; }
  s.running = (async () => {
    try {
      let done = false;
      do {
        s.again = false;
        done = await settleOnce(s, s.detail);
      } while (!done && s.again && alive(s));
      return done;
    } finally { s.running = null; }
  })();
  return s.running;
}

async function settleOnce(s: Session, detail: ThreadDetail | null): Promise<boolean> {
  if (!detail) return false;
  s.detail = detail;
  const message = detail.thread.id === s.threadId ? detail.messages.find((m) => m.id === s.messageId) : undefined;
  // the original is gone: nothing to bring
  if (!message) { forget(s.key); return true; }
  const seen = offered.get(offeredKey(s.key, s.messageId))!;
  const missing = () => message.attachments.filter((a) => !a.assetId || !seen.has(a.assetId));
  const complete = () => message.attachmentState === "complete" && !missing().length;
  if (complete()) { stopSession(s.key); setState(s.key, null); return true; }
  const d = useDrafts.getState().drafts[s.key];
  if (d && d.accountId !== s.accountId) {
    setState(s.key, { status: "account", account: getApp().accounts.find((a) => a.id === s.accountId)?.email ?? "" });
    return false;
  }
  const refs: AttachmentRef[] = [];
  for (const part of message.attachments) {
    if (!part.assetId || seen.has(part.assetId) || s.unconfirmed.has(part.assetId)) continue;
    let ref = s.verified.get(part.assetId);
    if (!ref) {
      try {
        const info = await client.call("attachments.info", { accountId: s.accountId, assetId: part.assetId });
        if (info.filename === part.filename && info.mime === part.mime && info.size === part.size && (info.contentId ?? null) === (part.contentId ?? null)) s.verified.set(part.assetId, (ref = { assetId: part.assetId, filename: part.filename, mime: part.mime, size: part.size, contentId: part.contentId ?? null }));
      } catch { /* not ready on this device yet: a later try */ }
      if (!alive(s)) return true;
      if (!ref) s.unconfirmed.add(part.assetId);
    }
    if (ref) refs.push(ref);
  }
  if (refs.length) {
    const outcome = await adopt(s, refs);
    if (!alive(s)) return true;
    // the status stays (the draft watch clears it when the draft goes or stops forwarding)
    if (outcome === "tooLarge") { stopSession(s.key); setState(s.key, { status: "tooLarge" }); return true; }
  }
  if (complete()) { stopSession(s.key); setState(s.key, null); return true; }
  setState(s.key, { status: "fetching", names: missing().map((a) => a.filename) });
  return false;
}

/** What may change between a look and the edit: any of it, and the files wait for the next look. */
const unchanged = (a: LocalDraft, b: LocalDraft) =>
  a.id === b.id && a.generation === b.generation && a.localRev === b.localRev && a.bodyVersion === b.bodyVersion && a.bodyText === b.bodyText && a.bodyHtml === b.bodyHtml && a.attachments === b.attachments && a.accountId === b.accountId && a.mode === b.mode && a.forwardOfMessageId === b.forwardOfMessageId && a.sending === b.sending && !b.recovery;

/** Adds confirmed files to the draft, the way an attached file joins it. "wait": not now (a later look tries again). */
async function adopt(s: Session, refs: readonly AttachmentRef[]): Promise<"adopted" | "wait" | "tooLarge"> {
  const takes = (d: LocalDraft | undefined): d is LocalDraft => isForwardOf(d, s.messageId) && d.accountId === s.accountId && !d.sending;
  if (opening() || !takes(useDrafts.getState().drafts[s.key])) return "wait";
  const finish = beginDraftWork();
  if (!finish) return "wait";
  try {
    let d = materialize(s.key);
    if (!takes(d)) return "wait";
    if (!d.attachments?.length && !d.attachmentOwner) {
      // the first files: the draft's From is saved before they join (a save never changes account and adds files at once)
      if (d.id !== null) await flushDraft(s.key);
      if (!alive(s)) return "wait";
      d = materialize(s.key);
      if (!takes(d) || (d.id === null ? d.status === "saving" : d.status !== "saved" || d.savedRev !== d.localRev)) return "wait";
    }
    const snapshot = d;
    const attachments = mergeAttachmentRefs(snapshot.attachments ?? [], refs);
    const seen = offered.get(offeredKey(s.key, s.messageId))!;
    if (attachments.length === (snapshot.attachments?.length ?? 0)) { for (const ref of refs) seen.add(ref.assetId); return "adopted"; }
    const signature = getApp().accounts.find((a) => a.id === snapshot.accountId)?.signature;
    const fits = await draftAttachmentBudget({ ...fieldsOf(snapshot), attachments }, signature);
    const live = materialize(s.key);
    if (!alive(s) || opening() || !takes(live) || !unchanged(snapshot, live) || getApp().accounts.find((a) => a.id === live.accountId)?.signature !== signature) return "wait";
    if (!fits) return "tooLarge";
    if (!editDraft(s.key, { attachments })) return "wait";
    for (const ref of refs) seen.add(ref.assetId);
    await flushDraft(s.key);
    return "adopted";
  } finally { finish(); }
}

/** Tests: how much is kept (bounded by the forward drafts open). */
export function forwardFilesHeld(): { sessions: number; sources: number; offered: number; watching: boolean } {
  return { sessions: sessions.size, sources: sources.size, offered: offered.size, watching: janitor !== null };
}

/** Tests: every session stopped, everything forgotten. */
export function resetForwardFiles(): void {
  for (const key of sessions.keys()) stopSession(key);
  janitor?.(); janitor = null;
  sources.clear(); offered.clear(); retrying.clear();
  useForwardFiles.setState({}, true);
}

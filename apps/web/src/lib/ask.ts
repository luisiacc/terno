import { ASK_TURNS_MAX, type AiAskResult, type AiErrorKind, type AskConversationSummary, type AskOlderOffer, type AskSourceRef, type AskSourceView, type AskTurn } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { localized } from "~/lib/i18n";
import { openThread } from "~/lib/page";
import { revealSummaryMessage } from "~/lib/summaries";
import { opened } from "./action-preview";
import { getApp, setApp, useApp } from "~/state/app";
import { toggleAsk } from "~/lib/palette-open";
import { useAppearance } from "~/lib/appearance";
import { installFocusIntent } from "~/lib/focus-intent";
import { focusAfterDialog, messageFocusTarget } from "~/lib/focus-message";
import { forgetPinnedAnswer } from "~/lib/pinned-ask-state";
import { leaveNewDraft } from "~/lib/compose";

/**
 * Plan 141: the conversation, in a small store outside the palette: closing it doesn't stop an answer, and ⌘⇧K comes
 * back to it for 30 minutes, caret in the follow-up box, so opening a source and coming back loses nothing.
 */
export const ASK_RETURN_MS = 30 * 60_000;

export interface AskRunning {
  requestId: string;
  question: string;
  text: string;
  /** plan 162 (the owner, 2026-11-08): the text as it came, a piece per delta, so each fades in on its own */
  chunks: string[];
  /** still looking through older mail on the server */
  older: { done: number; total: number } | null;
  searchingOlder: boolean;
}

export interface AskState {
  conversationId: number | null;
  turns: AskTurn[];
  sources: Record<number, AskSourceView>;
  running: AskRunning | null;
  /** plan 162: with its catalog key, so the shared notice says the app's own words (no credit isn't a bad key) */
  error: { question: string; message: string; kind: AiErrorKind | undefined; key?: string | undefined } | null;
  /** plan 143: why a sentence didn't open a preview; the page stays, with the sentence */
  notice: { question: string; text: string } | null;
  noProvider: boolean;
  older: AskOlderOffer;
  /** mail with no text yet, or a read that stopped at its limit */
  incomplete: boolean;
  /** what the last click on Search older mail found */
  olderFound: number | null;
  /** a server's search may not have found everything */
  olderPartial: boolean;
  /** ups each time conversations go in any window: what was reading them, or lists them, looks again */
  gone: number;
  /** a source now in Spam or Trash, asked for once: the next ask opens it */
  armedSource: number | null;
  /** plan 161: the conversation a source opened, and its message: the reader offers the way back to the answer there */
  returnTo: { threadId: number; messageId: number; conversationId: number | null } | null;
  /** just finished: for screen readers */
  ready: number;
  usedAt: number;
}

const EMPTY: Omit<AskState, "usedAt" | "ready" | "gone"> = { conversationId: null, turns: [], sources: {}, running: null, error: null, notice: null, noProvider: false, older: { kind: "none" }, incomplete: false, olderFound: null, olderPartial: false, armedSource: null, returnTo: null };

export const useAsk = create<AskState>(() => ({ ...EMPTY, ready: 0, usedAt: 0, gone: 0 }));

/** Plan 165: how many conversations keep their visited sources (session only). */
const VISITED_KEEP = 20;

/**
 * Plan 165: the sources read in each conversation (shown in Ask, or opened in the reader), so going through ten of them
 * one by one says which are done. Session only; the last 20 conversations, the oldest let go first.
 */
export const useAskVisited = create<{ byConversation: ReadonlyMap<number, readonly number[]> }>(() => ({ byConversation: new Map() }));

export function markVisited(conversationId: number | null, messageId: number): void {
  if (conversationId === null) return;
  const was = useAskVisited.getState().byConversation;
  const seen = was.get(conversationId) ?? [];
  if (seen.includes(messageId)) return;
  const next = new Map(was);
  // the newest last: a Map keeps insertion order, so the first key is the oldest
  next.delete(conversationId);
  next.set(conversationId, [...seen, messageId]);
  while (next.size > VISITED_KEEP) next.delete(next.keys().next().value!);
  useAskVisited.setState({ byConversation: next });
}

/** Has this conversation's source been read? */
export const useVisited = (conversationId: number | null, messageId: number): boolean => useAskVisited((s) => conversationId !== null && (s.byConversation.get(conversationId)?.includes(messageId) ?? false));

function forgetVisited(): void {
  useAskVisited.setState({ byConversation: new Map() });
  places.clear();
}

/**
 * Plan 165: where each conversation was left, so coming back to it (a source read, ⇧⌘K, Back to the answer, Unpin) is
 * coming back to the same place: the answer read to, the sources scrolled to, the row chosen, a follow-up half typed.
 * The scrolls hold only while no answer has come since (`turns`). Session only; the last 20 conversations.
 */
export interface AskPlace {
  turns: number;
  top: number;
  sourcesTop: number;
  /** cmdk's value for the chosen source row */
  chosen: string | null;
  followUp: string;
}
const places = new Map<number, AskPlace>();

export const askPlace = (conversationId: number | null): AskPlace | undefined => (conversationId === null ? undefined : places.get(conversationId));

export function keepAskPlace(conversationId: number | null, patch: Partial<AskPlace>): void {
  if (conversationId === null) return;
  const was = places.get(conversationId) ?? { turns: 0, top: 0, sourcesTop: 0, chosen: null, followUp: "" };
  // the newest last: a Map keeps insertion order, so the first key is the oldest
  places.delete(conversationId);
  places.set(conversationId, { ...was, ...patch });
  while (places.size > VISITED_KEEP) places.delete(places.keys().next().value!);
}

/** The chosen row to come back to, for the palette opening on Ask (cmdk's `defaultValue`): only a source row of the conversation Ask holds. */
export function askChosen(): string | undefined {
  const { conversationId, turns } = useAsk.getState();
  const place = askPlace(conversationId);
  return place?.turns === turns.length && place.chosen?.startsWith("source\u0000") ? place.chosen : undefined;
}

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const errorOf = (error: unknown) => {
  const e = error as { code?: string; message?: string; details?: { aiErrorKind?: AiErrorKind }; i18n?: { key: string; params?: Readonly<Record<string, string | number>> } };
  return { code: e.code, kind: e.details?.aiErrorKind, message: localized(e.message ?? "", e.i18n), key: e.i18n?.key };
};

async function settle(call: Promise<AiAskResult>, requestId: string, question: string): Promise<void> {
  const mine = () => useAsk.getState().running?.requestId === requestId;
  try {
    const r = await call;
    if (!mine()) return;
    // plan 143: something to do, not a question: its own plan, and nothing runs before Apply
    if (r.status === "command") return await settleCommand(requestId, question);
    const turn = r.turn;
    const sources = turn ? await viewsOf(turn.sources).catch(() => ({})) : {};
    if (!mine()) return;
    useAsk.setState((s) => ({
      running: null,
      ready: s.ready + 1,
      conversationId: turn?.conversationId ?? s.conversationId,
      turns: turn ? [...s.turns, turn] : s.turns,
      sources: { ...s.sources, ...sources },
      older: r.older,
      incomplete: r.status === "done" ? r.incomplete : false,
      olderFound: r.status === "done" ? (r.olderFound ?? null) : null,
      olderPartial: r.status === "done" && r.olderPartial === true,
      error: r.status === "failed" ? { question, message: localized(r.error.message, r.error.i18n), kind: r.error.kind, key: r.error.i18n?.key } : null,
      usedAt: Date.now(),
    }));
  } catch (error) {
    if (!mine()) return;
    const e = errorOf(error);
    // plan 162 (after ai162-r03): stopped before a word came, the question stays (in the field, selected) and says so;
    // it was dropped, so Esc while it looked threw the question away
    if (e.code === "CANCELLED" || e.kind === "cancelled") return useAsk.setState({ running: null, notice: { question, text: t("ask.stoppedEarly") } });
    if (e.kind === "not_configured") return useAsk.setState({ running: null, noProvider: true });
    useAsk.setState({ running: null, error: { question, message: e.message, kind: e.kind, key: e.key } });
  }
}

const COMMAND_NOTICE = { refused: "action.refused", noCondition: "action.noCondition", noMatch: "action.noMatch", tooMany: "action.tooMany" } as const;

async function settleCommand(requestId: string, question: string): Promise<void> {
  const mine = () => useAsk.getState().running?.requestId === requestId;
  const r = await client.call("ai.actionStart", { requestId, sentence: question, ...(useAsk.getState().conversationId !== null ? { conversationId: useAsk.getState().conversationId! } : {}), timezone: timezone() });
  if (!mine()) {
    // the page moved on while it looked: nothing keeps it
    if (r.status === "preview") void client.call("ai.actionCancel", { previewId: r.preview.previewId }).catch(() => {});
    return;
  }
  if (r.status !== "preview") return useAsk.setState({ running: null, notice: { question, text: r.status === "noMatch" && r.done ? t("action.noMatchDone", { count: r.done }) : t(COMMAND_NOTICE[r.status]) }, usedAt: Date.now() });
  useAsk.setState({ running: null, usedAt: Date.now() });
  closePalette();
  opened(r, question);
}

const viewsOf = async (sources: readonly AskSourceRef[]): Promise<Record<number, AskSourceView>> => (sources.length ? client.call("ai.askSources", { messageIds: sources.map((s) => s.messageId) }) : {});

/** A question, or a follow-up on the conversation showing. */
export function askQuestion(question: string): void {
  const text = question.trim();
  const s = useAsk.getState();
  if (!text || s.running) return;
  const requestId = globalThis.crypto.randomUUID();
  useAsk.setState({ running: { requestId, question: text, text: "", chunks: [], older: null, searchingOlder: false }, error: null, notice: null, noProvider: false, olderFound: null, olderPartial: false, usedAt: Date.now() });
  void settle(client.call("ai.ask", { requestId, question: text, ...(s.conversationId !== null ? { conversationId: s.conversationId } : {}), timezone: timezone() }), requestId, text);
}

/** §3: only ever on this click. */
export function searchOlder(): void {
  const s = useAsk.getState();
  const turn = s.turns.at(-1);
  if (!turn || s.conversationId === null || s.running) return;
  const requestId = globalThis.crypto.randomUUID();
  useAsk.setState({ running: { requestId, question: turn.question, text: "", chunks: [], older: null, searchingOlder: true }, error: null, olderFound: null, olderPartial: false, usedAt: Date.now() });
  void settle(client.call("ai.askOlder", { requestId, conversationId: s.conversationId, turnId: turn.id, timezone: timezone() }), requestId, turn.question);
}

/** Stop and Esc. */
export function stopAsking(): boolean {
  const { running } = useAsk.getState();
  if (!running) return false;
  void client.call("ai.cancel", { requestId: running.requestId }).catch(() => {});
  return true;
}

export function newQuestion(): void {
  const { running } = useAsk.getState();
  if (running) stopAsking();
  useAsk.setState({ ...EMPTY, usedAt: Date.now() });
}

/** What ⌘⇧K comes back to: the last conversation for 30 minutes, as it is now, then nothing (it's in the history). */
export function returning(now = Date.now()): void {
  const s = useAsk.getState();
  if (s.running) return;
  if (s.conversationId !== null && now - s.usedAt > ASK_RETURN_MS) return newQuestion();
  useAsk.setState({ usedAt: now, noProvider: false });
  if (s.conversationId !== null) void reload(s.conversationId);
}

async function reload(conversationId: number): Promise<void> {
  const gone = useAsk.getState().gone;
  const saved = await client.call("ai.askConversation", { conversationId }).catch(() => undefined);
  const s = useAsk.getState();
  if (saved === undefined || s.conversationId !== conversationId || s.running || s.gone !== gone) return;
  if (saved === null) return useAsk.setState({ ...EMPTY, usedAt: Date.now() });
  useAsk.setState({ turns: saved.turns, sources: saved.sources, older: saved.older });
}

/** Settings moved: what said Ask had nowhere to go asks again. */
export function askConfigChanged(): void {
  if (useAsk.getState().noProvider) useAsk.setState({ noProvider: false });
}

export function installAsk(): void {
  installFocusIntent();
  // another conversation in the reader: the way back to the answer was that one's
  useApp.subscribe((app, prev) => {
    const { returnTo } = useAsk.getState();
    if (!returnTo) return;
    // another conversation, or (List) its page closed: the way back was that visit's
    const left = app.selectedId !== prev.selectedId && app.selectedId !== returnTo.threadId;
    const closed = prev.readerOpen && !app.readerOpen && useAppearance.getState().layout === "list";
    if (left || closed) useAsk.setState({ returnTo: null });
  });

  client.on("aiAsk", ({ requestId, text, older }) => {
    const { running } = useAsk.getState();
    if (running?.requestId !== requestId) return;
    useAsk.setState({ running: { ...running, ...(text ? { text: running.text + text, chunks: [...running.chunks, text] } : {}), ...(older ? { older } : {}) } });
  });

  // another window deleted or cleared it, or its account went
  client.on("aiAskGone", ({ conversationIds }) => {
    const { conversationId } = useAsk.getState();
    useAsk.setState((s) => ({ gone: s.gone + 1 }));
    // everything cleared: what was read goes too (one deleted keeps its marks, bounded, for its Undo)
    if (conversationIds === null) forgetVisited();
    // plan 165: a pinned answer from one that went goes with it, whichever conversation Ask holds
    forgetPinnedAnswer(conversationIds);
    if (conversationIds === null || (conversationId !== null && conversationIds.includes(conversationId))) useAsk.setState({ ...EMPTY, usedAt: 0 });
  });
}

export const atTurnLimit = (s: Pick<AskState, "turns">): boolean => s.turns.length >= ASK_TURNS_MAX;

/** A saved conversation: no request. */
export async function openConversation(conversationId: number, current: () => boolean = () => true): Promise<boolean> {
  const gone = useAsk.getState().gone;
  const saved = await client.call("ai.askConversation", { conversationId });
  // it was read before something went: this copy may be what's gone (plan 165: or what asked for it moved on)
  if (!saved || useAsk.getState().gone !== gone || !current()) return false;
  stopAsking();
  useAsk.setState({ ...EMPTY, conversationId, turns: saved.turns, sources: saved.sources, older: saved.older, usedAt: Date.now() });
  return true;
}

/**
 * What a source is now, from the backend (another window may have moved it, or a merge taken its thread), and whether
 * it may be shown: not when it's gone, nor in Spam or Trash until it's asked for twice. `approved`: where it was when it
 * was last let through (a source shown in Ask), which still counts while it hasn't moved since. Where it is now, or null.
 */
type Shown = Exclude<AskSourceView["state"], "gone">;
export async function sourceThread(source: AskSourceRef, approved?: Shown, current: () => boolean = () => true): Promise<{ threadId: number; state: Shown } | null> {
  const fresh = await client.call("ai.askSources", { messageIds: [source.messageId] }).catch(() => null);
  // an answer for what was left meanwhile (another conversation, the preview closed) changes nothing (Codex review, pass 3, round 2)
  if (!current()) return null;
  if (fresh) useAsk.setState((s) => ({ sources: { ...s.sources, ...fresh } }));
  const s = useAsk.getState();
  const view = s.sources[source.messageId];
  if (view?.state === "gone") return null;
  const state = view?.state ?? "ok";
  if ((state === "spam" || state === "trash") && s.armedSource !== source.messageId && approved !== state) {
    useAsk.setState({ armedSource: source.messageId });
    return null;
  }
  useAsk.setState({ armedSource: null });
  return { threadId: view ? view.threadId : source.threadId, state };
}

/**
 * Open a source in the reader: the palette closes and the thread opens at that message, in the thread it's in now, with
 * Back to the answer. Plan 161, pass 3: a citation and a source row first show the message in Ask (`ask-peek.ts`); its
 * Open message comes here with where the message was when it was shown, checked again (Codex review #3). Plan 165: from
 * the pinned answer (`pinned`), the card is the way back and keeps focus, and the source is that answer's, read.
 */
export async function openSource(source: AskSourceRef, approved?: Shown, current: () => boolean = () => true, pinned?: { conversationId: number }): Promise<void> {
  const at = await sourceThread(source, approved, current);
  if (at === null || !current()) return;
  setApp({ dialog: null });
  // plan 165 (Codex review): Split's reader shows a new message or a selection over the conversation; a source asked to
  // be seen leaves them (the new message saved and put away, as a row's click leaves it)
  const app = getApp();
  if (app.compose) leaveNewDraft();
  if (app.checked.size >= 2 || app.scope !== null) setApp({ checked: new Set(), scope: null });
  openThread(at.threadId);
  revealSummaryMessage(source.messageId);
  markVisited(pinned ? pinned.conversationId : useAsk.getState().conversationId, source.messageId);
  // the card is the way back: a link to an earlier answer, kept on this same conversation, would be another's
  if (pinned) return void useAsk.setState({ returnTo: null });
  useAsk.setState({ returnTo: { threadId: at.threadId, messageId: source.messageId, conversationId: useAsk.getState().conversationId } });
  focusMessage(source.messageId);
}

/**
 * Plan 161: focus goes to the message a source opened, once the reader has drawn it and the palette has gone, while
 * the way back still points at it. Programmatic, so no ring.
 */
export function focusMessage(messageId: number): void {
  focusAfterDialog(() => messageFocusTarget(messageId), () => useAsk.getState().returnTo?.messageId === messageId);
}

/**
 * Back to the answer: Ask, on the conversation the source came from. The link is an explicit return, so it brings that
 * conversation back however long it has been (⌘⇧K's own 30 minutes don't apply); one deleted since opens nothing stale.
 */
export async function backToAnswer(): Promise<void> {
  const { returnTo, conversationId } = useAsk.getState();
  if (getApp().dialog !== null || !returnTo) return;
  if (returnTo.conversationId !== null && conversationId !== returnTo.conversationId && !(await openConversation(returnTo.conversationId))) return useAsk.setState({ returnTo: null });
  useAsk.setState({ usedAt: Date.now() });
  toggleAsk();
}

export async function loadAskHistory(): Promise<AskConversationSummary[]> {
  return client.call("ai.askHistory", {});
}

/** Delete on a row. Its Undo is a row of the page, since a snack's dock sits behind the palette. */
export async function deleteConversation(conversationId: number): Promise<void> {
  await client.call("ai.askDelete", { conversationId });
  forgetPinnedAnswer([conversationId]);
  if (useAsk.getState().conversationId === conversationId) useAsk.setState({ ...EMPTY, usedAt: Date.now() });
}

export const restoreConversation = (conversationId: number): Promise<unknown> => client.call("ai.askRestore", { conversationId });

/** Settings → Storage → Clear AI data: nothing shown is kept either. */
export function forgetAsk(): void {
  forgetVisited();
  forgetPinnedAnswer(null);
  useAsk.setState({ ...EMPTY, usedAt: 0 });
}

export const closePalette = (): void => {
  if (getApp().dialog === "palette") setApp({ dialog: null });
};

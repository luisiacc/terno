import { ASK_TURNS_MAX, type AiAskResult, type AiErrorKind, type AskConversationSummary, type AskOlderOffer, type AskSourceRef, type AskSourceView, type AskTurn } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { localized } from "~/lib/i18n";
import { openThread } from "~/lib/page";
import { revealSummaryMessage } from "~/lib/summaries";
import { getApp, setApp } from "~/state/app";

/**
 * Plan 141: the conversation, in a small store outside the palette: closing it doesn't stop an answer, and ⌘⇧K comes
 * back to it for 30 minutes, caret in the follow-up box, so opening a source and coming back loses nothing.
 */
export const ASK_RETURN_MS = 30 * 60_000;

export interface AskRunning {
  requestId: string;
  question: string;
  text: string;
  /** still looking through older mail on the server */
  older: { done: number; total: number } | null;
  searchingOlder: boolean;
}

export interface AskState {
  conversationId: number | null;
  turns: AskTurn[];
  sources: Record<number, AskSourceView>;
  running: AskRunning | null;
  /** Where the first question to a destination would go: said once, before anything leaves. */
  consent: { question: string; provider: string; endpoint: string | null; destination: string } | null;
  error: { question: string; message: string; kind: AiErrorKind | undefined } | null;
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
  /** just finished: for screen readers */
  ready: number;
  usedAt: number;
}

const EMPTY: Omit<AskState, "usedAt" | "ready" | "gone"> = { conversationId: null, turns: [], sources: {}, running: null, consent: null, error: null, notice: null, noProvider: false, older: { kind: "none" }, incomplete: false, olderFound: null, olderPartial: false, armedSource: null };

export const useAsk = create<AskState>(() => ({ ...EMPTY, ready: 0, usedAt: 0, gone: 0 }));

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

client.on("aiAsk", ({ requestId, text, older }) => {
  const { running } = useAsk.getState();
  if (running?.requestId !== requestId) return;
  useAsk.setState({ running: { ...running, ...(text ? { text: running.text + text } : {}), ...(older ? { older } : {}) } });
});

const errorOf = (error: unknown) => {
  const e = error as { code?: string; message?: string; details?: { aiErrorKind?: AiErrorKind }; i18n?: { key: string; params?: Readonly<Record<string, string | number>> } };
  return { code: e.code, kind: e.details?.aiErrorKind, message: localized(e.message ?? "", e.i18n) };
};

async function settle(call: Promise<AiAskResult>, requestId: string, question: string): Promise<void> {
  const mine = () => useAsk.getState().running?.requestId === requestId;
  try {
    const r = await call;
    if (!mine()) return;
    if (r.status === "consent") return useAsk.setState({ running: null, consent: { question, provider: r.provider, endpoint: r.endpoint, destination: r.destination } });
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
      error: r.status === "failed" ? { question, message: localized(r.error.message, r.error.i18n), kind: r.error.kind } : null,
      usedAt: Date.now(),
    }));
  } catch (error) {
    if (!mine()) return;
    const e = errorOf(error);
    if (e.code === "CANCELLED" || e.kind === "cancelled") return useAsk.setState({ running: null });
    if (e.kind === "not_configured") return useAsk.setState({ running: null, noProvider: true });
    useAsk.setState({ running: null, error: { question, message: e.message, kind: e.kind } });
  }
}

const COMMAND_NOTICE = { refused: "action.refused", noCondition: "action.noCondition", noMatch: "action.noMatch", tooMany: "action.tooMany" } as const;

async function settleCommand(requestId: string, question: string): Promise<void> {
  const mine = () => useAsk.getState().running?.requestId === requestId;
  // before it can say anything: a short walk is over before its answer arrives
  const { opened } = await import("./action-preview");
  const r = await client.call("ai.actionStart", { requestId, sentence: question, ...(useAsk.getState().conversationId !== null ? { conversationId: useAsk.getState().conversationId! } : {}), timezone: timezone() });
  if (!mine()) {
    // the page moved on while it looked: nothing keeps it
    if (r.status === "preview") void client.call("ai.actionCancel", { previewId: r.preview.previewId }).catch(() => {});
    return;
  }
  if (r.status === "consent") return useAsk.setState({ running: null, consent: { question, provider: r.provider, endpoint: r.endpoint, destination: r.destination } });
  if (r.status !== "preview") return useAsk.setState({ running: null, notice: { question, text: t(COMMAND_NOTICE[r.status]) }, usedAt: Date.now() });
  useAsk.setState({ running: null, usedAt: Date.now() });
  closePalette();
  opened(r);
}

const viewsOf = async (sources: readonly AskSourceRef[]): Promise<Record<number, AskSourceView>> => (sources.length ? client.call("ai.askSources", { messageIds: sources.map((s) => s.messageId) }) : {});

/** A question, or a follow-up on the conversation showing. */
export function askQuestion(question: string, o: { acknowledge?: string } = {}): void {
  const text = question.trim();
  const s = useAsk.getState();
  if (!text || s.running) return;
  const requestId = globalThis.crypto.randomUUID();
  useAsk.setState({ running: { requestId, question: text, text: "", older: null, searchingOlder: false }, consent: null, error: null, notice: null, noProvider: false, olderFound: null, olderPartial: false, usedAt: Date.now() });
  void settle(client.call("ai.ask", { requestId, question: text, ...(s.conversationId !== null ? { conversationId: s.conversationId } : {}), timezone: timezone(), ...(o.acknowledge ? { acknowledge: o.acknowledge } : {}) }), requestId, text);
}

/** §3: only ever on this click. */
export function searchOlder(): void {
  const s = useAsk.getState();
  const turn = s.turns.at(-1);
  if (!turn || s.conversationId === null || s.running) return;
  const requestId = globalThis.crypto.randomUUID();
  useAsk.setState({ running: { requestId, question: turn.question, text: "", older: null, searchingOlder: true }, error: null, olderFound: null, olderPartial: false, usedAt: Date.now() });
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

/** Another window deleted or cleared it, or its account went. */
client.on("aiAskGone", ({ conversationIds }) => {
  const { conversationId } = useAsk.getState();
  useAsk.setState((s) => ({ gone: s.gone + 1 }));
  if (conversationIds === null || (conversationId !== null && conversationIds.includes(conversationId))) useAsk.setState({ ...EMPTY, usedAt: 0 });
});

export const atTurnLimit = (s: Pick<AskState, "turns">): boolean => s.turns.length >= ASK_TURNS_MAX;

export function declineConsent(): void {
  useAsk.setState({ consent: null });
}

/** A saved conversation: no request. */
export async function openConversation(conversationId: number): Promise<boolean> {
  const gone = useAsk.getState().gone;
  const saved = await client.call("ai.askConversation", { conversationId });
  // it was read before something went: this copy may be what's gone
  if (!saved || useAsk.getState().gone !== gone) return false;
  stopAsking();
  useAsk.setState({ ...EMPTY, conversationId, turns: saved.turns, sources: saved.sources, older: saved.older, usedAt: Date.now() });
  return true;
}

/**
 * Enter on a source, or its inline number: the palette closes and the thread opens at that message, in the thread it's
 * in now. One now in Spam or Trash needs asking twice; one that's gone doesn't open.
 */
export async function openSource(source: AskSourceRef): Promise<void> {
  // what it is now, not when it was shown: another window may have moved it, or a merge taken its thread
  const fresh = await client.call("ai.askSources", { messageIds: [source.messageId] }).catch(() => null);
  if (fresh) useAsk.setState((s) => ({ sources: { ...s.sources, ...fresh } }));
  const s = useAsk.getState();
  const view = s.sources[source.messageId];
  if (view?.state === "gone") return;
  if ((view?.state === "spam" || view?.state === "trash") && s.armedSource !== source.messageId) return useAsk.setState({ armedSource: source.messageId });
  useAsk.setState({ armedSource: null });
  setApp({ dialog: null });
  openThread(view?.threadId ?? source.threadId);
  revealSummaryMessage(source.messageId);
}

export async function loadAskHistory(): Promise<AskConversationSummary[]> {
  return client.call("ai.askHistory", {});
}

/** Delete on a row. Its Undo is a row of the page, since a snack's dock sits behind the palette. */
export async function deleteConversation(conversationId: number): Promise<void> {
  await client.call("ai.askDelete", { conversationId });
  if (useAsk.getState().conversationId === conversationId) useAsk.setState({ ...EMPTY, usedAt: Date.now() });
}

export const restoreConversation = (conversationId: number): Promise<unknown> => client.call("ai.askRestore", { conversationId });

/** Settings → Storage → Clear AI data: nothing shown is kept either. */
export function forgetAsk(): void {
  useAsk.setState({ ...EMPTY, usedAt: 0 });
}

export const closePalette = (): void => {
  if (getApp().dialog === "palette") setApp({ dialog: null });
};

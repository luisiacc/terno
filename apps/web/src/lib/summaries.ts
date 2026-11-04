import type { AiErrorKind, AiProviderId, AiSummary, ThreadSummary } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { localized } from "~/lib/i18n";

/**
 * Plan 132: what the reader knows of each thread's summary. In a small store outside the reader, so a request survives
 * leaving the thread (the result is there on return) and the toolbar, the palette and the lazy block agree.
 */
export type SummaryUi =
  | { kind: "none" }
  /** there was one, but the conversation changed */
  | { kind: "stale" }
  | { kind: "ready"; summary: AiSummary }
  | { kind: "running"; requestId: string; was: "none" | "stale" }
  | { kind: "waitingBody"; was: "none" | "stale" }
  /** the first text this would send to this cloud provider: said once, in the block */
  | { kind: "consent"; provider: AiProviderId; was: "none" | "stale" }
  /** nothing set up to run summaries: the block points to Settings */
  | { kind: "noProvider"; was: "none" | "stale" }
  | { kind: "error"; message: string; errorKind: AiErrorKind | undefined; was: "none" | "stale" };

interface SummariesState {
  byThread: ReadonlyMap<number, SummaryUi>;
  /** the block's disclosure, the same for every thread */
  open: boolean;
  /** an item's arrow: the conversation expands this message and goes to it */
  reveal: { messageId: number; seq: number } | null;
}

const OPEN_KEY = "terno:summaryOpen";
/** threads remembered: a thread opened again asks again */
const KEPT = 100;

function storedOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) !== "closed";
  } catch {
    return true;
  }
}

export const useSummaries = create<SummariesState>(() => ({ byThread: new Map(), open: storedOpen(), reveal: null }));

function put(threadId: number, ui: SummaryUi): void {
  useSummaries.setState((s) => {
    const byThread = new Map(s.byThread);
    byThread.delete(threadId);
    byThread.set(threadId, ui);
    for (const [id, old] of byThread) {
      if (byThread.size <= KEPT) break;
      if (old.kind !== "running" && id !== threadId) byThread.delete(id);
    }
    return { byThread };
  });
}

const reads = new Map<number, number>();

/** What the backend has for a thread; asked when a thread opens and when its messages change. */
export async function loadSummary(threadId: number): Promise<void> {
  const seq = (reads.get(threadId) ?? 0) + 1;
  reads.set(threadId, seq);
  const current = useSummaries.getState().byThread.get(threadId);
  // what the user is in the middle of stays until they or the request end it
  if (current && current.kind !== "none" && current.kind !== "stale" && current.kind !== "ready") return;
  const read = await client.call("ai.summaries.get", { threadId }).catch(() => null);
  if (!read || reads.get(threadId) !== seq) return;
  const now = useSummaries.getState().byThread.get(threadId);
  if (now && now.kind !== "none" && now.kind !== "stale" && now.kind !== "ready") return;
  put(threadId, read.state === "ready" ? { kind: "ready", summary: read.summary } : { kind: read.state });
}

/** The backend says one is ready: an open reader picks it up. */
export function summaryReady({ threadId }: { threadId: number }): void {
  const current = useSummaries.getState().byThread.get(threadId);
  if (current?.kind === "running") return;
  void loadSummary(threadId);
}

const wasOf = (ui: SummaryUi | undefined): "none" | "stale" => {
  if (!ui || ui.kind === "none") return "none";
  if (ui.kind === "stale" || ui.kind === "ready") return ui.kind === "stale" ? "stale" : "none";
  return ui.was;
};

/** §7: a summary by hand, shown in the block at once. `acknowledge`: the user has just said Continue. */
export async function summarize(threadId: number, o: { acknowledge?: boolean } = {}): Promise<void> {
  const before = useSummaries.getState().byThread.get(threadId);
  if (before?.kind === "running") return;
  if (before?.kind === "ready") return useSummaries.setState({ open: true });
  const was = wasOf(before);
  const requestId = globalThis.crypto.randomUUID();
  put(threadId, { kind: "running", requestId, was });
  const mine = () => {
    const now = useSummaries.getState().byThread.get(threadId);
    return now?.kind === "running" && now.requestId === requestId;
  };
  try {
    const result = await client.call("ai.summarize", { threadId, requestId, ...(o.acknowledge ? { acknowledge: true } : {}) });
    if (!mine()) return;
    if (result.status === "ready") put(threadId, { kind: "ready", summary: result.summary });
    else if (result.status === "consent") put(threadId, { kind: "consent", provider: result.provider, was });
    else put(threadId, { kind: "waitingBody", was });
  } catch (error) {
    if (!mine()) return;
    const e = error as { code?: string; message?: string; details?: { aiErrorKind?: AiErrorKind }; i18n?: { key: string; params?: Readonly<Record<string, string | number>> } };
    const errorKind = e.details?.aiErrorKind;
    if (e.code === "CANCELLED" || errorKind === "cancelled") put(threadId, { kind: was });
    else if (errorKind === "not_configured") put(threadId, { kind: "noProvider", was });
    else put(threadId, { kind: "error", message: localized(e.message ?? "", e.i18n), errorKind, was });
  }
}

/** Stop: the request ends, nothing is written, and the block goes back to what it was. */
export function stopSummary(threadId: number): void {
  const now = useSummaries.getState().byThread.get(threadId);
  if (now?.kind !== "running") return;
  put(threadId, { kind: now.was });
  void client.call("ai.cancel", { requestId: now.requestId }).catch(() => {});
}

/** Back to what it was, nothing sent. */
export function dismissSummary(threadId: number): void {
  const now = useSummaries.getState().byThread.get(threadId);
  if (now && now.kind !== "ready") put(threadId, { kind: wasOf(now) });
}

/** The text that was downloading is here: carry on. */
export function bodyArrivedForSummary(threadId: number): void {
  const now = useSummaries.getState().byThread.get(threadId);
  if (now?.kind !== "waitingBody") return;
  put(threadId, { kind: now.was });
  void summarize(threadId);
}

export function setSummaryOpen(open: boolean): void {
  useSummaries.setState({ open });
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? "open" : "closed");
  } catch {
    /* a private window: it holds for this session */
  }
}

let revealSeq = 0;
export function revealSummaryMessage(messageId: number): void {
  useSummaries.setState({ reveal: { messageId, seq: ++revealSeq } });
}

/** Settings → Storage → Clear AI data: nothing shown is kept either. */
export async function clearSummaries(): Promise<void> {
  await client.call("ai.summaries.clear", {});
  useSummaries.setState({ byThread: new Map() });
}

/** Never offered in spam or trash, nor with one spam message in the thread (plan 132 revision 1). */
export const summarizable = (t: Pick<ThreadSummary, "inSpam" | "inTrash" | "hasSpam"> | undefined): boolean => !!t && !t.inSpam && !t.inTrash && !t.hasSpam;

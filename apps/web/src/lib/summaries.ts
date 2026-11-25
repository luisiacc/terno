import type { AiErrorKind, AiSummary, MessageDetail, ThreadSummary } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { forgetAsk } from "~/lib/ask";
import { localized } from "~/lib/i18n";

/**
 * Plan 132: what the reader knows of each thread's summary. In a small store outside the reader, so a request survives
 * leaving the thread (the result is there on return) and the toolbar, the palette and the block agree.
 */
export type SummaryUi =
  | { kind: "none" }
  /** there was one, but the conversation changed */
  | { kind: "stale" }
  | { kind: "ready"; summary: AiSummary }
  | ({ kind: "running"; requestId: string } & Asked)
  | ({ kind: "waitingBody" } & Asked)
  /** nothing set up to run summaries: the block points to Settings */
  | ({ kind: "noProvider" } & Asked)
  | ({ kind: "error"; message: string; errorKind: AiErrorKind | undefined; key?: string } & Asked);

/**
 * What a request in progress goes back to. Plan 242: `again` is Dev mode's Summarize again: what's stored was shown and
 * is still there, so it comes back, and a retry or the text arriving asks again rather than taking it.
 */
interface Asked {
  was: "none" | "stale";
  again?: true;
}

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

/**
 * Plan 279: where the last run of unread mail began in each conversation's latest showing. What's shown is read after
 * 450 ms (plan 225), before anyone clicks Summarize or a body that was downloading arrives, so a request by hand sends
 * this. The backend's rule: the run after the last message that's yours or read, over what isn't trash or spam, so a
 * reminder left unread further up doesn't take in what was read after it (Codex code review 2, 6). Every drawn copy until
 * the showing ends counts (a cached copy drawn read can come back unread inside the dwell: Codex review 2); the earliest
 * wins. Kept past the showing, so Try again from elsewhere still has it.
 */
/** where the run began, and how many messages the conversation had then: what came after is mail that arrived since */
const shownUnread = new Map<number, { id: number; count: number }>();

type Shown = Pick<MessageDetail, "id" | "isRead" | "isSent" | "isTrash" | "isSpam" | "isDraft">;

export function noteShown(threadId: number, all: readonly Shown[], fresh: boolean): void {
  // drafts aren't the conversation either: a draft synced from elsewhere would end the run (Astra review 9)
  const messages = all.filter((m) => !m.isTrash && !m.isSpam && !m.isDraft);
  let anchor = messages.length - 1;
  while (anchor >= 0 && !messages[anchor]!.isRead && !messages[anchor]!.isSent) anchor--;
  const start = anchor + 1;
  const run = start < messages.length ? { id: messages[start]!.id, count: messages.length } : null;
  const was = shownUnread.get(threadId);
  const at = was ? messages.findIndex((m) => m.id === was.id) : -1;
  if (fresh) {
    // shown again with nothing unread (read in the last showing, back a moment later): the last one holds while nothing
    // has arrived since (Fable review, round 2: 10)
    if (run) shownUnread.set(threadId, run);
    else if (at < 0 || messages.length !== was!.count) shownUnread.delete(threadId);
    return;
  }
  if (!run) return;
  // within a showing an earlier start wins (a cached copy drawn read came back unread), but a run of only mail that
  // arrived during the showing, after what was read in it, starts afresh (Fable review, round 2: 9)
  if (at < 0 || start < at || (start > at && start >= was!.count)) shownUnread.set(threadId, run);
}

const reads = new Map<number, number>();
/** a read already sent answers for what was there then: one that lands after a new summary would put the old one back */
const forgetReads = (threadId: number) => reads.set(threadId, (reads.get(threadId) ?? 0) + 1);

/** What the backend has for a thread; asked when a thread opens and when its messages change. */
export async function loadSummary(threadId: number): Promise<void> {
  const seq = (reads.get(threadId) ?? 0) + 1;
  reads.set(threadId, seq);
  const current = useSummaries.getState().byThread.get(threadId);
  // what the user is in the middle of stays until they or the request end it
  if (current && current.kind !== "none" && current.kind !== "stale" && current.kind !== "ready") return;
  // a read that fails shows nothing, and the next change of the thread asks again
  const read = await (async () => client.call("ai.summaries.get", { threadId }))().catch(() => null);
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

/** A request ends with nothing new: back to what was there; for Summarize again, the stored one, read again. */
function back(threadId: number, asked: Asked): void {
  put(threadId, { kind: asked.was });
  if (asked.again) void loadSummary(threadId);
}

/**
 * §7: a summary by hand, shown in the block at once. Shown already, it opens the block; with `again` (plan 242, Dev
 * mode's: the backend refuses it elsewhere) the model writes it anew.
 */
export async function summarize(threadId: number, o: { again?: boolean } = {}): Promise<void> {
  const before = useSummaries.getState().byThread.get(threadId);
  if (before?.kind === "running") return;
  if (before?.kind === "ready") {
    useSummaries.setState({ open: true });
    if (!o.again) return;
  }
  // an error or a wait from Summarize again stays one, whichever control asks next (Codex review)
  const again = o.again || (!!before && "again" in before && before.again === true);
  const asked: Asked = { was: wasOf(before), ...(again ? { again: true as const } : {}) };
  const requestId = globalThis.crypto.randomUUID();
  forgetReads(threadId);
  put(threadId, { kind: "running", requestId, ...asked });
  const mine = () => {
    const now = useSummaries.getState().byThread.get(threadId);
    return now?.kind === "running" && now.requestId === requestId;
  };
  try {
    const since = shownUnread.get(threadId)?.id;
    const result = await client.call("ai.summarize", { threadId, requestId, ...(asked.again ? { again: true as const } : {}), ...(since !== undefined ? { since } : {}) });
    if (!mine()) return;
    if (result.status === "ready") put(threadId, { kind: "ready", summary: result.summary });
    else put(threadId, { kind: "waitingBody", ...asked });
  } catch (error) {
    if (!mine()) return;
    const e = error as { code?: string; message?: string; details?: { aiErrorKind?: AiErrorKind }; i18n?: { key: string; params?: Readonly<Record<string, string | number>> } };
    const errorKind = e.details?.aiErrorKind;
    if (e.code === "CANCELLED" || errorKind === "cancelled") back(threadId, asked);
    else if (errorKind === "not_configured") put(threadId, { kind: "noProvider", ...asked });
    else put(threadId, { kind: "error", message: localized(e.message ?? "", e.i18n), errorKind, ...asked, ...(e.i18n?.key ? { key: e.i18n.key } : {}) });
  }
}

/** Stop: the request ends, nothing is written, and the block goes back to what it was. */
export function stopSummary(threadId: number): void {
  const now = useSummaries.getState().byThread.get(threadId);
  if (now?.kind !== "running") return;
  back(threadId, now);
  void client.call("ai.cancel", { requestId: now.requestId }).catch(() => {});
}

/** Back to what it was, nothing sent. */
export function dismissSummary(threadId: number): void {
  const now = useSummaries.getState().byThread.get(threadId);
  if (now && "was" in now) back(threadId, now);
}

/** The text that was downloading is here: carry on. */
export function bodyArrivedForSummary(threadId: number): void {
  const now = useSummaries.getState().byThread.get(threadId);
  if (now?.kind !== "waitingBody") return;
  put(threadId, { kind: now.was });
  void summarize(threadId, { again: now.again });
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
  // plan 141: what the palette shows
  forgetAsk();
}

/** Never offered in spam or trash, nor with one spam message in the thread (plan 132 revision 1). */
export const summarizable = (t: Pick<ThreadSummary, "inSpam" | "inTrash" | "hasSpam"> | undefined): boolean => !!t && !t.inSpam && !t.inTrash && !t.hasSpam;

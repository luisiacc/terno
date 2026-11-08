import { WAITING_WINDOW_MS, type PreparedReply, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { repliesOffered } from "~/lib/ai";
import { undoAction } from "~/lib/actions";
import { commitPrepared, preparedHooks } from "~/lib/ai-draft";
import { autoRecipients } from "~/lib/compose-fields";
import { composeHooks, composeLanding } from "~/lib/compose";
import { discardListeners, draftHomeThread, shownDraftKey, useDrafts } from "~/lib/drafts";
import { onExplicitOpen } from "~/lib/open-dwell";
import { readerShown } from "~/lib/page";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { loadThread, useThreads } from "~/state/threads";

/**
 * Plan 144: a reply prepared when a conversation that waits for one is opened. Off, this reads one setting. On, a thread
 * not waiting costs one comparison. All the work begins at an open that stayed; a passing j/k spends nothing.
 */
interface Shown {
  threadId: number;
  phase: "writing" | "ready";
  text: string;
  row: PreparedReply | null;
}

export const useReplies = create<{ shown: Shown | null }>(() => ({ shown: null }));

/** the conversation this window has asked about, and told the backend it's reading */
let reading: number | null = null;
let waitingBody: (() => void) | null = null;
/** they went to write something themselves here: nothing's prepared until the conversation is opened again */
let composedOn: number | null = null;
/** the newest message when what's shown was asked for: another means it's out of date */
let newestShown: number | null = null;
let frame: number | null = null;
let pending: string | null = null;

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const mine = (): string[] => getApp().accounts.map((a) => a.email);
const on = (): boolean => repliesOffered(getApp());

function stopWaitingBody(): void {
  waitingBody?.();
  waitingBody = null;
}

function leave(): void {
  stopWaitingBody();
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  pending = null;
  const id = reading;
  reading = null;
  useReplies.setState({ shown: null });
  if (id !== null) void client.call("ai.replyLeave", { threadId: id }).catch(() => {});
}

const waits = (detail: ThreadDetail): boolean => {
  const since = detail.thread.waitingSince;
  return since !== null && since !== undefined && Date.now() - since <= WAITING_WINDOW_MS;
};

/** a composer open here, blank or not, is someone writing */
const hasDraft = (threadId: number): boolean => shownDraftKey(useDrafts.getState().drafts, threadId, getApp().draftShown) !== null;

async function ask(threadId: number): Promise<void> {
  const detail = await loadThread(threadId);
  if (!detail || getApp().selectedId !== threadId || !readerShown() || composedOn === threadId || !on() || !waits(detail) || detail.thread.inSpam || detail.thread.inTrash || hasDraft(threadId)) return;
  newestShown = detail.messages.at(-1)?.id ?? null;
  const { to, cc } = autoRecipients("reply", detail, mine());
  reading = threadId;
  const r = await client.call("ai.prepareReply", { threadId, accountId: detail.thread.accountId, to, cc, timezone: timezone() }).catch(() => ({ status: "none" as const }));
  if (reading !== threadId) return;
  if (composedOn === threadId) return void client.call("ai.replyLeave", { threadId }).catch(() => {});
  if (r.status === "ready") useReplies.setState({ shown: { threadId, phase: "ready", text: r.row.body ?? "", row: r.row } });
  else if (r.status === "waitingBody") {
    // the reader is fetching it: it goes on when it's here, if this is still what's open
    stopWaitingBody();
    waitingBody = useThreads.subscribe((state) => {
      if (state.details.get(threadId)?.messages.find((m) => m.id === r.messageId)?.bodyState !== "full") return;
      stopWaitingBody();
      if (reading === threadId) void ask(threadId);
    });
  }
}

/** At boot, once there's a connection to listen on. */
export function installReplies(): void {
  onExplicitOpen({
    opened: () => {
      composedOn = null;
      return on() ? true : null;
    },
    settled: (id) => void ask(id),
  });

  // a frame at most: the text comes faster than anything can be read
  client.on("aiReply", (event) => {
    if (event.phase === "cleared") {
      // nothing stays on screen, and anything still on its way is nobody's
      reading = null;
      stopWaitingBody();
      useReplies.setState({ shown: null });
      return;
    }
    if (event.threadId !== reading) return;
    if (event.phase === "writing") {
      pending = event.text;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        if (reading === event.threadId && pending !== null) useReplies.setState({ shown: { threadId: event.threadId, phase: "writing", text: pending, row: null } });
      });
      return;
    }
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
    useReplies.setState({ shown: event.phase === "ready" ? { threadId: event.threadId, phase: "ready", text: event.row.body ?? "", row: event.row } : null });
  });

  useApp.subscribe((s, prev) => {
    if (s.selectedId !== prev.selectedId) composedOn = null;
    if (s.selectedId !== prev.selectedId && reading !== null && s.selectedId !== reading) leave();
    // List's Back or Esc: the conversation isn't on screen any more, though it's still the one selected
    if (reading !== null && s.readerOpen !== prev.readerOpen && !readerShown()) leave();
    // the switch went off: every window stops showing it
    if (repliesOffered(prev) && !repliesOffered(s)) leave();
  });

  // another message came in: what's shown answered the last one. It goes, and it doesn't start another by itself.
  useThreads.subscribe((state) => {
    const { shown } = useReplies.getState();
    if (!shown || newestShown === null) return;
    const newest = state.details.get(shown.threadId)?.messages.at(-1)?.id;
    // the stream too: its next word would bring back what's out of date
    if (newest !== undefined && newest !== newestShown) leave();
  });

  // ⌘J, `r` with nothing ready, a click on the reply pill: they asked for something else
  composeHooks.composing = (threadId) => {
    const { shown } = useReplies.getState();
    composedOn = threadId;
    if (reading !== threadId || shown?.phase === "ready") return;
    useReplies.setState({ shown: null });
    void client.call("ai.replyStop", { threadId, dismiss: false }).catch(() => {});
  };
}

/**
 * Plan 161, pass 2 (Codex review): a draft on a conversation that went any way but Discard (sent, scheduled, Undo Send) is
 * the reply: a prepared one shown there goes, so a draft brought back by Discard's Undo and then sent doesn't leave it.
 */
const discarded = new Set<string>();
discardListeners.add((key) => discarded.add(key));
useDrafts.subscribe((state, previous) => {
  if (state.drafts === previous.drafts) return;
  const { shown } = useReplies.getState();
  for (const [key, d] of Object.entries(previous.drafts)) {
    if (state.drafts[key]) continue;
    const was = discarded.delete(key);
    if (!was && shown && (d.threadId === shown.threadId || draftHomeThread(d) === shown.threadId)) useReplies.setState({ shown: null });
  }
});

export const replyReady = (threadId: number): boolean => {
  const { shown } = useReplies.getState();
  return on() && shown?.threadId === threadId && shown.phase === "ready" && shown.row !== null;
};

/** Use, `r` and `a`: the words go in, one undo step, and no request is made. Nothing can send but the composer's Send. */
export async function useReply(threadId: number, mode: Exclude<Parameters<typeof composeLanding>[0], undefined> = "reply"): Promise<void> {
  const { shown } = useReplies.getState();
  const row = shown?.threadId === threadId ? shown.row : null;
  if (!row) return;
  const detail = await loadThread(threadId);
  if (!detail) return;
  const landing = await composeLanding(mode, threadId);
  if (landing.kind === "none") return;
  const { to, cc } = autoRecipients("reply", detail, mine());
  const used = await client.call("ai.replyAct", { threadId, rowId: row.rowId, revision: row.revision, action: "use", to, cc, timezone: timezone() }).catch(() => null);
  useReplies.setState({ shown: null });
  if (!used) return void snack.error(t("replies.stale"));
  preparedHooks.back = (prepared) => void giveBack(prepared);
  commitPrepared(landing.key, used, landing.kind === "created");
}

/**
 * Undo after Use, or the draft made from it discarded: the block again, only if the row is still what Use left, and only
 * on screen while it still answers the conversation's newest message (any message since, the user's own too, makes it
 * out of date, Codex review): the next open prepares again.
 */
async function giveBack({ threadId, rowId, revision }: { threadId: number; rowId: string; revision: number }): Promise<void> {
  const row = await client.call("ai.replyAct", { threadId, rowId, revision, action: "restore" }).catch(() => null);
  if (!row) return;
  // any message since (theirs or the user's own) and it answers what's no longer the last word, as while it's shown
  const detail = await loadThread(threadId).catch(() => null);
  const newest = detail?.messages.at(-1)?.id;
  if (newest !== undefined && row.answeringMessageId && newest !== row.answeringMessageId) return;
  if (getApp().selectedId === threadId) {
    reading = threadId;
    composedOn = null;
    useReplies.setState({ shown: { threadId, phase: "ready", text: row.body ?? "", row } });
  }
}

export async function dismissReply(threadId: number): Promise<void> {
  const row = useReplies.getState().shown?.row;
  if (!row) return;
  const dismissed = await client.call("ai.replyAct", { threadId, rowId: row.rowId, revision: row.revision, action: "dismiss" }).catch(() => null);
  useReplies.setState({ shown: null });
  if (!dismissed) return;
  const undo = registerUndo(async () => {
    const back = await client.call("ai.replyAct", { threadId, rowId: dismissed.rowId, revision: dismissed.revision, action: "undismiss" });
    if (back && getApp().selectedId === threadId) useReplies.setState({ shown: { threadId, phase: "ready", text: back.body ?? "", row: back } });
  });
  snack.success(t("replies.dismissed"), { action: undoAction(undo, t("replies.dismissUndo")) });
}

/** Stop while it writes: nothing's kept, and it doesn't come back at this state. */
export function stopReply(threadId: number): void {
  useReplies.setState({ shown: null });
  void client.call("ai.replyStop", { threadId, dismiss: true }).catch(() => {});
}

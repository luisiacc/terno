import { WAITING_WINDOW_MS, type PreparedReply, type ThreadDetail } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { autoRecipients } from "~/lib/compose-fields";
import { composeHooks, composeLanding } from "~/lib/compose";
import { draftIndex, useDrafts } from "~/lib/drafts";
import { onExplicitOpen } from "~/lib/open-dwell";
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

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const mine = (): string[] => getApp().accounts.map((a) => a.email);
const on = (): boolean => getApp().settings?.replies?.enabled === true;

function stopWaitingBody(): void {
  waitingBody?.();
  waitingBody = null;
}

function leave(): void {
  stopWaitingBody();
  const id = reading;
  reading = null;
  useReplies.setState({ shown: null });
  if (id !== null) void client.call("ai.replyLeave", { threadId: id }).catch(() => {});
}

const waits = (detail: ThreadDetail): boolean => {
  const since = detail.thread.waitingSince;
  return since !== null && since !== undefined && Date.now() - since <= WAITING_WINDOW_MS;
};

const hasDraft = (threadId: number): boolean => draftIndex(useDrafts.getState().drafts).written.has(threadId);

async function ask(threadId: number): Promise<void> {
  const detail = await loadThread(threadId);
  if (!detail || getApp().selectedId !== threadId || !on() || !waits(detail) || detail.thread.inSpam || detail.thread.inTrash || hasDraft(threadId)) return;
  const { to, cc } = autoRecipients("reply", detail, mine());
  reading = threadId;
  const r = await client.call("ai.prepareReply", { threadId, accountId: detail.thread.accountId, to, cc, timezone: timezone() }).catch(() => ({ status: "none" as const }));
  if (reading !== threadId) return;
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

onExplicitOpen({
  opened: () => (on() ? true : null),
  settled: (id) => void ask(id),
});

// a frame at most: the text comes faster than anything can be read
let frame: number | null = null;
let pending: string | null = null;
client.on("aiReply", (event) => {
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
  if (s.selectedId !== prev.selectedId && reading !== null && s.selectedId !== reading) leave();
  // the switch went off: every window stops showing it
  if (prev.settings?.replies?.enabled && !s.settings?.replies?.enabled) leave();
});

// ⌘J, `r` with nothing ready, a click on the reply pill: they asked for something else
composeHooks.composing = (threadId) => {
  const { shown } = useReplies.getState();
  if (reading !== threadId || shown?.phase === "ready") return;
  useReplies.setState({ shown: null });
  void client.call("ai.replyStop", { threadId, dismiss: false }).catch(() => {});
};

export const replyReady = (threadId: number): boolean => {
  const { shown } = useReplies.getState();
  return shown?.threadId === threadId && shown.phase === "ready" && shown.row !== null;
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
  const used = await client.call("ai.replyAct", { threadId, revision: row.revision, action: "use", to, cc, timezone: timezone() }).catch(() => null);
  useReplies.setState({ shown: null });
  if (!used) return void snack.error(t("replies.stale"));
  const { commitPrepared, preparedHooks } = await import("./ai-draft");
  preparedHooks.back = (prepared) => void giveBack(prepared.threadId, used.revision);
  commitPrepared(landing.key, used, landing.kind === "created");
}

/** Undo after Use: the block again, only if the row is still what Use left. */
async function giveBack(threadId: number, revision: number): Promise<void> {
  const row = await client.call("ai.replyAct", { threadId, revision, action: "restore" }).catch(() => null);
  if (row && getApp().selectedId === threadId) {
    reading = threadId;
    useReplies.setState({ shown: { threadId, phase: "ready", text: row.body ?? "", row } });
  }
}

export async function dismissReply(threadId: number): Promise<void> {
  const row = useReplies.getState().shown?.row;
  if (!row) return;
  const dismissed = await client.call("ai.replyAct", { threadId, revision: row.revision, action: "dismiss" }).catch(() => null);
  useReplies.setState({ shown: null });
  if (!dismissed) return;
  const undo = registerUndo(async () => {
    const back = await client.call("ai.replyAct", { threadId, revision: dismissed.revision, action: "undismiss" });
    if (back && getApp().selectedId === threadId) useReplies.setState({ shown: { threadId, phase: "ready", text: back.body ?? "", row: back } });
  });
  const { undoAction } = await import("./actions");
  snack.success(t("replies.dismissed"), { action: undoAction(undo, t("replies.dismissUndo")) });
}

/** Stop while it writes: nothing's kept, and it doesn't come back at this state. */
export function stopReply(threadId: number): void {
  useReplies.setState({ shown: null });
  void client.call("ai.replyStop", { threadId, dismiss: true }).catch(() => {});
}

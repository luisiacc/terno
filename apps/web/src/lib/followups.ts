import { followupDaysSince, mostUrgent, type FollowupRow } from "@terno/core";
import type { FollowupsSnapshot } from "@terno/core";
import { t } from "@terno/i18n";
import { onExplicitOpen } from "~/lib/open-dwell";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, inPlainInbox } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { inboxTop, reloadList, useList } from "~/state/list";

/**
 * Plan 142: what the windows know of follow-ups (the backend's snapshot, at startup and on its `followups` event), and
 * what the UI does with them. One line of the row and the thread's, in words of the app's language.
 */
export function applyFollowups(snapshot: FollowupsSnapshot): void {
  const before = useFollowups.getState();
  const byThread = new Map<number, FollowupRow[]>();
  for (const r of snapshot.rows) byThread.set(r.threadId, [...(byThread.get(r.threadId) ?? []), r]);
  const onTop = new Set(snapshot.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId)).size;
  const due = new Set(snapshot.rows.filter((r) => r.state === "due").map((r) => r.threadId)).size;
  useFollowups.setState({ rows: snapshot.rows, byThread, due, onTop, loaded: true });
  const s = getApp();
  if (!before.loaded && useList.getState().itemsKey === "") return;
  const key = (rows: readonly FollowupRow[]) => JSON.stringify(rows.map((r) => [r.id, r.state, r.inboxState, r.dueAt]));
  // the Inbox's top is what's on it; the Follow-ups list is all of them
  const changed = s.followups ? key(before.rows) !== key(snapshot.rows) : inPlainInbox(s) && JSON.stringify(before.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId)) !== JSON.stringify(snapshot.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId));
  if (changed) void reloadList({ keepSelection: true });
}

export async function loadFollowups(): Promise<void> {
  applyFollowups(await client.call("followups.list", {}));
}

const on = () => getApp().settings?.followups.enabled === true;

export const anyFollowupOnTop = (): boolean => on() && useFollowups.getState().onTop > 0;

/** "You told Tom you'd send the contract", "Ana hasn't replied in 5 days". */
export function followupLine(row: FollowupRow, now = Date.now()): string {
  const name = row.personName || row.personEmail?.split("@")[0] || null;
  if (row.kind === "awaiting") return t("followup.awaiting", { name: name ?? t("followup.someone"), count: followupDaysSince(row.sentAt, now) });
  return name ? t("followup.promise", { name, text: row.text }) : t("followup.promiseNoName", { text: row.text });
}

/** What a row says: its most urgent, and how many more. */
export function rowLine(rows: readonly FollowupRow[] | undefined, now = Date.now()): string | null {
  if (!rows?.length || !on()) return null;
  const line = followupLine(mostUrgent(rows)!, now);
  return rows.length > 1 ? `${line} +${rows.length - 1}` : line;
}

/** Done, Dismiss and Later, each with Undo that puts the exact row back. */
export async function actOnFollowup(row: FollowupRow, action: "done" | "dismiss" | "later", dueAt?: number): Promise<void> {
  try {
    const { undoId } = await client.call("followups.act", { id: row.id, revision: row.revision, action, ...(dueAt !== undefined ? { dueAt } : {}) });
    const undo = undoId === null ? null : registerUndo(() => client.call("followups.undo", { undoId }).then(() => undefined));
    snack.success(t(action === "done" ? "followup.snack.done" : action === "dismiss" ? "followup.snack.dismissed" : "followup.snack.later"), undo ? { action: { label: t("common.undo"), name: t("followup.undo"), undo } } : {});
  } catch (error) {
    const e = error as { message?: string };
    snack.error(e.message ?? t("followup.actFailed"));
  }
}

/** Opening ends the Inbox row, not the follow-up, once it stayed on screen. */
onExplicitOpen({
  opened: (id) => (useFollowups.getState().byThread.get(id)?.some((r) => r.inboxState === "onTop") ? true : null),
  settled: (id) => void client.call("followups.seen", { threadId: id }).catch(() => {}),
});

/** The selection left a thread the Inbox's top held only because it was open: it goes to its place. */
export const leftTop = (threadId: number): boolean => inboxTop.ids.includes(threadId) && !useFollowups.getState().byThread.get(threadId)?.some((r) => r.inboxState === "onTop");

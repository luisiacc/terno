import { dayEnd, dayKeyOf, followupDaysSince, mostUrgent, type FollowupRow } from "@terno/core";
import type { FollowupsSnapshot } from "@terno/core";
import { t } from "@terno/i18n";
import { followupsOffered } from "~/lib/ai";
import type { LeftRows } from "~/lib/actions";
import { promiseWhen, taskSaid } from "~/lib/dated";
import { onExplicitOpen } from "~/lib/open-dwell";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, inPlainInbox, navigate, useApp } from "~/state/app";
import { useFollowups } from "~/state/followups";
import { inboxTop, reloadList, useList } from "~/state/list";
import { reminderDated } from "~/lib/when";

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
  // a promise's Later (plan 204, the fifth panel round) moves its place in the list, not its moment
  const key = (rows: readonly FollowupRow[]) => JSON.stringify(rows.map((r) => [r.id, r.state, r.inboxState, r.dueAt, r.deferredUntil]));
  // the Inbox's top is what's on it; the Follow-ups list is all of them
  const changed = s.followups ? key(before.rows) !== key(snapshot.rows) : inPlainInbox(s) && JSON.stringify(before.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId)) !== JSON.stringify(snapshot.rows.filter((r) => r.inboxState === "onTop").map((r) => r.threadId));
  if (changed) void reloadList({ keepSelection: true });
}

export async function loadFollowups(): Promise<void> {
  applyFollowups(await client.call("followups.list", {}));
}

const on = () => followupsOffered(getApp());

export const anyFollowupOnTop = (): boolean => on() && useFollowups.getState().onTop > 0;

const personOf = (row: FollowupRow): string | null => row.personName || row.personEmail?.split("@")[0] || null;

/** "You told Tom you'd send the contract", "Ana hasn't replied in 5 days", and "yet" until a whole day has passed (plan 161). */
export function followupLine(row: FollowupRow, now = Date.now()): string {
  const name = personOf(row);
  if (row.kind === "awaiting") {
    const who = name ?? t("followup.someone");
    const days = followupDaysSince(row.sentAt, now);
    return days === 0 ? t("followup.awaitingYet", { name: who }) : t("followup.awaiting", { name: who, count: days });
  }
  return name ? t("followup.promise", { name, text: row.text }) : t("followup.promiseNoName", { text: row.text });
}

/**
 * Plan 161: when the line comes back, never a bare weekday. Pass 3: under the fact (the title), so it says what happens and
 * on what: "Comes back to your Inbox Wed, Oct 28, 9:00 AM if there's no reply", or that it's due. The fourth panel round
 * (revision 10): a promise of yours says its day as Today does ("Due Tuesday", "Was due yesterday"), never the moment it's
 * placed at (a "9:00 AM" no one said); one that named no day says none (null).
 */
export function followupWhen(row: FollowupRow, now = Date.now()): string | null {
  if (row.kind === "promise") return row.dated ? promiseWhen(row, now >= dayEnd(dayKeyOf(row.dueAt)), now) : null;
  const date = reminderDated(row.dueAt, now);
  if (row.state === "due") return t("followup.dueNow", { date });
  return t("followup.dueOnAwaiting", { date });
}

/** What a row says: its most urgent, and how many more. */
export function rowLine(rows: readonly FollowupRow[] | undefined, now = Date.now()): string | null {
  if (!rows?.length || !on()) return null;
  const line = followupLine(mostUrgent(rows)!, now);
  return rows.length > 1 ? `${line} +${rows.length - 1}` : line;
}

/**
 * Done, Dismiss and Later, each with Undo that puts the exact row back. A promise's snack names it as Today's do ("Done:
 * send the contract", the fourth panel round); a nudge's keeps its own words.
 */
export async function actOnFollowup(row: FollowupRow, action: "done" | "dismiss" | "later", dueAt?: number, left?: LeftRows): Promise<void> {
  const text = row.kind === "promise" ? row.text : null;
  try {
    const { undoId } = await client.call("followups.act", { id: row.id, revision: row.revision, action, ...(dueAt !== undefined ? { dueAt } : {}) });
    // plan 210 (iteration 2): What matters' rows it took out come back with its Undo
    const run = () => client.call("followups.undo", { undoId: undoId! }).then(() => undefined);
    const undo = undoId === null ? null : registerUndo(() => (left ? left.undo(run) : run()));
    const said = text !== null ? taskSaid(action, text) : action === "done" ? t("followup.snack.done") : action === "dismiss" ? t("followup.snack.dismissed") : t("followup.snack.later", { date: reminderDated(dueAt ?? row.dueAt) });
    snack.success(said, undo ? { action: { label: t("common.undo"), name: t("followup.undo"), undo } } : {});
  } catch (error) {
    left?.failed();
    const e = error as { message?: string };
    snack.error(e.message ?? t("followup.actFailed"));
  }
}

/** Opening ends the Inbox row, not the follow-up, once it stayed on screen. What's hidden (plan 147) isn't seen: it stays for when it shows again. */
onExplicitOpen({
  opened: (id) => (on() && useFollowups.getState().byThread.get(id)?.some((r) => r.inboxState === "onTop") ? true : null),
  settled: (id) => void client.call("followups.seen", { threadId: id }).catch(() => {}),
});

/** Plan 142 §8: off hides the row, the list and the lines at once, here and in every window; on brings them back. */
useApp.subscribe((s, prev) => {
  if (!prev.settings) return;
  const now = followupsOffered(s);
  if (followupsOffered(prev) === now) return;
  if (!now && s.followups) navigate({ view: "inbox" });
  else if (inPlainInbox(s)) void reloadList({ keepSelection: true });
});

/** The selection left a thread the Inbox's top held only because it was open: it goes to its place. */
export const leftTop = (threadId: number): boolean => inboxTop.ids.includes(threadId) && !useFollowups.getState().byThread.get(threadId)?.some((r) => r.inboxState === "onTop");

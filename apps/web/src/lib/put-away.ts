import { orderReasons, placementLive, type Category, type Folder, type Placement, type PlacementDetail, type Reason, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { dayDate, weekdayName } from "~/lib/format";
import { reasonText } from "~/lib/reasons";
import { leaveList, undoAction } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import type { TopSections } from "~/lib/row-offsets";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { usePutAway } from "~/state/put-away";
import { invalidateThreads, loadThread } from "~/state/threads";

/**
 * Plan 282: Put away in the app. What a placement says (a row's short line here, the reader box's sentence in
 * put-away-box.tsx, both from `whyOf`), the view's sections, and its one-step fixes, each acting on the placement the
 * window showed (its `at`): one put away again since, or moved, is left as it is now.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The names a placement's words need, as the app has them now (the caller reads them reactively) */
export interface PlacementNames {
  categories: readonly Pick<Category, "id" | "name">[];
  folders: readonly Pick<Folder, "key" | "path">[];
}

/** A category's name ("" when it's gone) */
export const categoryName = (names: PlacementNames, id: number | null | undefined): string => (id == null ? "" : (names.categories.find((c) => c.id === id)?.name ?? ""));

/** A folder's shown name (its last part), or its key when the app doesn't list it */
export const folderName = (names: PlacementNames, key: string | undefined): string => (key ? (names.folders.find((f) => f.key === key)?.path.at(-1) ?? key) : "");

/** Who Terno's filing was about: the sender the decision read (a placement from before the field: the newest mail's) */
export const senderOf = (d: Extract<PlacementDetail, { by: "terno" }>): string => d.senderName || d.fromName || d.sender;

/**
 * Terno's reasons, the strongest first: who the user keeps there (by sender, list or domain, with how many), else the
 * other reasons in words. The row says the lead short, the box says it whole and the rest after it.
 */
export function whyOf(reasons: readonly Reason[]): { identity: { k: "sameSender" | "sameList" | "sameDomain"; count: number; domain: string } | null; words: string[] } {
  const { lead, rest } = orderReasons(reasons);
  if (lead && typeof lead !== "string" && (lead.k === "reason.sameSender" || lead.k === "reason.sameList" || lead.k === "reason.sameDomain")) {
    const k = lead.k.slice("reason.".length) as "sameSender" | "sameList" | "sameDomain";
    return { identity: { k, count: Number(lead.p?.count ?? 0), domain: String(lead.p?.domain ?? "") }, words: rest.map(reasonText) };
  }
  return { identity: null, words: [lead, ...rest].filter((r) => r !== null).map(reasonText) };
}

/** What a row says in its preview's place: who put it away, and why (Needs a look adds that you've written to them). */
export function rowLine(p: Placement, names: PlacementNames): string {
  const d = p.detail;
  let line: string;
  if (d.by === "terno") {
    // who did it, in a few words: the why is the box's (a row hasn't the room for it)
    line = t("putAway.row.terno", { category: categoryName(names, d.categoryId) });
  } else {
    const values = { name: d.name, category: categoryName(names, d.categoryId), folder: folderName(names, d.folder), date: dayDate(d.createdAt) };
    line = d.auto ? t(`putAway.row.auto.${d.action}`, values) : t(`putAway.row.rule.${d.action}`, values);
  }
  return p.needsLook ? `${line} · ${t("putAway.row.wrote")}` : line;
}

/** Still in the window at `now`: a reader's cached detail can't keep a box past it */
export const stillPutAway = (at: number, now = Date.now()): boolean => placementLive(at, now);

/** The day a placement's section is under: Today, Yesterday, then the weekday (the window is a week). */
export function dayLabel(at: number, now = Date.now()): string {
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(at) === day(now)) return t("putAway.section.today");
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day(at) === y.toDateString()) return t("putAway.section.yesterday");
  return weekdayName(at);
}

/** A Put away row's section, as its description says it */
export function sectionOf(p: Placement, now = Date.now()): string {
  return p.needsLook ? t("putAway.section.needsLook") : dayLabel(p.at, now);
}

/**
 * The view's sections over the rows on screen (they come Needs a look first, then newest: the store's order): one heading
 * where Needs a look starts and at each new day after it. No count: what's loaded isn't the whole of a busy day.
 */
export function putAwaySections(rows: readonly Pick<ThreadSummary, "id">[], byThread: ReadonlyMap<number, Placement>, now = Date.now()): TopSections {
  const headings: { kind: "needsLook" | "day"; at: number; label: string; count: null }[] = [];
  let last: string | null = null;
  rows.forEach((row, i) => {
    const p = byThread.get(row.id);
    if (!p) return;
    const label = sectionOf(p, now);
    if (label === last) return;
    headings.push({ kind: p.needsLook ? "needsLook" : "day", at: i, label, count: null });
    last = label;
  });
  return { top: 0, pinned: 0, headings };
}

/** What changed under these conversations: the reader and the list read them again */
function refresh(threadIds: readonly number[]): void {
  invalidateThreads(threadIds);
  const selected = getApp().selectedId;
  if (selected !== null && threadIds.includes(selected)) void loadThread(selected, true);
  void reloadList({ keepSelection: true });
}

/** Back to Inbox: whatever keeps them out goes (as the window showed them), with one exact Undo. */
export async function backToInbox(items: readonly { threadId: number; at: number }[]): Promise<void> {
  const ids = items.map((i) => i.threadId);
  if (getApp().putAway) leaveList("moveToInbox", ids, { quiet: true });
  try {
    const r = await client.call("putAway.back", { items: [...items] });
    refresh(ids);
    if (r.affected === 0) return;
    const undo = registerUndo(async () => {
      if (r.undoId !== null) await client.call("threads.undo", { undoId: r.undoId });
      refresh(ids);
    });
    snack.success(t("putAway.back.done", { count: r.affected }), { action: r.undoId !== null ? undoAction(undo, t("putAway.back.undo", { count: r.affected })) : undefined });
  } catch (error) {
    snack.error(t("putAway.back.failed", { error: errorText(error) }));
    refresh(ids);
  }
}

/** The placements behind these conversations, as the window shows them (Back to Inbox acts on those) */
export function placedItems(threadIds: readonly number[]): { threadId: number; at: number }[] {
  const byThread = usePutAway.getState().byThread;
  return threadIds.flatMap((id) => {
    const p = byThread.get(id);
    return p ? [{ threadId: id, at: p.at }] : [];
  });
}

/**
 * "Not {category}" on Terno's own filing: out of the category, and Terno learns (as the chip's ×). Its Undo files it back
 * the way the user files mail, so the conversation is where it was and Terno counts it as belonging there.
 */
export async function notCategory(threadId: number, categoryId: number, category: string): Promise<void> {
  if (getApp().putAway) leaveList("moveToInbox", [threadId], { quiet: true });
  try {
    await client.call("categories.removeThreads", { categoryId, threadIds: [threadId], reason: "user" });
    refresh([threadId]);
    const undo = registerUndo(async () => {
      await client.call("categories.addThreads", { categoryId, threadIds: [threadId], source: "snackbar" });
      refresh([threadId]);
    });
    snack.success(t("putAway.not.done", { category }), { action: undoAction(undo, t("putAway.not.undo", { category })) });
  } catch (error) {
    snack.error(t("category.removeFailed", { error: errorText(error) }));
    refresh([threadId]);
  }
}

/** "Don't file {sender} automatically": this conversation back in the Inbox, Terno asks about the sender's next ones. */
export async function keepSenderOut(threadId: number, at: number, sender: string, category: string): Promise<void> {
  try {
    const { undoId } = await client.call("putAway.keep", { threadId, at });
    refresh([threadId]);
    const undo = registerUndo(async () => {
      await client.call("putAway.keepUndo", { undoId });
      refresh([threadId]);
    });
    snack.success(t("putAway.keep.done", { sender, category }), { action: undoAction(undo, t("putAway.keep.undo", { sender })) });
  } catch (error) {
    snack.error(t("putAway.keep.failed", { error: errorText(error) }));
    refresh([threadId]);
  }
}

/** Stop this rule (only while it's as it was when it did this), with Undo. */
export async function stopRule(threadId: number, at: number, name: string): Promise<void> {
  try {
    const { filterUndo } = await client.call("putAway.stopRule", { threadId, at });
    refresh([threadId]);
    // off already (another window did it): said as it is
    if (filterUndo === null) return void snack(t("putAway.stop.already", { name }));
    const undo = registerUndo(() => client.call("similar.undo", { undoId: null, filterUndo }).then(() => refresh([threadId])));
    snack.success(t("putAway.stop.done", { name }), { action: undoAction(undo, t("putAway.stop.undo", { name })) });
  } catch (error) {
    snack.error(t("filters.stop.failed", { error: errorText(error) }));
    refresh([threadId]);
  }
}

/** Edit rule: the rule that did this, open in the Rules builder; deleted since, it says so (and the box reads it again) */
export async function editRule(threadId: number, filterId: number): Promise<void> {
  try {
    const f = (await client.call("filters.list", {})).find((x) => x.id === filterId);
    if (f) return setApp({ filterPrefill: { id: f.id, name: f.name, rule: f.rule, enabled: f.enabled, source: f.source, auto: f.auto }, dialog: "filters" });
    snack(t("putAway.rule.gone"));
    refresh([threadId]);
  } catch {
    setApp({ dialog: "filters" });
  }
}

/** The newest mark this window acknowledged: an answer counted before it is stale */
let acknowledged = 0;
let asked = 0;

/** The Inbox's line: asked when the Inbox shows, when something is put away (or seen in another window), after a reconnect. */
export async function refreshNotice(): Promise<void> {
  const mine = ++asked;
  try {
    const notice = await client.call("putAway.needsLook", {});
    // a newer question answers instead, and an answer from before this window's acknowledgment shows nothing
    if (mine !== asked) return;
    usePutAway.setState({ notice: notice.through <= acknowledged ? { ...notice, count: 0, first: null } : notice });
  } catch {
    // the line waits for the next change
  }
}

/** The line was dismissed, or Put away opened: what it counts now is seen (asked fresh, so nothing put away since is missed) */
export async function seeNotice(): Promise<void> {
  asked++;
  usePutAway.setState((s) => ({ notice: s.notice ? { ...s.notice, count: 0, first: null } : null }));
  try {
    const notice = await client.call("putAway.needsLook", {});
    acknowledged = Math.max(acknowledged, notice.through);
    usePutAway.setState({ notice: { ...notice, count: 0, first: null } });
    if (notice.count > 0) await client.call("putAway.seen", { through: notice.through });
  } catch {
    // seen next time
  }
}

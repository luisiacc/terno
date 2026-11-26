import { orderReasons, placementCategory, PUT_AWAY_MS, type Placement, type PlacementDetail, type Reason, type ThreadSummary } from "@terno/core";
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
 * Plan 282: Put away in the app. What a placement says (a row's short line, the reader box's sentence is in
 * put-away-box.tsx), the view's sections, and its one-step fixes.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The name of a placement's category as the app has it now ("" when it's gone) */
export function categoryName(id: number | null): string {
  return id === null ? "" : (getApp().categories.find((c) => c.id === id)?.name ?? "");
}

/** A folder's shown name (its last part), or its key when the app doesn't list it */
export function folderName(key: string | undefined): string {
  if (!key) return "";
  return getApp().folders.find((f) => f.key === key)?.path.at(-1) ?? key;
}

/** Terno's reason in a few words, for a row ("you keep 12 from Rappi there") */
export function shortWhy(reasons: readonly Reason[], fromName: string): string {
  const { lead } = orderReasons(reasons);
  if (lead && typeof lead !== "string") {
    const count = Number(lead.p?.count ?? 0);
    if (lead.k === "reason.sameSender") return t("putAway.short.sameSender", { count, sender: fromName });
    if (lead.k === "reason.sameList") return t("putAway.short.sameList", { count });
    if (lead.k === "reason.sameDomain") return t("putAway.short.sameDomain", { count, domain: String(lead.p?.domain ?? "") });
    return reasonText(lead);
  }
  return lead ? reasonText(lead) : t("putAway.short.like");
}

/** What a row says in its preview's place: who put it away, and why (Needs a look adds who you've written to). */
export function rowLine(p: Placement): string {
  const d = p.detail;
  const line = d.by === "terno" ? t("putAway.row.terno", { category: categoryName(d.categoryId), why: shortWhy(d.reasons, d.fromName) }) : ruleLine(d);
  return p.needsLook ? `${line} · ${t("putAway.row.wrote")}` : line;
}

function ruleLine(d: Extract<PlacementDetail, { by: "rule" }>): string {
  const values = { name: d.name, category: categoryName(d.categoryId ?? null), folder: folderName(d.folder), date: dayDate(d.createdAt) };
  return d.auto ? t(`putAway.row.auto.${d.action}`, values) : t(`putAway.row.rule.${d.action}`, values);
}

/** The category whose dot leads a row's line (a filing's), or null */
export function rowCategory(p: Placement): number | null {
  return placementCategory(p.detail);
}

/** Inside the window at `now`: a reader's cached detail can't keep a box past it */
export function stillPutAway(at: number, now = Date.now()): boolean {
  return at > now - PUT_AWAY_MS;
}

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
 * The view's sections over the rows on screen (they come Needs a look first, then newest: the store's order): one
 * heading where Needs a look starts and at each new day after it, each with its count.
 */
export function putAwaySections(rows: readonly Pick<ThreadSummary, "id">[], byThread: ReadonlyMap<number, Placement>, now = Date.now()): TopSections {
  const headings: { kind: "needsLook" | "day"; at: number; label: string; count: number }[] = [];
  let last: string | null = null;
  rows.forEach((row, i) => {
    const p = byThread.get(row.id);
    if (!p) return;
    const label = sectionOf(p, now);
    const kind = p.needsLook ? ("needsLook" as const) : ("day" as const);
    if (label !== last || headings.length === 0) {
      headings.push({ kind, at: i, label, count: 0 });
      last = label;
    }
    headings[headings.length - 1]!.count++;
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

/** Back to Inbox: whatever keeps them out goes, with one exact Undo. */
export async function backToInbox(threadIds: readonly number[]): Promise<void> {
  if (getApp().putAway) leaveList("moveToInbox", threadIds, { quiet: true });
  try {
    const r = await client.call("putAway.back", { threadIds: [...threadIds] });
    refresh(threadIds);
    const undo = registerUndo(async () => {
      if (r.undoId !== null) await client.call("threads.undo", { undoId: r.undoId });
      refresh(threadIds);
    });
    snack.success(t("putAway.back.done", { count: r.affected || threadIds.length }), { action: r.undoId !== null ? undoAction(undo, t("putAway.action.back")) : undefined });
  } catch (error) {
    snack.error(t("putAway.failed", { error: errorText(error) }));
    refresh(threadIds);
  }
}

/** "Don't file {sender} automatically": this conversation back in the Inbox, Terno asks about the sender's next ones. */
export async function keepSenderOut(threadId: number, sender: string, categoryId: number): Promise<void> {
  try {
    const { undoId } = await client.call("putAway.keep", { threadId });
    refresh([threadId]);
    const category = categoryName(categoryId);
    const undo = registerUndo(async () => {
      await client.call("putAway.keepUndo", { undoId });
      refresh([threadId]);
    });
    snack.success(t("putAway.keep.done", { sender, category }), { action: undoAction(undo, t("putAway.keep.undo", { sender })) });
  } catch (error) {
    snack.error(t("putAway.failed", { error: errorText(error) }));
    refresh([threadId]);
  }
}

/** Stop this rule (only while it's as it was when it did this), with Undo. */
export async function stopRule(threadId: number, name: string): Promise<void> {
  try {
    const { filterUndo } = await client.call("putAway.stopRule", { threadId });
    refresh([threadId]);
    const undo = filterUndo === null ? null : registerUndo(() => client.call("similar.undo", { undoId: null, filterUndo }).then(() => refresh([threadId])));
    snack.success(t("putAway.stop.done", { name }), { action: undo ? undoAction(undo, t("putAway.stop.undo", { name })) : undefined });
  } catch (error) {
    snack.error(t("putAway.failed", { error: errorText(error) }));
    refresh([threadId]);
  }
}

/** Edit rule: Settings → Rules, where every rule is */
export function editRule(): void {
  setApp({ dialog: "filters" });
}

/** The Inbox's line: asked when the counts change (new mail) and when a placement ends. */
export async function refreshNotice(): Promise<void> {
  try {
    usePutAway.setState({ notice: await client.call("putAway.needsLook", {}) });
  } catch {
    // the line waits for the next change
  }
}

/** The line was dismissed, or Put away opened: what it counted is seen */
export async function seeNotice(): Promise<void> {
  try {
    const notice = usePutAway.getState().notice ?? (await client.call("putAway.needsLook", {}));
    usePutAway.setState({ notice: { ...notice, count: 0, first: null } });
    if (notice.count > 0) await client.call("putAway.seen", { through: notice.through });
  } catch {
    // seen next time
  }
}

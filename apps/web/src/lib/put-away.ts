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
import { markReturned, usePutAway } from "~/state/put-away";
import { invalidateThreads, loadThread, useThreads } from "~/state/threads";

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
  // who did it, whole: Needs a look's heading says why it needs one (the UI rating: leading with it cut off the cause)
  return line;
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
  const headings: { kind: "needsLook" | "day"; at: number; label: string; hint?: string; count: null }[] = [];
  let last: string | null = null;
  rows.forEach((row, i) => {
    const p = byThread.get(row.id);
    if (!p) return;
    const label = sectionOf(p, now);
    if (label === last) return;
    headings.push(p.needsLook ? { kind: "needsLook", at: i, label, hint: t("putAway.section.needsLookHint"), count: null } : { kind: "day", at: i, label, count: null });
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

/** putAway.back's bound: more go in turns, under one Undo */
const BACK_MAX = 500;

/** Back to Inbox: whatever keeps them out goes (as the window showed them), with one exact Undo. */
export async function backToInbox(items: readonly { threadId: number; at: number }[]): Promise<void> {
  if (items.length === 0) return;
  const ids = items.map((i) => i.threadId);
  // as any action on a selection: what it acted on stops being checked (the rows stay, saying so)
  if (getApp().putAway) leaveList("moveToInbox", ids);
  const undoIds: number[] = [];
  let affected = 0;
  let failed: unknown = null;
  try {
    for (let i = 0; i < items.length; i += BACK_MAX) {
      const r = await client.call("putAway.back", { items: items.slice(i, i + BACK_MAX) });
      affected += r.affected;
      if (r.undoId !== null) undoIds.push(r.undoId);
      // said as each turn lands, so a refresh between turns keeps them (only what it brought back: one moved meanwhile isn't)
      if (getApp().putAway) markReturned(r.threadIds, t("putAway.row.back"));
    }
  } catch (error) {
    failed = error;
  }
  refresh(ids);
  // what went back before a failure still comes back with Undo
  const undo = undoIds.length
    ? registerUndo(async () => {
        for (const undoId of [...undoIds].reverse()) await client.call("threads.undo", { undoId });
        refresh(ids);
      })
    : null;
  if (failed) return void snack.error(t("putAway.back.failed", { error: errorText(failed) }), { action: undo ? undoAction(undo, t("putAway.back.undo", { count: affected })) : undefined });
  if (affected === 0) return;
  snack.success(t("putAway.back.done", { count: affected }), { action: undo ? undoAction(undo, t("putAway.back.undo", { count: affected })) : undefined });
}

/** The placements behind these conversations, as the window shows them (Back to Inbox acts on those) */
export function placedItems(threadIds: readonly number[]): { threadId: number; at: number }[] {
  const { byThread, returned } = usePutAway.getState();
  return threadIds.flatMap((id) => {
    // a row brought back keeps its old placement only to stay under its section: nothing to act on
    const p = returned.has(id) ? undefined : byThread.get(id);
    return p ? [{ threadId: id, at: p.at }] : [];
  });
}

/**
 * Where focus goes when a fix takes away the control it was on: `within`'s first button, else the list (never the toolbar,
 * whose first control archives: Enter would undo the fix), else the reader (List's page, where the list is under it). The
 * reader reads the conversation again after the fix answers, so the control may go a few frames later: watched for a
 * second, and left alone once the user puts focus anywhere else.
 */
export function keepFocusThrough(run: () => Promise<void>, within: () => HTMLElement | null = () => null): void {
  const from = document.activeElement;
  void run().then(() => {
    const until = performance.now() + 1000;
    const check = () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected;
      if (!lost) {
        if (now === from && performance.now() < until) requestAnimationFrame(check);
        return;
      }
      const box = within();
      const list = document.querySelector<HTMLElement>("[role=listbox]");
      const next = (box?.isConnected ? box.querySelector<HTMLElement>("button") : null) ?? (list && !list.closest("[inert]") ? list : null) ?? document.querySelector<HTMLElement>("[data-testid=reader]");
      next?.focus({ preventScroll: true });
    };
    check();
  });
}

/**
 * "Not {category}" on Terno's own filing, as the window showed it (`at`): out of the category, and Terno learns (as the
 * chip's ×), journaled whole, so its Undo puts back exactly what was (Terno's filing, its decision, its examples).
 */
export async function notCategory(threadId: number, at: number, category: string): Promise<void> {
  if (getApp().putAway) leaveList("moveToInbox", [threadId], { quiet: true });
  try {
    const { batchId, inInbox } = await client.call("putAway.not", { threadId, at });
    if (getApp().putAway) markReturned([threadId], inInbox ? t("putAway.row.back") : t("putAway.row.out", { category }), inInbox);
    refresh([threadId]);
    const undo = batchId === null ? null : registerUndo(async () => {
      await client.call("categorize.undo", { batchId });
      refresh([threadId]);
    });
    // still kept out by something else (another hidden category): said as it is
    snack.success(t(inInbox ? "putAway.not.done" : "putAway.not.doneOut", { category }), { action: undo ? undoAction(undo, t("putAway.not.undo", { category })) : undefined });
  } catch (error) {
    snack.error(t("category.removeFailed", { error: errorText(error) }));
    refresh([threadId]);
  }
}

/** "Don't file {sender} automatically": this conversation back in the Inbox, Terno asks about the sender's next ones. */
export async function keepSenderOut(threadId: number, at: number, sender: string, category: string): Promise<void> {
  try {
    const { undoId, inInbox } = await client.call("putAway.keep", { threadId, at });
    if (getApp().putAway) markReturned([threadId], inInbox ? t("putAway.row.back") : t("putAway.row.out", { category }), inInbox);
    refresh([threadId]);
    const undo = registerUndo(async () => {
      await client.call("putAway.keepUndo", { undoId });
      refresh([threadId]);
    });
    snack.success(t(inInbox ? "putAway.keep.done" : "putAway.keep.doneOut", { sender, category }), { action: undoAction(undo, t("putAway.keep.undo", { sender })) });
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

/** Stop's second step: everything a rule that's off now still keeps put away, back in the Inbox (one Undo) */
export async function bringBackRule(threadId: number, at: number): Promise<void> {
  try {
    const { items } = await client.call("putAway.byRule", { threadId, at });
    if (items.length) return backToInbox(items);
    refresh([threadId]);
  } catch (error) {
    snack.error(t("putAway.back.failed", { error: errorText(error) }));
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

/**
 * Something Put away says changed (a rule turned off in Rules, in this window or another, or mail put away): the open
 * conversation's box reads again, and Put away's rows with it
 */
export function putAwayNews(): void {
  // every conversation read whose box speaks of a rule (one opened again later reads afresh), the open one now
  const stale = [...useThreads.getState().details].flatMap(([id, d]) => (d.putAway?.detail.by === "rule" ? [id] : []));
  if (stale.length) invalidateThreads(stale);
  const id = getApp().selectedId;
  if (id !== null && stale.includes(id)) void loadThread(id, true);
  if (getApp().putAway) void reloadList({ keepSelection: true });
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

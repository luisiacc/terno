import { breadcrumb, captureUi } from "~/lib/diag";
import { isCategoryAction, parseAddressList, TAB_ACTION, TAB_CODE, type SimilarAction, type ThreadAction, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { reflowRemoval } from "~/lib/flash";
import { client } from "~/rpc/connection";
import { currentTargets, scopeRows } from "~/lib/select";
import { dismissSnack, registerUndo, snack, withdrawSnack, type Undo } from "~/lib/snack";
import { activeFilter } from "~/lib/unread-filter";
import type { ListFilter } from "@terno/core";
import { getApp, inPlainInbox, inSeparateTab, setApp, type AppState, type ScopeSelection } from "~/state/app";
import { listKey, onlyOnTop, patchRows, reloadList, useList } from "~/state/list";
import { invalidateThreads, useThreads } from "~/state/threads";
import { closePage, currentPage, listLayout } from "~/lib/page";
import { placeActions } from "~/lib/places";
import { showSimilarSnackbar } from "~/components/similar-snackbar";

/** Does a thread still belong in the current list after an action? */
function staysInView(s: Pick<AppState, "view" | "gmailTab" | "categoryId" | "reviewCategoryId" | "folder" | "query">, action: ThreadAction): boolean {
  // plan 86: a Gmail tab holds its own category only; the Inbox none of the tabs (Move to Inbox takes a thread out of them)
  if (isCategoryAction(action)) return s.gmailTab ? action === TAB_ACTION[s.gmailTab] : !(inPlainInbox(s) && (action === "toPromotions" || action === "toSocial"));
  if (action === "moveToInbox" && s.gmailTab) return false;
  const view = s.view;
  switch (action) {
    case "archive":
      return view === "all" || view === "archive" || view === "sent" || view === "starred";
    case "trash":
      return view === "trash";
    case "spam":
      return view === "spam";
    case "notSpam":
      return view !== "spam";
    case "moveToInbox":
      return view !== "trash" && view !== "spam" && view !== "archive";
    case "unstar":
      return view !== "starred";
    default:
      return true;
  }
}

/** What a snack says after an action (several threads: "· N conversations"). */
const DONE = {
  archive: "actions.done.archive",
  trash: "actions.done.trash",
  spam: "actions.done.spam",
  notSpam: "actions.done.inbox",
  moveToInbox: "actions.done.inbox",
  markRead: "actions.done.markRead",
  markUnread: "actions.done.markUnread",
  star: "actions.done.star",
  unstar: "actions.done.unstar",
  toPrimary: "actions.done.inbox",
  toPromotions: "actions.done.promotions",
  toSocial: "actions.done.social",
  // undo's own (never asked for by the UI)
  toUpdates: "actions.done.inbox",
  toForums: "actions.done.inbox",
  toNoCategory: "actions.done.inbox",
} as const satisfies Record<ThreadAction, string>;
/** In progress, for a scope action's snack ("Archiving 1,234 conversations"). */
const DOING = {
  archive: "actions.doing.archive",
  trash: "actions.doing.trash",
  spam: "actions.doing.spam",
  notSpam: "actions.doing.inbox",
  moveToInbox: "actions.doing.inbox",
  markRead: "actions.doing.markRead",
  markUnread: "actions.doing.markUnread",
  star: "actions.doing.star",
  unstar: "actions.doing.unstar",
  toPrimary: "actions.doing.inbox",
  toPromotions: "actions.doing.promotions",
  toSocial: "actions.doing.social",
  toUpdates: "actions.doing.inbox",
  toForums: "actions.doing.inbox",
  toNoCategory: "actions.doing.inbox",
} as const satisfies Record<ThreadAction, string>;
/** What its Undo takes back, for a screen reader ("Undo archive"). */
const UNDO_NAME = {
  archive: "actions.undo.archive",
  trash: "actions.undo.trash",
  spam: "actions.undo.spam",
  notSpam: "actions.undo.inbox",
  moveToInbox: "actions.undo.inbox",
  markRead: "actions.undo.markRead",
  markUnread: "actions.undo.markUnread",
  star: "actions.undo.star",
  unstar: "actions.undo.unstar",
  toPrimary: "actions.undo.inbox",
  toPromotions: "actions.undo.promotions",
  toSocial: "actions.undo.social",
  toUpdates: "actions.undo.inbox",
  toForums: "actions.undo.inbox",
  toNoCategory: "actions.undo.inbox",
} as const satisfies Record<ThreadAction, string>;
/** One thread's undo snack only for these (reads and stars show in the row itself); several threads always get one. */
const SNACK_ALWAYS = new Set<ThreadAction>(["archive", "trash", "spam", "notSpam", "moveToInbox", "toPrimary", "toPromotions", "toSocial"]);

/** z / ⌘Z (the dock's store keeps it: one undo, run once by z or by a snack's Undo). */
export { undoLast } from "~/lib/snack";

/** A snack's Undo for an undo token. */
export const undoAction = (undo: Undo, name: string) => ({ label: t("common.undo"), name, undo });

/** The snack after an action: "Archived", or "Archived · 3 conversations" for several. */
export function said(action: ThreadAction, n: number): string {
  return n > 1 ? t("actions.doneCount", { action: t(DONE[action]), count: n }) : t(DONE[action]);
}

const failed = (error: unknown) => t("actions.failed", { error: error instanceof Error ? error.message : String(error) });

/** The optimistic row for an action that keeps it in the view. */
export function patched(t: ThreadSummary, action: ThreadAction): ThreadSummary {
  switch (action) {
    case "markRead":
      return { ...t, unread: false };
    case "markUnread":
      return { ...t, unread: true };
    case "star":
      return { ...t, starred: true };
    case "unstar":
      return { ...t, starred: false };
    // plan 64: a row a search keeps says where it went, as the stores will (db/actions.ts): trash keeps the
    // messages' spam flag and spam their trash flag (a thread in Trash stays there, and Trash wins over Spam)
    case "archive":
      return { ...t, inInbox: false };
    case "spam":
      return t.inTrash ? { ...t, hasSpam: true } : { ...t, inSpam: true, inInbox: false, hasSpam: true };
    case "trash":
      return { ...t, inTrash: true, inSpam: false, inInbox: false };
    case "notSpam":
      // still no sender icon until the backend's row says it isn't spam (plan 22)
      return { ...t, inSpam: false, hasSpam: false, inInbox: t.inTrash ? t.inInbox : true, spamHeld: t.inSpam || t.hasSpam || t.spamHeld || undefined };
    case "moveToInbox":
      // plan 86: out of Gmail's tabs too
      return { ...t, inSpam: false, inTrash: false, hasSpam: false, inInbox: true, tab: 0, spamHeld: t.inSpam || t.hasSpam || t.spamHeld || undefined };
    // plan 86: the tab it's in now (the stores decide for a thread with several senders)
    case "toPrimary":
      return { ...t, tab: 0 };
    case "toPromotions":
      return { ...t, tab: TAB_CODE.promotions };
    case "toSocial":
      return { ...t, tab: TAB_CODE.social };
    default:
      return t;
  }
}

/** Does the action make its threads stop matching the list's filter (read under Unread, unstarred under Starred)? */
function unmatches(action: ThreadAction, filter: ListFilter | undefined): boolean {
  return (filter === "unread" && action === "markRead") || (filter === "starred" && action === "unstar");
}

function listFilterOfScope(scope: { filter?: ListFilter; unreadOnly?: boolean }): ListFilter | undefined {
  return scope.filter ?? (scope.unreadOnly ? "unread" : undefined);
}

/** On List's page, these are done with the conversation even where its row stays (a search keeps results in place): back to the list. */
const DONE_READING = new Set<ThreadAction>(["archive", "trash", "spam", "markUnread"]);

/**
 * Applies a triage action optimistically: the list updates in the same frame,
 * selection advances to the next thread, and the backend persists + syncs.
 * Without explicit ids it acts on the selection: a "select all N" scope, the
 * checked rows, or the open thread.
 */
export async function act(action: ThreadAction, ids?: number[], options: { quiet?: boolean; automation?: "none" } = {}): Promise<void> {
  if (!ids) {
    const target = currentTargets();
    if ("scope" in target) return actScope(action, target.scope);
    ids = target.ids;
  }
  // plan 64: a search's rows can span places: a place action takes the rows it fits, read now (buttons, menu and keys alike)
  const targets = fitting(action, ids);
  if (targets.length === 0) return;
  breadcrumb("action", "action.thread", { action, count: targets.length });
  const before = selectionBefore();
  leaveList(action, targets, options);
  before.left = getApp().selectedId;
  // z right after the key: this action is the last one already, its undo waits for the backend's answer
  const connection = client.connectionVersion;
  const undoIds = deferred<number[]>();
  const undo = options.quiet ? null : registerUndo(() => undoIds.promise.then((ids) => (ids.length ? undoActions(ids, targets.length, () => restoreSelection(before)) : undefined)));
  try {
    // the contract takes ≤ 5,000 ids a call (the backend slices each); each call can be undone exactly
    const ids: number[] = [];
    for (let i = 0; i < targets.length; i += 5000) {
      const r = await client.call("threads.act", { threadIds: targets.slice(i, i + 5000), action });
      if (r.undoId !== null) ids.push(r.undoId);
      if (connection !== client.connectionVersion) { undoIds.resolve(ids); return; }
    }
    undoIds.resolve(ids);
    invalidateThreads(targets);
    // the read-after-dwell: nothing to announce or to undo
    if (options.quiet) return;
    // undone with z before the answer came: nothing to say
    if (!undo || undo.state !== "ready") return;
    if (SNACK_ALWAYS.has(action) || targets.length > 1) {
      const id = snack(said(action, targets.length), { action: ids.length ? undoAction(undo, t(UNDO_NAME[action])) : undefined });
      // plan 63: the same snack offers the rest from this sender, subject, domain or list
      if (ids.length && SIMILAR.has(action) && targets.length <= 200) void offerSimilar(id, action as SimilarAction, targets, undo, options.automation);
    }
  } catch (error) {
    undoIds.resolve([]);
    if (connection !== client.connectionVersion) return;
    captureUi(error, { code: "action.failed", fields: { action, count: targets.length } });
    snack.error(failed(error));
    void reloadList({ keepSelection: true });
  }
}

const SIMILAR = new Set<ThreadAction>(["archive", "trash", "spam"]);

const FITS = { archive: "archive", trash: "trash", spam: "spam", notSpam: "notSpam", moveToInbox: "toInbox" } as const;

/** In a search, the rows a place action fits (Restore the trashed ones…); elsewhere, all of them (the view's own rule). */
function fitting(action: ThreadAction, ids: number[]): number[] {
  const kind = FITS[action as keyof typeof FITS];
  if (!kind || !getApp().query.trim()) return ids;
  const places = placeActions(targetRows(ids), tabbedTest());
  return places ? places[kind] : ids;
}

/** What was selected before an action, and the open row the action left behind. */
interface SelectionBefore {
  key: string;
  checked: AppState["checked"];
  scope: ScopeSelection | null;
  selectedId: number | null;
  anchorId: number | null;
  left: number | null;
}

const selectionBefore = (): SelectionBefore => {
  const s = getApp();
  return { key: listKey(), checked: s.checked, scope: s.scope, selectedId: s.selectedId, anchorId: s.anchorId, left: s.selectedId };
};

/**
 * Undo puts the selection back so a cleanup can resume: what was checked, the row that was open, where a range grows
 * from, and the keyboard in the list. Not over what the user has chosen since (another list, a new selection, another
 * row: the next action would hit the old batch), and focus only from where nothing is being typed. After the rows are
 * back: a reload drops checks on rows it doesn't hold.
 */
function restoreSelection(before: SelectionBefore): void {
  const s = getApp();
  if (listKey() !== before.key) return;
  if (s.checked.size === 0 && s.scope === null && s.selectedId === before.left) setApp({ checked: before.checked, scope: before.scope, selectedId: before.selectedId, anchorId: before.anchorId });
  if (document.activeElement?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
  document.querySelector<HTMLElement>("[data-testid=thread-list] [data-keep-scroll=list]")?.focus({ preventScroll: true });
}

/** Plan 86: a row in a Gmail tab its account keeps apart (Move to Inbox fits it). */
export const tabbedTest = () => {
  const accounts = getApp().accounts;
  return (r: Partial<Pick<ThreadSummary, "accountId" | "tab">>) => inSeparateTab(r, accounts);
};

/** The similar snackbar comes with its offers: the plain snack grows into it, or stays as it is. */
async function offerSimilar(snackId: string, action: SimilarAction, targets: readonly number[], undo: Undo, automation?: "none"): Promise<void> {
  try {
    const offers = await client.call("offers.forAction", { threadIds: [...targets], action });
    showSimilarSnackbar(snackId, { action, undoName: t(UNDO_NAME[action]), targets, offers, undo, automation });
  } catch {
    // the plain snack already says what happened
  }
}

/**
 * The optimistic side of an action on these threads: the list updates in the
 * same frame (rows that leave the view go, a filter's open row stays), the
 * cursor moves to the next thread, List's page closes when done reading, and
 * what the user acted on stops being selected.
 */
export function leaveList(action: ThreadAction, targets: readonly number[], options: { quiet?: boolean } = {}): void {
  const s = getApp();
  const { items, index } = useList.getState();
  // in a filtered list a row that stops matching leaves (a search too), except the open one: it stays put until the selection moves
  const reading = unmatches(action, activeFilter(s));
  const leaving = reading || (s.query ? false : !staysInView(s, action));
  const stays = reading ? s.selectedId : null;
  // List's conversation page (plan 24): an action that takes the open thread away, or marks it unread, is done reading it
  const backToList = s.selectedId !== null && targets.includes(s.selectedId) && ((leaving && s.selectedId !== stays) || DONE_READING.has(action)) && listLayout() && currentPage() === "thread";

  // back on the list first (focus with it), then the cursor moves: the page closes even when no thread is left to move to
  if (backToList) closePage({ focus: true });
  if (leaving && !reading && s.selectedId !== null && targets.includes(s.selectedId)) {
    // Superhuman-style: move to the next thread that isn't being removed
    const start = index.get(s.selectedId) ?? 0;
    const removed = new Set(targets);
    const next = items.slice(start + 1).find((t) => !removed.has(t.id)) ?? items.slice(0, start).reverse().find((t) => !removed.has(t.id));
    setApp({ selectedId: next?.id ?? null });
  }
  if (leaving) reflowRemoval(targets.filter((id) => id !== stays));
  patchRows(targets, (t): ThreadSummary | null => (leaving && t.id !== stays ? null : patched(t, action)));

  // what the user acted on stops being selected; automatic and undo actions never touch the selection
  const onTargets = !options.quiet && targets.some((id) => s.checked.has(id));
  if (onTargets && (s.checked.size || s.scope)) setApp({ checked: new Set(), scope: null });
}

export function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let job = 0;
/** Progress of a backend job in a loading snack ("Archiving… 1,234 / 5,678"); its result takes the same id. */
export function trackJob(title: string): { jobId: string; snackId: string; stop(): void } {
  const jobId = `job-${Date.now()}-${++job}`;
  const snackId = snack.loading(t("actions.job", { title }), { id: jobId });
  const off = client.on("bulkProgress", (p) => {
    if (p.jobId === jobId && p.done < p.total) snack.progress(snackId, t("actions.jobProgress", { title, done: p.done, total: p.total }));
  });
  return { jobId, snackId, stop: off };
}

/**
 * "Select all N" + an action: the loaded rows change at once, the backend
 * applies it to the whole scope in slices with a progress snack, and one
 * Undo takes back exactly what changed.
 */
async function actScope(action: ThreadAction, sel: ScopeSelection): Promise<void> {
  const connection = client.connectionVersion;
  const s = getApp();
  const before = selectionBefore();
  // the scope's loaded rows: with the unread filter, not a read row it kept (the open one)
  const loaded = scopeRows(useList.getState().items, sel.scope).map((t) => t.id);
  const reading = unmatches(action, listFilterOfScope(sel.scope));
  const leaving = reading || (sel.scope.kind === "search" ? false : !staysInView(s, action));
  // the open thread stays open when it isn't leaving: kept outside the scope, or read in place (the filter keeps it)
  const stays = s.selectedId !== null && (reading || !loaded.includes(s.selectedId)) ? s.selectedId : null;
  if (leaving) {
    reflowRemoval(loaded.filter((id) => id !== stays));
    if (stays === null) setApp({ selectedId: null });
  }
  patchRows(loaded, (t) => (leaving && t.id !== stays ? null : patched(t, action)));
  setApp({ checked: new Set(), scope: null });
  before.left = getApp().selectedId;
  const progress = trackJob(t(DOING[action], { count: sel.count }));
  const undoId = deferred<{ id: number | null; n: number }>();
  const undo = registerUndo(() => undoId.promise.then((u) => (u.id === null ? undefined : undoActions([u.id], u.n, () => restoreSelection(before)))));
  try {
    const r = await client.call("threads.actScope", { scope: sel.scope, action, jobId: progress.jobId });
    undoId.resolve({ id: r.undoId, n: r.affected });
    if (connection !== client.connectionVersion) return;
    invalidateThreads(loaded);
    const offer = r.undoId !== null && undo.state === "ready";
    snack.success(said(action, r.affected), { id: progress.snackId, duration: 8000, action: offer ? undoAction(undo, t(UNDO_NAME[action])) : undefined });
  } catch (error) {
    undoId.resolve({ id: null, n: 0 });
    if (connection !== client.connectionVersion) return;
    snack.error(failed(error), { id: progress.snackId });
  } finally {
    progress.stop();
    if (connection === client.connectionVersion) void reloadList({ keepSelection: true });
    else withdrawSnack(progress.snackId);
  }
}

/**
 * Plan 106: an account's Mark All as Read: every unread thread in its Inbox as its sidebar count counts them
 * (not the categories hidden from the Inbox, not the Gmail tabs it keeps apart), applied by the backend in
 * slices with one Undo. Not an action on the selection: what's checked stays checked. The rows shown change at
 * once only where the list is an Inbox that holds them (Codex R1: elsewhere a loaded row's membership is
 * unknown); every list reloads after.
 */
export async function markAccountRead(accountId: number, count: number): Promise<void> {
  const connection = client.connectionVersion;
  const s = getApp();
  // the rows shown are the Inbox's, not a previous view's still showing while it loads (Codex code review round 2 #3)
  const listed = inPlainInbox(s) && !s.reminders && !s.followups && !s.today && (s.accountId === null || s.accountId === accountId) && useList.getState().itemsKey === listKey();
  // a row there only for its reminder, or in a Gmail tab the account keeps apart, isn't in its Inbox (Codex code review #4)
  const loaded = listed ? useList.getState().items.filter((t) => t.accountId === accountId && t.unread && !onlyOnTop(t) && !inSeparateTab(t, s.accounts)).map((t) => t.id) : [];
  // under the list's Unread filter they go; the open and the checked ones are read in place, as the filter keeps
  // them (Codex code review #2: the selection isn't what this acts on, so it stays)
  const leaving = activeFilter(s) === "unread";
  const stays = (id: number) => id === s.selectedId || s.checked.has(id);
  if (leaving) reflowRemoval(loaded.filter((id) => !stays(id)));
  patchRows(loaded, (t) => (leaving && !stays(t.id) ? null : patched(t, "markRead")));
  breadcrumb("action", "action.thread", { action: "markRead", count });
  const progress = trackJob(t(DOING.markRead, { count }));
  const undoId = deferred<{ id: number | null; n: number }>();
  const undo = registerUndo(() => undoId.promise.then((u) => (u.id === null ? undefined : undoActions([u.id], u.n))));
  try {
    const r = await client.call("threads.actScope", { scope: { kind: "view", view: "inbox", accountId, filter: "unread" }, action: "markRead", jobId: progress.jobId });
    undoId.resolve({ id: r.undoId, n: r.affected });
    if (connection !== client.connectionVersion) return;
    invalidateThreads(loaded);
    const offer = r.undoId !== null && undo.state === "ready";
    snack.success(said("markRead", r.affected), { id: progress.snackId, duration: 8000, action: offer ? undoAction(undo, t(UNDO_NAME.markRead)) : undefined });
  } catch (error) {
    undoId.resolve({ id: null, n: 0 });
    if (connection !== client.connectionVersion) return;
    snack.error(failed(error), { id: progress.snackId });
  } finally {
    progress.stop();
    if (connection === client.connectionVersion) void reloadList({ keepSelection: true });
    else withdrawSnack(progress.snackId);
  }
}

/**
 * Undo: the backend puts back each message the action changed, exactly
 * as it was (read, star, place). Large ones show their progress. `restored`
 * runs once the list holds those rows again.
 */
export async function undoActions(undoIds: readonly number[], n: number, restored?: () => void): Promise<void> {
  const progress = n > 200 ? trackJob(t("actions.undoing", { count: n })) : null;
  let undone = false;
  try {
    let back = 0;
    for (const undoId of undoIds) back += (await client.call("threads.undo", { undoId, jobId: progress?.jobId })).restored;
    undone = true;
    if (progress) snack.success(t("actions.undone", { count: back }), { id: progress.snackId, duration: 4000 });
  } catch (error) {
    // the undo token says so, with a retry (z points back at it too)
    if (progress) dismissSnack(progress.snackId);
    throw error;
  } finally {
    progress?.stop();
    void reloadList({ keepSelection: true }).then(() => {
      if (undone) restored?.();
    });
  }
}

/** The rows an action would apply to now, loaded (a scope's are its loaded rows). */
export function targetRows(ids?: readonly number[]): ThreadSummary[] {
  const { items, index } = useList.getState();
  const target = ids ? { ids } : currentTargets();
  if ("scope" in target) return scopeRows(items, target.scope.scope);
  return target.ids.flatMap((id) => {
    // a conversation the list doesn't hold (List's reload on one, a draft's): what the reader shows of it
    const row = items[index.get(id) ?? -1] ?? useThreads.getState().details.get(id)?.thread;
    return row ? [row] : [];
  });
}

/** s / ⌘⇧L: stars the targets unless every one already is. */
export function toggleStar(ids?: number[]): void {
  const rows = targetRows(ids);
  void act(rows.length && rows.every((t) => t.starred) ? "unstar" : "star", ids);
}

/** ⌘⇧U: marks the targets read when any is unread, else unread. */
export function toggleRead(ids?: number[]): void {
  void act(targetRows(ids).some((t) => t.unread) ? "markRead" : "markUnread", ids);
}

let readTimer: ReturnType<typeof setTimeout> | null = null;
/** The reader went away (the bulk bar replaced it): nothing was read. */
export function cancelMarkRead(): void {
  if (readTimer) clearTimeout(readTimer);
  readTimer = null;
}

/** Opening a thread marks it read after a short dwell, so holding j doesn't mark everything read. */
export function scheduleMarkRead(id: number): void {
  if (id === 0) return;
  if (readTimer) clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const st = useList.getState();
    const row = st.items[st.index.get(id) ?? -1] ?? useThreads.getState().details.get(id)?.thread;
    if (row?.unread && getApp().selectedId === id) void act("markRead", [id], { quiet: true });
  }, 450);
}

// ───────────────────────────── compose ─────────────────────────────

// Structured formatting/parsing (quoted display names) so a crafted sender name can't add recipients.
export const parseAddresses = parseAddressList;
export { openCompose, sendDraft } from "./compose";

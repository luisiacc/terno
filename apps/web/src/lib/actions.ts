import { breadcrumb, captureUi } from "~/lib/diag";
import { parseAddressList, type ThreadAction, type ThreadSummary, type View } from "@terno/core";
import { t } from "@terno/i18n";
import { reflowRemoval } from "~/lib/flash";
import { client } from "~/rpc/connection";
import { currentTargets, scopeRows } from "~/lib/select";
import { dismissSnack, registerUndo, snack, type Undo } from "~/lib/snack";
import { activeFilter } from "~/lib/unread-filter";
import type { ListFilter } from "@terno/core";
import { getApp, setApp, type ScopeSelection } from "~/state/app";
import { patchRows, reloadList, useList } from "~/state/list";
import { invalidateThreads } from "~/state/threads";

/** Does a thread still belong in the current view after an action? */
function staysInView(view: View, action: ThreadAction): boolean {
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
} as const satisfies Record<ThreadAction, string>;
/** One thread's undo snack only for these (reads and stars show in the row itself); several threads always get one. */
const SNACK_ALWAYS = new Set<ThreadAction>(["archive", "trash", "spam", "notSpam", "moveToInbox"]);

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
function patched(t: ThreadSummary, action: ThreadAction): ThreadSummary {
  switch (action) {
    case "markRead":
      return { ...t, unread: false };
    case "markUnread":
      return { ...t, unread: true };
    case "star":
      return { ...t, starred: true };
    case "unstar":
      return { ...t, starred: false };
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

/**
 * Applies a triage action optimistically: the list updates in the same frame,
 * selection advances to the next thread, and the backend persists + syncs.
 * Without explicit ids it acts on the selection: a "select all N" scope, the
 * checked rows, or the open thread.
 */
export async function act(action: ThreadAction, ids?: number[], options: { quiet?: boolean } = {}): Promise<void> {
  if (!ids) {
    const target = currentTargets();
    if ("scope" in target) return actScope(action, target.scope);
    ids = target.ids;
  }
  const targets = ids;
  const s = getApp();
  if (targets.length === 0) return;
  breadcrumb("action", "action.thread", { action, count: targets.length });
  const { items, index } = useList.getState();
  // in a filtered list a row that stops matching leaves (a search too), except the open one: it stays put until the selection moves
  const reading = unmatches(action, activeFilter(s));
  const leaving = reading || (s.query ? false : !staysInView(s.view, action));
  const stays = reading ? s.selectedId : null;

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
  // z right after the key: this action is the last one already, its undo waits for the backend's answer
  const undoIds = deferred<number[]>();
  const undo = options.quiet ? null : registerUndo(() => undoIds.promise.then((ids) => (ids.length ? undoActions(ids, targets.length) : undefined)));
  try {
    // the contract takes ≤ 5,000 ids a call (the backend slices each); each call can be undone exactly
    const ids: number[] = [];
    for (let i = 0; i < targets.length; i += 5000) {
      const r = await client.call("threads.act", { threadIds: targets.slice(i, i + 5000), action });
      if (r.undoId !== null) ids.push(r.undoId);
    }
    undoIds.resolve(ids);
    invalidateThreads(targets);
    // the read-after-dwell: nothing to announce or to undo
    if (options.quiet) return;
    // undone with z before the answer came: nothing to say
    if (!undo || undo.state !== "ready") return;
    if (SNACK_ALWAYS.has(action) || targets.length > 1) snack(said(action, targets.length), { action: ids.length ? undoAction(undo, t(UNDO_NAME[action])) : undefined });
  } catch (error) {
    undoIds.resolve([]);
    captureUi(error, { code: "action.failed", fields: { action, count: targets.length } });
    snack.error(failed(error));
    void reloadList({ keepSelection: true });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
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
  const s = getApp();
  // the scope's loaded rows: with the unread filter, not a read row it kept (the open one)
  const loaded = scopeRows(useList.getState().items, sel.scope).map((t) => t.id);
  const reading = unmatches(action, listFilterOfScope(sel.scope));
  const leaving = reading || (sel.scope.kind === "search" ? false : !staysInView(s.view, action));
  // the open thread stays open when it isn't leaving: kept outside the scope, or read in place (the filter keeps it)
  const stays = s.selectedId !== null && (reading || !loaded.includes(s.selectedId)) ? s.selectedId : null;
  if (leaving) {
    reflowRemoval(loaded.filter((id) => id !== stays));
    if (stays === null) setApp({ selectedId: null });
  }
  patchRows(loaded, (t) => (leaving && t.id !== stays ? null : patched(t, action)));
  setApp({ checked: new Set(), scope: null });
  const progress = trackJob(t(DOING[action], { count: sel.count }));
  const undoId = deferred<{ id: number | null; n: number }>();
  const undo = registerUndo(() => undoId.promise.then((u) => (u.id === null ? undefined : undoActions([u.id], u.n))));
  try {
    const r = await client.call("threads.actScope", { scope: sel.scope, action, jobId: progress.jobId });
    undoId.resolve({ id: r.undoId, n: r.affected });
    invalidateThreads(loaded);
    const offer = r.undoId !== null && undo.state === "ready";
    snack.success(said(action, r.affected), { id: progress.snackId, duration: 8000, action: offer ? undoAction(undo, t(UNDO_NAME[action])) : undefined });
  } catch (error) {
    undoId.resolve({ id: null, n: 0 });
    snack.error(failed(error), { id: progress.snackId });
  } finally {
    progress.stop();
    void reloadList({ keepSelection: true });
  }
}

/**
 * Undo: the backend puts back each message the action changed, exactly
 * as it was (read, star, place). Large ones show their progress.
 */
async function undoActions(undoIds: readonly number[], n: number): Promise<void> {
  const progress = n > 200 ? trackJob(t("actions.undoing", { count: n })) : null;
  try {
    let restored = 0;
    for (const undoId of undoIds) restored += (await client.call("threads.undo", { undoId, jobId: progress?.jobId })).restored;
    if (progress) snack.success(t("actions.undone", { count: restored }), { id: progress.snackId, duration: 4000 });
  } catch (error) {
    // the undo token says so, with a retry (z points back at it too)
    if (progress) dismissSnack(progress.snackId);
    throw error;
  } finally {
    progress?.stop();
    void reloadList({ keepSelection: true });
  }
}

/** The rows an action would apply to now, loaded (a scope's are its loaded rows). */
export function targetRows(ids?: readonly number[]): ThreadSummary[] {
  const { items, index } = useList.getState();
  const target = ids ? { ids } : currentTargets();
  if ("scope" in target) return scopeRows(items, target.scope.scope);
  return target.ids.flatMap((id) => {
    const row = items[index.get(id) ?? -1];
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
  if (readTimer) clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const st = useList.getState();
    const row = st.items[st.index.get(id) ?? -1];
    if (row?.unread && getApp().selectedId === id) void act("markRead", [id], { quiet: true });
  }, 450);
}

// ───────────────────────────── compose ─────────────────────────────

// Structured formatting/parsing (quoted display names) so a crafted sender name can't add recipients.
export const parseAddresses = parseAddressList;
export { openCompose, sendDraft } from "./compose";

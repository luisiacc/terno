import { parseAddressList, type ThreadAction, type ThreadSummary, type View } from "@unica/core";
import { toast } from "sonner";
import { reflowRemoval } from "~/lib/flash";
import { client } from "~/rpc/connection";
import { currentTargets } from "~/lib/select";
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

/** What a toast says after an action (several threads: "· N conversaciones"). */
const DONE: Record<ThreadAction, string> = {
  archive: "Archivado",
  trash: "Movido a la papelera",
  spam: "Marcado como spam",
  notSpam: "Movido a Entrada",
  moveToInbox: "Movido a Entrada",
  markRead: "Marcado como leído",
  markUnread: "Marcado como no leído",
  star: "Destacado",
  unstar: "Sin destacar",
};
/** In progress, for a scope action's toast. */
const DOING: Record<ThreadAction, string> = {
  archive: "Archivando",
  trash: "Moviendo a la papelera",
  spam: "Marcando como spam",
  notSpam: "Moviendo a Entrada",
  moveToInbox: "Moviendo a Entrada",
  markRead: "Marcando como leídas",
  markUnread: "Marcando como no leídas",
  star: "Destacando",
  unstar: "Quitando destacado",
};
/** One thread's undo toast only for these (reads and stars show in the row itself); several threads always get one. */
const TOAST_ALWAYS = new Set<ThreadAction>(["archive", "trash", "spam", "notSpam", "moveToInbox"]);

/** z / ⌘Z: the last undoable action, until another replaces it. */
let lastUndo: (() => void) | null = null;
export function undoLast(): void {
  const undo = lastUndo;
  lastUndo = null;
  undo?.();
}
/** Category filings register here too (their snackbar's or toast's undo). */
export function setLastUndo(undo: (() => void) | null): void {
  lastUndo = undo;
}

const fmt = (n: number) => n.toLocaleString("es-MX");
const said = (action: ThreadAction, n: number) => (n > 1 ? `${DONE[action]} · ${fmt(n)} conversaciones` : DONE[action]);

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

/**
 * Applies a triage action optimistically: the list updates in the same frame,
 * selection advances to the next thread, and the backend persists + syncs.
 * Without explicit ids it acts on the selection: a "select all N" scope, the
 * checked rows, or the open thread.
 */
export async function act(action: ThreadAction, ids?: number[], options: { quiet?: boolean } = {}): Promise<void> {
  if (!ids) {
    const t = currentTargets();
    if ("scope" in t) return actScope(action, t.scope);
    ids = t.ids;
  }
  const targets = ids;
  const s = getApp();
  if (targets.length === 0) return;
  const { items, index } = useList.getState();
  const leaving = s.query ? false : !staysInView(s.view, action);

  if (leaving && s.selectedId !== null && targets.includes(s.selectedId)) {
    // Superhuman-style: move to the next thread that isn't being removed
    const start = index.get(s.selectedId) ?? 0;
    const removed = new Set(targets);
    const next = items.slice(start + 1).find((t) => !removed.has(t.id)) ?? items.slice(0, start).reverse().find((t) => !removed.has(t.id));
    setApp({ selectedId: next?.id ?? null });
  }
  if (leaving) reflowRemoval(targets);
  patchRows(targets, (t): ThreadSummary | null => (leaving ? null : patched(t, action)));
  // what the user acted on stops being selected; automatic and undo actions never touch the selection
  const onTargets = !options.quiet && targets.some((id) => s.checked.has(id));
  if (onTargets && (s.checked.size || s.scope)) setApp({ checked: new Set(), scope: null });
  // z right after the key: this action is the last one already, its undo waits for the backend's answer
  const undoIds = deferred<number[]>();
  if (!options.quiet) lastUndo = () => void undoIds.promise.then((ids) => (ids.length ? undoActions(ids, targets.length) : undefined));
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
    const undo = ids.length ? () => void undoActions(ids, targets.length) : undefined;
    if (TOAST_ALWAYS.has(action) || targets.length > 1) toast(said(action, targets.length), { action: undo ? { label: "Deshacer", onClick: undo } : undefined });
  } catch (error) {
    undoIds.resolve([]);
    toast.error(`No se pudo completar: ${error instanceof Error ? error.message : error}`);
    void reloadList({ keepSelection: true });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let job = 0;
/** Progress of a backend job in a loading toast ("Archivando… 1 234 / 5 678"). */
export function trackJob(title: string): { jobId: string; toastId: string | number; stop(): void } {
  const jobId = `job-${Date.now()}-${++job}`;
  const toastId = toast.loading(`${title}…`);
  const off = client.on("bulkProgress", (p) => {
    if (p.jobId === jobId && p.done < p.total) toast.loading(`${title}… ${fmt(p.done)} / ${fmt(p.total)}`, { id: toastId });
  });
  return { jobId, toastId, stop: off };
}

/**
 * "Select all N" + an action: the loaded rows change at once, the backend
 * applies it to the whole scope in slices with a progress toast, and one
 * Deshacer takes back exactly what changed.
 */
async function actScope(action: ThreadAction, sel: ScopeSelection): Promise<void> {
  const s = getApp();
  const { items } = useList.getState();
  const loaded = items.map((t) => t.id);
  const leaving = sel.scope.kind === "search" ? false : !staysInView(s.view, action);
  if (leaving) {
    reflowRemoval(loaded);
    setApp({ selectedId: null });
  }
  patchRows(loaded, (t) => (leaving ? null : patched(t, action)));
  setApp({ checked: new Set(), scope: null });
  const progress = trackJob(`${DOING[action]} ${fmt(sel.count)} conversaciones`);
  const undoId = deferred<{ id: number | null; n: number }>();
  lastUndo = () => void undoId.promise.then((u) => (u.id === null ? undefined : undoActions([u.id], u.n)));
  try {
    const r = await client.call("threads.actScope", { scope: sel.scope, action, jobId: progress.jobId });
    undoId.resolve({ id: r.undoId, n: r.affected });
    invalidateThreads(loaded);
    const undo = r.undoId === null ? null : () => void undoActions([r.undoId!], r.affected);
    toast.success(said(action, r.affected), { id: progress.toastId, duration: 8000, action: undo ? { label: "Deshacer", onClick: undo } : undefined });
  } catch (error) {
    undoId.resolve({ id: null, n: 0 });
    toast.error(`No se pudo completar: ${error instanceof Error ? error.message : error}`, { id: progress.toastId });
  } finally {
    progress.stop();
    void reloadList({ keepSelection: true });
  }
}

/**
 * Deshacer: the backend puts back each message the action changed, exactly
 * as it was (read, star, place). Large ones show their progress.
 */
async function undoActions(undoIds: readonly number[], n: number): Promise<void> {
  const progress = n > 200 ? trackJob(`Deshaciendo ${fmt(n)} conversaciones`) : null;
  try {
    let restored = 0;
    for (const undoId of undoIds) restored += (await client.call("threads.undo", { undoId, jobId: progress?.jobId })).restored;
    if (progress) toast.success(`Deshecho · ${fmt(restored)} conversaciones`, { id: progress.toastId, duration: 4000 });
  } catch (error) {
    toast.error(`No se pudo deshacer: ${error instanceof Error ? error.message : error}`, progress ? { id: progress.toastId } : undefined);
  } finally {
    progress?.stop();
    void reloadList({ keepSelection: true });
  }
}

/** The rows an action would apply to now, loaded (a scope's are its loaded rows). */
export function targetRows(ids?: readonly number[]): ThreadSummary[] {
  const { items, index } = useList.getState();
  const t = ids ? { ids } : currentTargets();
  if ("scope" in t) return items;
  return t.ids.flatMap((id) => {
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

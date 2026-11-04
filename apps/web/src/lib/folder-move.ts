/**
 * Plan 127: mail moved to one of an account's own folders (a drag, the thread menu's "Move to"). Only what was
 * dropped moves; the snack then offers the rest, like a category's. A thread in a category shown in the Inbox, and in
 * none hidden, stays there as well as in the folder.
 */
import type { Category, ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { deferred, targetRows, undoAction, undoActions } from "~/lib/actions";
import { leaveView } from "~/lib/categorize";
import { flashRows } from "~/lib/flash";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
import { patchRows, reloadList } from "~/state/list";
import { invalidateThreads } from "~/state/threads";

export interface FolderDrop {
  accountId: number;
  key: string;
  name: string;
}

/** A folder's drop target (`folderRef`) back to its parts; a key may hold ":" (an IMAP path). */
export function parseFolderRef(ref: string): { accountId: number; key: string } {
  const at = ref.indexOf(":");
  return { accountId: Number(ref.slice(0, at)), key: ref.slice(at + 1) };
}

/** What the backend decides too: in the Inbox, in a category shown there, in none hidden (hidden wins, plan 83). */
export function staysInInbox(row: Pick<ThreadSummary, "inInbox" | "categoryIds">, categories: readonly Pick<Category, "id" | "showInInbox">[]): boolean {
  if (!row.inInbox || row.categoryIds.length === 0) return false;
  return row.categoryIds.every((id) => categories.find((c) => c.id === id)?.showInInbox !== false);
}

/** What about these rows keeps them out of a folder: another account's, or in Trash or Spam (rows checked once, at the drag's start). */
export interface DragFacts {
  accounts: ReadonlySet<number>;
  disposed: boolean;
}
export function factsOf(rows: readonly Pick<ThreadSummary, "accountId" | "inTrash" | "inSpam">[]): DragFacts {
  return { accounts: new Set(rows.map((r) => r.accountId)), disposed: rows.some((r) => r.inTrash || r.inSpam) };
}
export const refusesFolder = (facts: DragFacts, accountId: number): boolean => facts.disposed || facts.accounts.size !== 1 || !facts.accounts.has(accountId);
/** Why, in words; said when one is dropped anyway. */
export const refusalText = (facts: DragFacts, folder: string): string => (facts.disposed ? t("folder.move.refusedPlace", { folder }) : t("folder.move.refusedAccount", { folder }));

/** The folder you're looking at, when it's another of this account's: a move leaves it. */
export function sourceFolder(s: { accountId: number | null; folder: string | null }, to: Pick<FolderDrop, "accountId" | "key">): string | null {
  return s.folder !== null && s.accountId === to.accountId && s.folder !== to.key ? s.folder : null;
}

/** Does this row leave the list on screen? A search, All Mail, Sent, a category's list and the like keep it. */
export function leavesList(s: { query: string; folder: string | null; view: string }, row: Pick<ThreadSummary, "inInbox" | "categoryIds">, categories: readonly Pick<Category, "id" | "showInInbox">[], to: string): boolean {
  if (s.query.trim()) return false;
  if (s.folder !== null) return s.folder !== to;
  return s.view === "inbox" && !staysInInbox(row, categories);
}

/** What the note says when some stayed in the Inbox: the category by name when it's one. */
export function keptNote(kept: number, rows: readonly Pick<ThreadSummary, "inInbox" | "categoryIds">[], categories: readonly Pick<Category, "id" | "name" | "showInInbox">[]): string | undefined {
  if (kept === 0) return undefined;
  const one = kept === 1 ? rows.find((r) => staysInInbox(r, categories)) : undefined;
  const name = one && categories.find((c) => c.id === one.categoryIds[0])?.name;
  return name ? t("folder.move.keptOne", { category: name }) : t("folder.move.keptMany", { count: kept });
}

export async function moveToFolder(to: FolderDrop, threadIds: readonly number[]): Promise<void> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return;
  const s = getApp();
  const from = sourceFolder(s, to);
  const rows = targetRows(ids);
  const leaving = new Set(rows.filter((r) => leavesList(s, r, s.categories, to.key)).map((r) => r.id));
  const keptHere = new Set(rows.filter((r) => staysInInbox(r, s.categories)).map((r) => r.id));
  // the ones staying show where they are now; the rest go with the archive's fade and slide
  patchRows(ids.filter((id) => !leaving.has(id)), (row) => (keptHere.has(row.id) ? row : { ...row, inInbox: false }));
  flashRows(ids.filter((id) => !leaving.has(id)));
  if (leaving.size) leaveView([...leaving]);
  else if (s.checked.size) setApp({ checked: new Set() });
  const undoIds = deferred<number[]>();
  const undo = registerUndo(() => undoIds.promise.then((list) => (list.length ? undoActions(list, ids.length) : undefined)));
  const connection = client.connectionVersion;
  try {
    const list: number[] = [];
    let kept = 0;
    // the contract takes ≤ 5,000 ids a call; each can be undone exactly
    for (let i = 0; i < ids.length; i += 5000) {
      const r = await client.call("folders.moveThreads", { accountId: to.accountId, folder: to.key, from, threadIds: ids.slice(i, i + 5000) });
      if (r.undoId !== null) list.push(r.undoId);
      kept += r.kept;
    }
    undoIds.resolve(list);
    invalidateThreads(ids);
    if (connection !== client.connectionVersion || undo.state !== "ready") return;
    const note = keptNote(kept, rows, s.categories);
    const undoName = t("folder.move.undo", { folder: to.name });
    const id = snack(t("folder.move.done", { count: ids.length, folder: to.name }), { description: note, action: list.length ? undoAction(undo, undoName) : undefined });
    // the same snack offers the rest from this sender, subject, domain or list
    if (ids.length <= 200) {
      void Promise.all([import("~/components/folder-snackbar"), client.call("offers.forAction", { threadIds: ids, action: { accountId: to.accountId, folder: to.key } })]).then(
        ([{ showFolderSnackbar }, offers]) => showFolderSnackbar(id, { to, from, targets: ids, offers, undo, undoName, note }),
        () => undefined,
      );
    }
  } catch (error) {
    undoIds.resolve([]);
    if (connection !== client.connectionVersion) return;
    snack.error(t("folder.move.failed", { folder: to.name, error: error instanceof Error ? error.message : String(error) }));
    void reloadList({ keepSelection: true });
  }
}

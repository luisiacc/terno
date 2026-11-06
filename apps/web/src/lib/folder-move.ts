/**
 * Plan 127: mail moved to one of an account's own folders (a drag, the thread menu's "Move to"). Only what was
 * dropped moves; the snack then offers the rest, like a category's. A thread in a category shown in the Inbox, and in
 * none hidden, stays there as well as in the folder.
 */
import { RpcError } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { deferred, targetRows, undoAction, undoActions } from "~/lib/actions";
import { leaveView } from "~/lib/categorize";
import { flashRows } from "~/lib/flash";
import { keptNote, leavesList, sourceFolder, staysInInbox } from "~/lib/folder-rules";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
import { patchRows, reloadList } from "~/state/list";
import { invalidateThreads } from "~/state/threads";

export type { FolderDrop } from "~/lib/folder-rules";
import type { FolderDrop } from "~/lib/folder-rules";
import { showFolderSnackbar } from "~/components/folder-snackbar";

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
  const list: number[] = [];
  try {
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
      void client.call("offers.forAction", { threadIds: ids, action: { accountId: to.accountId, folder: to.key } }).then(
        (offers) => showFolderSnackbar(id, { to, from, targets: ids, offers, undo, undoName, note }),
        () => undefined,
      );
    }
  } catch (error) {
    // what committed before the failure stays undoable: earlier calls, and the slices of this one (the backend names them)
    const partial = error instanceof RpcError ? (error.details as { undoId?: number } | undefined)?.undoId : undefined;
    if (typeof partial === "number") list.push(partial);
    undoIds.resolve(list);
    if (connection !== client.connectionVersion) return;
    snack.error(t("folder.move.failed", { folder: to.name, error: error instanceof Error ? error.message : String(error) }), { action: list.length && undo.state === "ready" ? undoAction(undo, t("folder.move.undo", { folder: to.name })) : undefined });
    void reloadList({ keepSelection: true });
  }
}

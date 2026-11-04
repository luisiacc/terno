/** Plan 127: what a drop on a folder decides from the rows alone: pure, and read by the drag on every target it meets. */
import type { Category, ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";

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

/** The folder whose list is on screen (a search keeps the folder in the state, but lists everywhere): dropping there does nothing. */
export const listingFolder = (s: { accountId: number | null; folder: string | null; query: string }, accountId: number, key: string): boolean => !s.query.trim() && s.folder === key && s.accountId === accountId;

/** The folder whose list you're moving from, when it's another of this account's: a move leaves it. */
export function sourceFolder(s: { accountId: number | null; folder: string | null; query: string }, to: Pick<FolderDrop, "accountId" | "key">): string | null {
  return !s.query.trim() && s.folder !== null && s.accountId === to.accountId && s.folder !== to.key ? s.folder : null;
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

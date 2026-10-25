/**
 * The quick filter, bound to the app: ⌘L, the header button and its menu,
 * Lumen's chips, the palette and the desktop's View menu all set it here; and
 * in a filtered list a row that stops matching leaves once it is neither open nor checked (lib/unread-filter
 * holds the state's rules, state/list asks the store to keep those rows).
 */
import { reflowRemoval } from "~/lib/flash";
import { isMac } from "~/lib/select";
import { matchesFilter, type ListFilter } from "@terno/core";
import { activeFilter, isUnreadOnly, mailboxKey, saveListFilters, withFilter } from "~/lib/unread-filter";
import { getApp, setApp, useApp } from "~/state/app";
import { patchRows, useList } from "~/state/list";

/** The toggle applies: the app is up, nothing modal is open, and the list is a mailbox ("Revisar" isn't). */
export function canToggleUnread(s = getApp()): boolean {
  return s.ready && s.dialog === null && !s.menuOpen && s.reviewCategoryId === null && !document.getElementById("root")?.inert;
}

/** The current mailbox's quick filter (none: everything); remembered across launches. */
export function setListFilter(filter: ListFilter | undefined): void {
  const s = getApp();
  if (!canToggleUnread(s) || activeFilter(s) === filter) return;
  const listFilters = withFilter(s.listFilters, mailboxKey(s), filter);
  saveListFilters(listFilters);
  // a multi-selection was taken on the other list; the open thread stays open
  setApp({ listFilters, checked: new Set(), anchorId: null, scope: null });
}

/** ⌘L: unread ↔ everything (another filter on: unread). */
export function toggleUnreadFilter(): void {
  setListFilter(isUnreadOnly(getApp()) ? undefined : "unread");
}

/**
 * Keys pressed inside a mail's frame never reach the document's handler: ⌘L
 * is handed to it as the same key (its repeat and echo rules apply), so it
 * doesn't depend on where focus is.
 */
export function forwardUnreadKey(e: KeyboardEvent): void {
  if (e.key.toLowerCase() !== "l" || e.altKey || e.shiftKey || !(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
  e.preventDefault();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, repeat: e.repeat, cancelable: true }));
}

/** The open thread moved (j/k, a click) or the checks changed: rows that no longer match, held by nobody, leave the filtered list. */
useApp.subscribe((s, prev) => {
  if (s.selectedId === prev.selectedId && s.checked === prev.checked) return;
  // a change of filter reloads the list itself (with the open thread kept)
  const filter = activeFilter(s);
  if (!filter || filter !== activeFilter(prev)) return;
  const leaving = useList
    .getState()
    .items.filter((t) => !matchesFilter(filter, t) && t.id !== s.selectedId && !s.checked.has(t.id))
    .map((t) => t.id);
  if (leaving.length === 0) return;
  reflowRemoval(leaving);
  patchRows(leaving, () => null);
});

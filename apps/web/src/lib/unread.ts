/**
 * The unread filter, bound to the app: ⌘L, the header button, the palette
 * and the desktop's Ver menu all toggle through here; and in a filtered list
 * a read row leaves once it is neither open nor checked (lib/unread-filter
 * holds the state's rules, state/list asks the store to keep those rows).
 */
import { reflowRemoval } from "~/lib/flash";
import { isMac } from "~/lib/select";
import { flipped, isUnreadOnly, mailboxKey, saveUnreadFilters } from "~/lib/unread-filter";
import { getApp, setApp, useApp } from "~/state/app";
import { patchRows, useList } from "~/state/list";

/** The toggle applies: the app is up, nothing modal is open, and the list is a mailbox ("Revisar" isn't). */
export function canToggleUnread(s = getApp()): boolean {
  return s.ready && s.dialog === null && !s.menuOpen && s.reviewCategoryId === null && !document.getElementById("root")?.inert;
}

/** Filtered ↔ everything, for the current mailbox; remembered across launches. */
export function toggleUnreadFilter(): void {
  const s = getApp();
  if (!canToggleUnread(s)) return;
  const unreadFilters = flipped(s.unreadFilters, mailboxKey(s));
  saveUnreadFilters(unreadFilters);
  // a multi-selection was taken on the other list; the open thread stays open
  setApp({ unreadFilters, checked: new Set(), anchorId: null, scope: null });
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

/** The open thread moved (j/k, a click) or the checks changed: read rows nobody holds leave the filtered list. */
useApp.subscribe((s, prev) => {
  if (s.selectedId === prev.selectedId && s.checked === prev.checked) return;
  // a toggle reloads the list itself (with the open thread kept)
  if (!isUnreadOnly(s) || !isUnreadOnly(prev)) return;
  const leaving = useList
    .getState()
    .items.filter((t) => !t.unread && t.id !== s.selectedId && !s.checked.has(t.id))
    .map((t) => t.id);
  if (leaving.length === 0) return;
  reflowRemoval(leaving);
  patchRows(leaving, () => null);
});

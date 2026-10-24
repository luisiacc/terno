import { resolveKey, type Command } from "@unica/core";
import { act, openCompose, toggleRead, toggleStar, undoLast } from "~/lib/actions";
import { clearSelection, extendSelection, isMac, selectAll, selectWhere, toggleCurrent } from "~/lib/select";
import { openMenuForSelection } from "~/components/thread-menu";
import { getApp, navigate, setApp } from "~/state/app";
import { useList } from "~/state/list";
import { loadThread, useThreads } from "~/state/threads";
import { acceptSuggestion, rejectSuggestion } from "~/lib/categorize";
import { listScroller, searchInputRef } from "~/components/thread-list";
import { snackbarControls } from "~/components/category-snackbar";

function move(delta: number) {
  const { items, index } = useList.getState();
  if (items.length === 0) return;
  const s = getApp();
  const current = s.selectedId !== null ? (index.get(s.selectedId) ?? -1) : -1;
  const next = Math.max(0, Math.min(items.length - 1, current + delta));
  const id = items[next]!.id;
  if (id === s.selectedId) return;
  setApp({ selectedId: id, readerOpen: true });
  listScroller.scrollToIndex?.(next);
  // warm the neighbours so the next keypress renders from cache
  for (const n of [next + delta, next + 2 * delta]) {
    const t = items[n];
    if (t) void loadThread(t.id);
  }
}

/** y / n answer the reader's first "¿Categoría?" chip. */
function answerSuggestion(yes: boolean) {
  const id = getApp().selectedId;
  const s = id === null ? undefined : useThreads.getState().details.get(id)?.categorization?.suggestions[0];
  if (id === null || !s) return;
  void (yes ? acceptSuggestion(id, s.categoryId) : rejectSuggestion(id, s.categoryId));
}

const HANDLERS: Partial<Record<Command, () => void>> = {
  "list.next": () => move(1),
  "list.prev": () => move(-1),
  "list.open": () => setApp({ readerOpen: true }),
  "list.toggleSelect": toggleCurrent,
  "list.selectAll": selectAll,
  "list.selectNone": clearSelection,
  "list.selectRead": () => selectWhere((t) => !t.unread),
  "list.selectUnread": () => selectWhere((t) => t.unread),
  "list.selectStarred": () => selectWhere((t) => t.starred),
  "list.extendNext": () => extendSelection(1),
  "list.extendPrev": () => extendSelection(-1),
  "list.menu": () => openMenuForSelection(),
  "reader.close": clearSelection,
  "thread.archive": () => void act("archive"),
  "thread.trash": () => void act("trash"),
  "thread.spam": () => void act("spam"),
  "thread.star": () => toggleStar(),
  "thread.markRead": () => void act("markRead"),
  "thread.markUnread": () => void act("markUnread"),
  "thread.toggleRead": () => toggleRead(),
  "thread.category": () => hasTargets() && setApp({ dialog: "categoryPicker", pickerMode: "toggle" }),
  "thread.move": () => hasTargets() && setApp({ dialog: "categoryPicker", pickerMode: "move" }),
  "action.undo": undoLast,
  "compose.new": () => openCompose("new"),
  "compose.reply": () => openCompose("reply"),
  "compose.replyAll": () => openCompose("replyAll"),
  "compose.forward": () => openCompose("forward"),
  "search.focus": () => searchInputRef.current?.focus(),
  "palette.open": () => setApp({ dialog: getApp().dialog === "palette" ? null : "palette" }),
  "go.inbox": () => navigate({ view: "inbox" }),
  "go.starred": () => navigate({ view: "starred" }),
  "go.sent": () => navigate({ view: "sent" }),
  "go.archive": () => navigate({ view: "archive" }),
  "go.trash": () => navigate({ view: "trash" }),
  "help.shortcuts": () => setApp({ dialog: "shortcuts" }),
  "suggestion.accept": () => answerSuggestion(true),
  "suggestion.reject": () => answerSuggestion(false),
  "snackbar.action1": () => snackbarControls.current?.action(1),
  "snackbar.action2": () => snackbarControls.current?.action(2),
  "snackbar.action3": () => snackbarControls.current?.action(3),
  "snackbar.action4": () => snackbarControls.current?.action(4),
  "snackbar.action5": () => snackbarControls.current?.action(5),
  "snackbar.undo": () => snackbarControls.current?.undo(),
  "snackbar.close": () => snackbarControls.current?.close(),
};

const hasTargets = () => {
  const s = getApp();
  return s.selectedId !== null || s.checked.size > 0;
};

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

/** One document-level handler; commands are resolved by the pure resolver in @unica/core. */
export function installKeyboard(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    // a blocking screen (the web's lifecycle) makes the app inert: its shortcuts wait with it
    if (document.getElementById("root")?.inert) return;
    const s = getApp();
    const result = resolveKey(
      { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey },
      {
        editable: isEditable(document.activeElement),
        composing: s.compose !== null && document.activeElement?.closest("[data-testid=composer]") !== null,
        // the context menu is modal for the keyboard: its arrows, Enter and typeahead apply
        dialogOpen: s.dialog !== null || s.menuOpen,
        snackbar: s.snackbar,
      },
      s.pendingKeys,
      undefined,
      isMac,
    );
    if (result.pending !== s.pendingKeys) setApp({ pendingKeys: result.pending });
    if (!result.command) return;
    const handler = HANDLERS[result.command];
    if (!handler) return;
    e.preventDefault();
    performance.mark(`key:${result.command}`);
    handler();
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}

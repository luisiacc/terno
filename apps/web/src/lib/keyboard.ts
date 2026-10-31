import { goToFolder } from "~/lib/account-folders";
import { resolveKey, type Command } from "@terno/core";
import { act, openCompose, toggleRead, toggleStar, undoLast } from "~/lib/actions";
import { focusDock } from "~/components/snack-dock";
import { clearSelection, extendSelection, isMac, selectAll, selectWhere, toggleCurrent } from "~/lib/select";
import { openMenuForSelection } from "~/components/thread-menu";
import { getApp, markSelectionIntent, navigate, setApp } from "~/state/app";
import { loadMore, useList } from "~/state/list";
import { loadThread, useThreads } from "~/state/threads";
import { acceptSuggestion, answerReview, rejectSuggestion } from "~/lib/categorize";
import { printCommand } from "~/lib/print-open";
import { checkForUpdates } from "~/lib/updates";
import { focusSearch, listScroller } from "~/components/thread-list";
import { snackbarControls } from "~/components/category-snackbar";
import { setListFilter, toggleUnreadFilter } from "~/lib/unread";
import { closePage, currentPage, goBack, goForward, listLayout, openThread, uncoverList } from "~/lib/page";
import type { DraftMode } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { snack } from "~/lib/snack";
import { noteOpen, openRemind } from "~/lib/reminders";

/** Toggles act once per press: no key repeat, and the desktop menu's echo of a key just handled is dropped. */
const TOGGLES = new Set<Command>(["list.toggleUnread", "nav.back", "nav.forward"]);
const ECHO_MS = 300;
const lastKey = new Map<Command, number>();

/** a next page asked for by j at the end of the loaded rows (one at a time) */
let stepping = false;
/** every move: a page that answers after the user moved again (or left the page) doesn't move for them */
let moves = 0;

export function move(delta: number) {
  const { items, index, nextCursor } = useList.getState();
  if (items.length === 0) return;
  const s = getApp();
  const current = s.selectedId !== null ? (index.get(s.selectedId) ?? -1) : -1;
  // List's conversation page: a thread that isn't in the loaded list (a reload, a draft's) has no neighbours to step to (R10)
  const onPage = listLayout() && currentPage() === "thread";
  if (onPage && current === -1) return;
  const pastEnd = onPage && delta > 0 && current + delta > items.length - 1 && nextCursor;
  // the same step again while its page is on its way: one step (it doesn't cancel the first)
  if (pastEnd && stepping) return;
  const mine = ++moves;
  // past the last loaded row on the page: the next page first (the covered list's own scrolling may not ask for it)
  if (pastEnd) {
    stepping = true;
    void loadMore().then((ok) => {
      stepping = false;
      const still = mine === moves && getApp().selectedId === s.selectedId && listLayout() && currentPage() === "thread";
      if (!ok && still) snack.error(t("reader.olderFailed"));
      else if (still && useList.getState().items.length > items.length) move(delta);
    });
    return;
  }
  const next = Math.max(0, Math.min(items.length - 1, current + delta));
  const id = items[next]!.id;
  // plan 87: the user stepped onto it (Split shows it; in List's list page the dwell finds no reader and nothing ends)
  noteOpen(id);
  if (id === s.selectedId) { markSelectionIntent(); return; }
  // the cursor moves; in Split that opens it, in List's list page it's only the cursor (Enter opens)
  setApp({ selectedId: id });
  // where it is now: a read row the filter kept may have just left above it
  listScroller.scrollToIndex?.(useList.getState().index.get(id) ?? next);
  // warm the neighbours so the next keypress renders from cache (only where a conversation shows: R12)
  if (listLayout() && !onPage) return;
  for (const n of [next + delta, next + 2 * delta]) {
    const t = items[n];
    if (t) void loadThread(t.id);
  }
}

/** Enter / o: in List the cursor's conversation becomes the page. */
function openCurrent() {
  const id = getApp().selectedId;
  if (!listLayout()) {
    if (id !== null) {
      markSelectionIntent();
      noteOpen(id);
    }
    return setApp({ readerOpen: true });
  }
  if (id !== null) openThread(id);
}

/** r / a / f: on List's list page, the conversation opens first (its draft is in it; R3). */
function reply(mode: DraftMode) {
  const id = getApp().selectedId;
  if (listLayout() && currentPage() === "list" && id !== null) openThread(id);
  void openCompose(mode);
}

/** ⇧U / ⇧A: the list's quick filter, while the list is what's on screen (List's conversation page shows none). */
function filterList(filter: "unread" | undefined) {
  if (listLayout() && currentPage() !== "list") return;
  setListFilter(filter);
}

/** Esc: Back from a page (List), else the multi-selection ends. */
function escape() {
  if (listLayout() && currentPage() !== "list") { markSelectionIntent(); closePage({ focus: true }); }
  else clearSelection();
}

/** y / n answer the reader's first "¿Categoría?" chip; in a category's Review list, that category's (plan 80). */
function answerSuggestion(yes: boolean) {
  const { selectedId: id, reviewCategoryId: review } = getApp();
  if (id !== null && review !== null && useList.getState().index.has(id)) return void answerReview(id, review, yes);
  const s = id === null ? undefined : useThreads.getState().details.get(id)?.categorization?.suggestions[0];
  if (id === null || !s) return;
  void (yes ? acceptSuggestion(id, s.categoryId) : rejectSuggestion(id, s.categoryId));
}

const HANDLERS: Partial<Record<Command, () => void>> = {
  "list.next": () => move(1),
  "list.prev": () => move(-1),
  "list.open": openCurrent,
  "list.toggleSelect": toggleCurrent,
  "list.selectAll": selectAll,
  "list.selectNone": clearSelection,
  "list.selectRead": () => selectWhere((t) => !t.unread),
  "list.selectUnread": () => selectWhere((t) => t.unread),
  "list.selectStarred": () => selectWhere((t) => t.starred),
  "list.extendNext": () => extendSelection(1),
  "list.extendPrev": () => extendSelection(-1),
  "list.menu": () => openMenuForSelection(),
  "list.toggleUnread": toggleUnreadFilter,
  "list.filterUnread": () => filterList("unread"),
  "list.filterAll": () => filterList(undefined),
  "reader.close": escape,
  "nav.back": goBack,
  "nav.forward": goForward,
  "thread.archive": () => void act("archive"),
  "thread.trash": () => void act("trash"),
  "thread.spam": () => void act("spam"),
  "thread.star": () => toggleStar(),
  "thread.markRead": () => void act("markRead"),
  "thread.markUnread": () => void act("markUnread"),
  "thread.toggleRead": () => toggleRead(),
  "thread.category": () => hasTargets() && setApp({ dialog: "categoryPicker", pickerMode: "toggle" }),
  "thread.move": () => hasTargets() && setApp({ dialog: "categoryPicker", pickerMode: "move" }),
  "thread.remind": () => hasTargets() && openRemind(),
  "action.undo": undoLast,
  "thread.print": () => printCommand("print"),
  "thread.exportPdf": () => printCommand("pdf"),
  "compose.new": () => openCompose("new"),
  "compose.reply": () => reply("reply"),
  "compose.replyAll": () => reply("replyAll"),
  "compose.forward": () => reply("forward"),
  "search.focus": () => {
    uncoverList();
    focusSearch();
  },
  "palette.open": () => setApp({ dialog: getApp().dialog === "palette" ? null : "palette" }),
  "go.inbox": () => goToFolder("inbox"),
  "go.starred": () => goToFolder("starred"),
  "go.sent": () => goToFolder("sent"),
  "go.archive": () => goToFolder("archive"),
  "go.trash": () => goToFolder("trash"),
  "go.reminders": () => navigate({ reminders: true }),
  "help.shortcuts": () => setApp({ dialog: "shortcuts" }),
  "settings.open": () => setApp({ dialog: "settings", settingsTab: "general" }),
  "suggestion.accept": () => answerSuggestion(true),
  "suggestion.reject": () => answerSuggestion(false),
  "snackbar.action1": () => snackbarControls.current?.action(1),
  "snackbar.action2": () => snackbarControls.current?.action(2),
  "snackbar.action3": () => snackbarControls.current?.action(3),
  "snackbar.action4": () => snackbarControls.current?.action(4),
  "snackbar.action5": () => snackbarControls.current?.action(5),
  "snackbar.undo": () => snackbarControls.current?.undo(),
  "snackbar.close": () => snackbarControls.current?.close(),
  // not from a dialog or menu: the dock is under them
  "snackbar.focus": () => {
    const s = getApp();
    if (s.dialog === null && !s.menuOpen) focusDock();
  },
};

const hasTargets = () => {
  const s = getApp();
  return s.selectedId !== null || s.checked.size > 0;
};

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  // a recipient chip has focus inside its field (plan 34): Backspace, Delete and letters are the field's, never the conversation's
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable || el.closest("[data-recipient-field]") !== null;
}

/** A focused control that Enter and Space activate natively (disclosures, buttons, links). */
function activates(el: Element | null, e: KeyboardEvent): boolean {
  if (!el || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "Enter" && e.key !== " ")) return false;
  return el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "SUMMARY" || el.getAttribute("role") === "button";
}

/**
 * One document-level handler; commands are resolved by the pure resolver in
 * @terno/core. The desktop's menu commands run through the same handlers.
 */
export function installKeyboard(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    // a blocking screen (the web's lifecycle) makes the app inert: its shortcuts wait with it
    if (document.getElementById("root")?.inert) return;
    // Enter / Space on a focused button or link is that control's own (native activation)
    if (activates(document.activeElement, e)) return;
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
    if (TOGGLES.has(result.command)) {
      if (e.repeat) return;
      lastKey.set(result.command, performance.now());
    }
    performance.mark(`key:${result.command}`);
    handler();
  };
  document.addEventListener("keydown", onKeyDown);
  // Archivo → Imprimir… / Exportar como PDF…, Ver → Filtrar por no leídos: the handler decides like it does for the key
  // (the accelerator may have fired from a mail's frame); a toggle's menu echo of a key just handled is dropped
  const offMenu = window.ternoDesktop?.onCommand?.((command) => {
    // Terno → Check for Updates…: not a key, answered with a snack
    if (command === "updates.check") return void checkForUpdates();
    if (TOGGLES.has(command) && performance.now() - (lastKey.get(command) ?? -Infinity) < ECHO_MS) return;
    HANDLERS[command]?.();
  });
  return () => {
    document.removeEventListener("keydown", onKeyDown);
    offMenu?.();
  };
}

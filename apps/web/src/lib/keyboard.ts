import { replyReady, useReply } from "~/lib/replies";
import { closePreviewRow, leavePreview } from "~/state/action-preview";
import { goToFolder } from "~/lib/account-folders";
import { resolveKey, type Command } from "@terno/core";
import { act, openCompose, toggleRead, toggleStar, undoLast } from "~/lib/actions";
import { togglePin } from "~/lib/pins";
import { movePane } from "~/lib/pane-focus";
import { announce } from "~/lib/announce";
import { clearSelection, extendSelection, isMac, selectAll, selectWhere, toggleCurrent } from "~/lib/select";
import { openFocusedMenu, openMenuForSelection } from "~/components/thread-menu";
import { chooseOpenThread, getApp, markSelectionIntent, navigate, setApp } from "~/state/app";
import { loadMore, useList } from "~/state/list";
import { loadThread, useThreads } from "~/state/threads";
import { acceptSuggestion, answerReview, rejectSuggestion } from "~/lib/categorize";
import { leaveReview } from "~/lib/review";
import { backToDigest, digestHasKeys, digestKeys } from "~/state/today";
import { conversationKeys } from "~/lib/conversation-keys";
import { printCommand } from "~/lib/print-open";
import { checkForUpdates } from "~/lib/updates";
import { closeEmptySearch, focusRows, focusSearch, listScroller } from "~/components/thread-list";
import { snackbarControls } from "~/components/category-snackbar";
import { setListFilter, toggleUnreadFilter } from "~/lib/unread";
import { closePage, currentPage, goBack, goForward, listLayout, openThread, uncoverList } from "~/lib/page";
import type { DraftMode } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { snack } from "~/lib/snack";
import { noteOpen, openRemind } from "~/lib/reminders";
import { toggleAsk, togglePalette, toggleSnippets } from "~/lib/palette-open";
import { openAiDraft } from "~/lib/ai-draft";
import { draftCommands, draftKeyOf } from "~/lib/draft-commands";
import { stopSummary, useSummaries } from "~/lib/summaries";

/** Toggles act once per press: no key repeat, and the desktop menu's echo of a key just handled is dropped. */
const TOGGLES = new Set<Command>(["nav.back", "nav.forward"]);
const ECHO_MS = 300;
const lastKey = new Map<Command, number>();

/** a next page asked for by j at the end of the loaded rows (one at a time) */
let stepping = false;
/** every move: a page that answers after the user moved again (or left the page) doesn't move for them */
let moves = 0;

/**
 * Plan 188: a key moved the cursor, so focus comes along or hears where it went. On a control outside the list and the
 * conversation (a sidebar row, a toolbar button) the list takes it, and reads the row; in the conversation, focus the step took
 * away (a header of the conversation that left) goes to the reader, which is named by the new subject; focus that's still
 * there hears the subject.
 */
function followCursor(id: number, before: Element | null): void {
  const reader = () => document.querySelector<HTMLElement>("[data-testid=reader]");
  // (a full message over the conversation is the conversation's too: Codex review)
  const inReader = !!before && (!!reader()?.contains(before) || !!before.closest("[data-testid=full-message]"));
  const listShown = !(listLayout() && currentPage() !== "list");
  if (!inReader) {
    // (with focus nowhere, the page itself, nothing is pulled: the list's keys work from there as they always did)
    if (listShown && before && before !== document.body && !before.closest("[data-list-section]")) focusRows();
    return;
  }
  const said = useList.getState().items.find((t) => t.id === id);
  requestAnimationFrame(() => {
    if (getApp().selectedId !== id) return;
    const active = document.activeElement;
    if (!active || active === document.body) reader()?.focus({ preventScroll: true });
    else if (said) announce(t("reader.announce.opened", { subject: said.subject || t("common.noSubject"), from: said.fromName }));
  });
}

export function move(delta: number, byKey = false) {
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
      else if (still && useList.getState().items.length > items.length) move(delta, byKey);
    });
    return;
  }
  const next = Math.max(0, Math.min(items.length - 1, current + delta));
  const id = items[next]!.id;
  // plan 87: the user stepped onto it (Split shows it; in List's list page the dwell finds no reader and nothing ends)
  noteOpen(id);
  if (id === s.selectedId) { markSelectionIntent(); chooseOpenThread(); return; }
  const before = document.activeElement;
  // the cursor moves; in Split that opens it, in List's list page it's only the cursor (Enter opens)
  setApp({ selectedId: id });
  if (byKey) followCursor(id, before);
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
  // on a message's header (N and P put you there), o opens it as Enter does
  const header = document.activeElement;
  if (header instanceof HTMLElement && header.dataset.testid === "message-toggle") return header.click();
  const id = getApp().selectedId;
  if (!listLayout()) {
    if (id !== null) {
      markSelectionIntent();
      chooseOpenThread();
      noteOpen(id);
    }
    setApp({ readerOpen: true });
    // plan 188: into the conversation, as List's page does (the reader is named by its subject)
    if (id !== null) document.querySelector<HTMLElement>("[data-testid=reader]")?.focus({ preventScroll: true });
    return;
  }
  if (id !== null) openThread(id);
}

/** r / a / f (and the palette's Reply): on List's list page, the conversation opens first (its draft is in it; R3). */
/** / and the palette's Search mail: the field, wherever the list is. */
export function focusSearchField(): void {
  uncoverList();
  focusSearch();
}

export function reply(mode: DraftMode) {
  const id = getApp().selectedId;
  if (listLayout() && currentPage() === "list" && id !== null) openThread(id);
  // plan 144: a reply ready here is what reply means. R is Use, so it answers as the card's Reply | Reply all says (owner's decisions 2); `a` is Reply all
  if (id !== null && mode !== "forward" && replyReady(id)) return void useReply(id, mode === "reply" ? undefined : mode);
  void openCompose(mode);
}

/** ⇧U / ⇧A: the list's quick filter, while the list is what's on screen (List's conversation page shows none). */
function filterList(filter: "unread" | undefined) {
  if (listLayout() && currentPage() !== "list") return;
  setListFilter(filter);
}

/** Esc: Back from a page (List), else a preview's open conversation, else the preview, else the multi-selection ends, else from a search's results to its field (plan 158: the query kept, the field's own Esc leaves). */
function escape() {
  const s = getApp();
  // plan 162 (after ai162-r03): a summary being written in the reader stops first, as Esc stops ⌘J and Ask
  if (s.selectedId !== null && useSummaries.getState().byThread.get(s.selectedId)?.kind === "running") return void stopSummary(s.selectedId);
  // plan 161, pass 2: a newsletter the digest opened goes back to the digest first, as its "Back to the digest" does
  if (backToDigest()) return;
  // plan 162 (after ai162-r02): the digest page gives its keys back to the list, at the digest's way in
  // (List's digest is a page over the list: Esc closes it as any page, back to the list, Codex review)
  if (!(listLayout() && currentPage() !== "list") && digestHasKeys()) return void digestKeys.current!.leave();
  if (listLayout() && currentPage() !== "list") { markSelectionIntent(); closePage({ focus: true }); }
  // plan 161, pass 2: a matched conversation open in the reader closes first, back to the rule; then the preview ends
  else if (s.actionPreview) { if (listLayout() || !closePreviewRow()) leavePreview(); }
  else if (s.checked.size || s.scope) clearSelection();
  else if (s.query) focusSearch();
  // plan 159: Review is a place Esc leaves, for where it was entered from
  else if (s.reviewCategoryId !== null) leaveReview();
  else closeEmptySearch();
}

/** y / n answer the reader's first "¿Categoría?" chip; in a category's Review list, that category's (plan 80). */
function answerSuggestion(yes: boolean) {
  const { selectedId: id, reviewCategoryId: review } = getApp();
  if (id !== null && review !== null && useList.getState().index.has(id)) return void answerReview(id, review, yes);
  const s = id === null ? undefined : useThreads.getState().details.get(id)?.categorization?.suggestions[0];
  if (id === null || !s) return;
  void (yes ? acceptSuggestion(id, s.categoryId) : rejectSuggestion(id, s.categoryId));
}

/**
 * ⌘Enter that no form took: from a draft's own controls, or with focus nowhere (a click on the pane's blank space) while
 * a new message is on screen, it's that message's Send, which says at the field what stops it (plan 158). Never from a
 * dialog, a menu or another field: those keep the key.
 */
function shownDraft() {
  const el = document.activeElement, s = getApp();
  const nowhere = !el || el === document.body;
  return draftCommands(draftKeyOf(el) ?? (nowhere && s.dialog === null && !s.menuOpen ? s.compose?.key : null));
}

export function sendShownDraft(): void {
  shownDraft()?.send();
}

const HANDLERS: Partial<Record<Command, () => void>> = {
  // plan 162 (after ai162-r02): the digest page has the list's keys while it has the keys: its rows, not Today's behind it
  "list.next": () => (digestHasKeys() ? digestKeys.current!.step(1) : move(1, true)),
  "list.prev": () => (digestHasKeys() ? digestKeys.current!.step(-1) : move(-1, true)),
  "list.open": () => (digestHasKeys() ? digestKeys.current!.open() : openCurrent()),
  "list.toggleSelect": () => (digestHasKeys() ? digestKeys.current!.toggle() : toggleCurrent()),
  "list.selectAll": selectAll,
  "list.selectNone": clearSelection,
  "list.selectRead": () => selectWhere((t) => !t.unread),
  "list.selectUnread": () => selectWhere((t) => t.unread),
  "list.selectStarred": () => selectWhere((t) => t.starred),
  "list.extendNext": () => extendSelection(1),
  "list.extendPrev": () => extendSelection(-1),
  "list.menu": () => {
    // plan 106: a focused sidebar row with a menu of its own opens that one
    if (!openFocusedMenu()) openMenuForSelection();
  },
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
  "thread.pin": () => hasTargets() && togglePin(),
  "thread.markRead": () => void act("markRead"),
  "thread.markUnread": () => void act("markUnread"),
  "thread.toggleRead": () => toggleRead(),
  "thread.category": () => hasTargets() && setApp({ dialog: "categoryPicker", pickerMode: "toggle" }),
  "thread.move": () => hasTargets() && setApp({ dialog: "categoryPicker", pickerMode: "move" }),
  "thread.remind": () => hasTargets() && openRemind(),
  "message.next": () => conversationKeys.current?.step(1),
  "message.prev": () => conversationKeys.current?.step(-1),
  "message.toggleAll": () => conversationKeys.current?.toggleAll(),
  "action.undo": undoLast,
  "thread.print": () => printCommand("print"),
  "thread.exportPdf": () => printCommand("pdf"),
  "compose.new": () => openCompose("new"),
  "compose.reply": () => reply("reply"),
  "compose.replyAll": () => reply("replyAll"),
  "compose.forward": () => reply("forward"),
  "compose.send": sendShownDraft,
  "compose.ai": () => openAiDraft(),
  "compose.cc": () => draftCommands(draftKeyOf(document.activeElement) ?? getApp().compose?.key)?.showCc(),
  "compose.bcc": () => draftCommands(draftKeyOf(document.activeElement) ?? getApp().compose?.key)?.showBcc(),
  "search.focus": focusSearchField,
  "palette.open": togglePalette,
  "snippets.open": toggleSnippets,
  "ask.open": toggleAsk,
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
  "snackbar.only": () => snackbarControls.current?.only?.(),
  "snackbar.undo": () => snackbarControls.current?.undo(),
  "snackbar.close": () => snackbarControls.current?.close(),
};

/** Plan 188: commands whose handler says whether it did anything: a key nothing took is left to the browser (F6 on the web). */
const DECIDES: Partial<Record<Command, () => boolean>> = {
  // not from a dialog or menu: the panes are under them
  "pane.next": () => getApp().dialog === null && !getApp().menuOpen && movePane(1),
  "pane.prev": () => getApp().dialog === null && !getApp().menuOpen && movePane(-1),
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

/**
 * Plan 188: where arrows, Delete and Backspace aren't the conversation's: a sidebar row (the pane of places, where a
 * screen reader user stands on "Inbox", and Delete took the open conversation with it), and a control with its own use
 * for them (a tab, a switch, a slider, a pane's edge, a menu item). Elsewhere a button keeps them for the mail, as it
 * always did: a click leaves focus on Select all, Star or Archive, and Backspace or ↓ goes on acting on the selection.
 */
const OWN_KEYS = "select, summary, [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=switch], [role=checkbox], [role=radio], [role=slider], [role=separator], [role=treeitem], [role=combobox], [role=spinbutton]";
function onControl(el: Element | null): boolean {
  if (!el || el === document.body) return false;
  return !!el.closest("#app-sidebar") || el.matches(OWN_KEYS);
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
        onControl: onControl(document.activeElement),
        characterKeys: s.settings?.characterKeys !== false,
      },
      s.pendingKeys,
      undefined,
      isMac,
    );
    if (result.pending !== s.pendingKeys) setApp({ pendingKeys: result.pending });
    if (!result.command) return;
    const decides = DECIDES[result.command];
    if (decides) {
      if (decides()) e.preventDefault();
      return;
    }
    const handler = HANDLERS[result.command];
    if (!handler) return;
    // with no draft to send, ⌘Enter is left to whoever else takes it (an action preview's Apply)
    if (result.command === "compose.send" && !shownDraft()) return;
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

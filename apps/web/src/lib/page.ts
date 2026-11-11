/**
 * Plan 24: which page the List layout shows (the list, a conversation, a new
 * message), derived from app state, and the ways in and out of it. Split
 * never has pages: everything here is a no-op there, and Split's behavior is
 * exactly what it was.
 */
import { dwellOn } from "~/lib/open-dwell";
import { returnFromMailReaderView } from "~/components/mail-reader-back";
import { focusSearch } from "~/components/thread-list";
import { flushSync } from "react-dom";
import { useAppearance } from "~/lib/appearance";
import { leaveNewDraft, supersedeCompose } from "~/lib/compose";
import { createPageHistory, type Page, type PageHistory } from "~/lib/page-history";
import { getApp, markSelectionIntent, setApp, useApp, type AppState } from "~/state/app";
import { flushDeferredRefresh, followedRename, listKey, refreshPolicy, soloSearch } from "~/state/list";
import { noteOpen } from "~/lib/reminders";
import { closePreviewRow } from "~/state/action-preview";
import { backToDigest } from "~/state/today";
import { setHeldThreadOpener } from "~/lib/held-sends";

export type { Page };

const EMPTY: ReadonlySet<number> = new Set();

export const listLayout = (): boolean => useAppearance.getState().layout === "list";

export function pageOf(s: Pick<AppState, "compose" | "heldView" | "readerOpen" | "selectedId">, layout = useAppearance.getState().layout): Page {
  if (layout !== "list") return "list";
  // plan 182: a new message just sent stays on its page through its Undo window
  return s.compose || s.heldView !== null ? "compose" : s.readerOpen && s.selectedId !== null ? "thread" : "list";
}

export const currentPage = (): Page => pageOf(getApp());

export function usePage(): Page {
  const layout = useAppearance((s) => s.layout);
  return useApp((s) => pageOf(s, layout));
}

/** A page covers the list (List only). */
export const listCovered = (): boolean => currentPage() !== "list";
/** The conversation is on screen: always in Split, on its page in List. */
export const readerShown = (): boolean => !listLayout() || currentPage() === "thread";
dwellOn.shown = readerShown;

/**
 * Opens a conversation. In List it becomes the page, and a multi-selection
 * ends (the page has no way to show it, and its actions must mean the open
 * thread only); a new message steps aside like it does for a click.
 */
export function openThread(id: number): void {
  const s = getApp();
  // plan 87: the user opened it (a due reminder ends after the dwell)
  noteOpen(id);
  // plan 182: a new message's sent view gives way to what was opened (its own conversation, once it went)
  if (!listLayout()) return void setApp({ selectedId: id, readerOpen: true, heldView: null });
  if (s.compose) leaveNewDraft();
  setApp({ selectedId: id, readerOpen: true, anchorId: id, heldView: null, ...(s.checked.size || s.scope ? { checked: EMPTY, scope: null } : {}) });
}

// plan 182: a new message's pane opens the conversation it started, once it went
setHeldThreadOpener(openThread);

/** focus goes back to the list once it shows again (Esc, Back, an action that took the thread away; not a sidebar click) */
let restoreFocus = false;
/** what had focus in the list when the page opened */
let returnTo: HTMLElement | null = null;

/** Back to the list (List only). The history follows (§2.3); `focus` puts focus back where it was in the list. */
export function closePage(options: { focus?: boolean } = {}): void {
  const s = getApp();
  // what's open, not what the page says: the cursor may already be gone (the list's last thread just archived)
  if (!listLayout() || (!s.readerOpen && !s.compose && s.heldView === null)) return;
  if (options.focus) restoreFocus = true;
  // an r / a / f still waiting for its conversation opens nothing once the page is gone (no draft, no focus later)
  supersedeCompose();
  if (s.draftFocus) setApp({ draftFocus: null });
  if (s.compose) leaveNewDraft();
  if (getApp().heldView !== null) setApp({ heldView: null });
  if (getApp().readerOpen) setApp({ readerOpen: false });
}

const listSection = () => document.querySelector<HTMLElement>("[data-list-section]");
const listScroller = () => document.querySelector<HTMLElement>("[data-testid=thread-list] [data-keep-scroll=list]");

function focusList() {
  const el = returnTo?.isConnected && returnTo.checkVisibility?.() !== false && !returnTo.closest("[inert]") ? returnTo : listScroller();
  returnTo = null;
  el?.focus({ preventScroll: true });
}

let history: PageHistory | null = null;

// List's same-list refreshes keep the whole loaded window (an undo, a bulk result, new mail); Split keeps its cap
refreshPolicy.keepWindow = listLayout;

// Another list under a page (a search from the palette, a sender's "more from", a folder or category while writing):
// the list shows, with its rows; a new message is left the way Esc leaves it (kept if written).
useApp.subscribe((s, p) => {
  // plan 107 (Codex code review round 2 #4): the folder you're in renamed is the same list: the page stays
  const renamed = s.folder !== p.folder && followedRename.from === p.folder && followedRename.to === s.folder;
  // a folder of the same account is another list too (plan 68, Codex R5)
  const otherList = !renamed && (s.query !== p.query || s.view !== p.view || s.categoryId !== p.categoryId || s.accountId !== p.accountId || s.folder !== p.folder || s.gmailTab !== p.gmailTab || s.reviewCategoryId !== p.reviewCategoryId || s.reminders !== p.reminders || s.followups !== p.followups || s.today !== p.today || soloSearch(s) !== soloSearch(p));
  if (otherList && (s.readerOpen || s.compose || s.heldView !== null) && listLayout()) closePage();
});
// Split → List lands on the list (the cursor kept): Split's open thread is its cursor, not a page.
useAppearance.subscribe((s, p) => {
  if (s.layout === "list" && p.layout !== "list" && getApp().readerOpen) setApp({ readerOpen: false });
});

/** ⌘[ / the menu's Back / the mouse's back button. */
export function goBack(): void {
  if (returnFromMailReaderView()) return;
  if (!listLayout()) return;
  if (currentPage() !== "list") { markSelectionIntent(); closePage({ focus: true }); }
}

/** ⌘] / the menu's Forward / the mouse's forward button: the browser's own Forward (our entry above, if there is one). */
export function goForward(): void {
  if (listLayout() && currentPage() === "list") window.history.forward();
}

/**
 * "/" from a page: the list comes back first (its search field is in it), in
 * this same task so the field can take focus now.
 */
export function uncoverList(): void {
  if (listCovered()) flushSync(() => closePage());
}

/** plan 107: the list on screen was renamed (a folder's new key): the open page's history entry follows it */
export function relistPage(from: string, to: string): void {
  history?.relist(from, to);
}

/** plan 107: a folder renamed, shown or not: history entries over its lists follow it */
export function refolderPage(accountId: number, from: string, to: string): void {
  history?.refolder(accountId, from, to);
}

/** The mailbox this document opens: its path and query (?mailbox=, a demo's flags): entries of another never apply here. */
const mailboxOf = () => `${location.pathname}${location.search}`;

/**
 * Binds the page to the window: history, focus across pages, and the list's
 * deferred refresh. Before the first list load, it also says which thread a
 * reload on a conversation reopens.
 */
export function installPage(): () => void {
  const h = createPageHistory({
    history: window.history,
    mailbox: mailboxOf(),
    hash: () => location.hash,
    open: (id) => openThread(id),
    close: () => { markSelectionIntent(); closePage({ focus: true }); },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  history = h;
  const snapshot = () => {
    const s = getApp();
    const page = pageOf(s);
    return { page, id: page === "thread" ? s.selectedId : null, list: listKey() };
  };
  let prev = snapshot().page;
  const onChange = () => {
    const next = snapshot();
    const was = prev;
    prev = next.page;
    if (was === "list" && next.page !== "list") {
      const a = document.activeElement as HTMLElement | null;
      returnTo = a && a !== document.body && listSection()?.contains(a) ? a : null;
    }
    h.sync(next);
    if (was !== "list" && next.page === "list") {
      flushDeferredRefresh();
      if (restoreFocus) {
        restoreFocus = false;
        // the list is uncovered in this commit: focus it in the next frame, once it's no longer inert
        requestAnimationFrame(focusList);
      }
    }
  };
  const offApp = useApp.subscribe((s, p) => (s.compose !== p.compose || s.heldView !== p.heldView || s.readerOpen !== p.readerOpen || s.selectedId !== p.selectedId ? onChange() : undefined));
  const offLayout = useAppearance.subscribe((s, p) => (s.layout !== p.layout ? onChange() : undefined));
  const onPop = (e: PopStateEvent) => h.onPop(e.state, listKey());
  window.addEventListener("popstate", onPop);
  // the desktop's mouse side buttons (the web's browser handles them itself, with a popstate)
  const onMouse = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.button === 3) goBack();
    else goForward();
  };
  if (window.ternoDesktop) window.addEventListener("mouseup", onMouse, true);
  return () => {
    offApp();
    offLayout();
    window.removeEventListener("popstate", onPop);
    window.removeEventListener("mouseup", onMouse, true);
    history = null;
  };
}

/** At boot, in List: the thread a reload on a conversation reopens (applied before the first list load), or null. */
export function bootPage(): number | null {
  if (!history) return null;
  if (!listLayout()) {
    // Split has no pages: an address left by List (switched away from, then reloaded) is just the app's
    if (location.hash.startsWith("#/")) window.history.replaceState(null, "", `${location.pathname}${location.search}`);
    return null;
  }
  const id = history.boot(listKey());
  if (id !== null) setApp({ selectedId: id, readerOpen: true });
  return id;
}

/**
 * Keys pressed inside a mail's frame never reach the document's handler:
 * Esc and ⌘[ (Ctrl+[ off Mac) go back from List's page there too (and Esc from a preview's open conversation), like ⌘P
 * is handed over (a menu accelerator covers ⌘[ on desktop anyway).
 */
export function forwardNavKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const back = (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) || (e.key === "[" && mod && !e.altKey && !e.shiftKey);
  if (!back) return;
  if (returnFromMailReaderView()) { e.preventDefault(); return; }
  // plan 161, pass 2 (Codex review): from inside a newsletter's own document too, Esc goes back to the digest that opened it
  if (e.key === "Escape" && backToDigest()) { e.preventDefault(); return; }
  if (!listLayout() || currentPage() === "list") {
    // plan 161, pass 2: a preview's matched conversation closes back to its rule from inside its mail too (Split)
    if (e.key === "Escape" && !listLayout() && closePreviewRow()) {
      e.preventDefault();
      return;
    }
    // plan 158: Esc from a search's results, whichever part of them has focus
    if (e.key === "Escape" && getApp().query) {
      e.preventDefault();
      focusSearch();
    }
    return;
  }
  e.preventDefault();
  markSelectionIntent();
  closePage({ focus: true });
}

/** A mail frame's own document: its side buttons go back and forward too (desktop). */
export function forwardMouseNav(e: MouseEvent): void {
  if (!window.ternoDesktop || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault();
  if (e.button === 3) goBack();
  else goForward();
}

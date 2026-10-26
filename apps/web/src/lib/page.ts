/**
 * Plan 24: which page the List layout shows (the list, a conversation, a new
 * message), derived from app state, and the ways in and out of it. Split
 * never has pages: everything here is a no-op there, and Split's behavior is
 * exactly what it was.
 */
import { flushSync } from "react-dom";
import { useAppearance } from "~/lib/appearance";
import { leaveNewDraft } from "~/lib/compose";
import { createPageHistory, type Page, type PageHistory } from "~/lib/page-history";
import { getApp, setApp, useApp, type AppState } from "~/state/app";
import { flushDeferredRefresh, listKey } from "~/state/list";

export type { Page };

const EMPTY: ReadonlySet<number> = new Set();

export const listLayout = (): boolean => useAppearance.getState().layout === "list";

export function pageOf(s: Pick<AppState, "compose" | "readerOpen" | "selectedId">, layout = useAppearance.getState().layout): Page {
  if (layout !== "list") return "list";
  return s.compose ? "compose" : s.readerOpen && s.selectedId !== null ? "thread" : "list";
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

/**
 * Opens a conversation. In List it becomes the page, and a multi-selection
 * ends (the page has no way to show it, and its actions must mean the open
 * thread only); a new message steps aside like it does for a click.
 */
export function openThread(id: number): void {
  const s = getApp();
  if (!listLayout()) return void setApp({ selectedId: id, readerOpen: true });
  if (s.compose) leaveNewDraft();
  setApp({ selectedId: id, readerOpen: true, anchorId: id, ...(s.checked.size || s.scope ? { checked: EMPTY, scope: null } : {}) });
}

/** focus goes back to the list once it shows again (Esc, Back, an action that took the thread away; not a sidebar click) */
let restoreFocus = false;
/** what had focus in the list when the page opened */
let returnTo: HTMLElement | null = null;

/** Back to the list (List only). The history follows (§2.3); `focus` puts focus back where it was in the list. */
export function closePage(options: { focus?: boolean } = {}): void {
  const s = getApp();
  // what's open, not what the page says: the cursor may already be gone (the list's last thread just archived)
  if (!listLayout() || (!s.readerOpen && !s.compose)) return;
  if (options.focus) restoreFocus = true;
  if (s.compose) leaveNewDraft();
  if (getApp().readerOpen) setApp({ readerOpen: false });
}

const listSection = () => document.querySelector<HTMLElement>("[data-list-section]");
const listbox = () => document.querySelector<HTMLElement>("[data-testid=thread-list] [role=listbox]");

function focusList() {
  const el = returnTo?.isConnected && returnTo.checkVisibility?.() !== false && !returnTo.closest("[inert]") ? returnTo : listbox();
  returnTo = null;
  el?.focus({ preventScroll: true });
}

let history: PageHistory | null = null;

// Another list under a page (a search from the palette, a sender's "more from", a folder or category while writing):
// the list shows, with its rows; a new message is left the way Esc leaves it (kept if written).
useApp.subscribe((s, p) => {
  const otherList = s.query !== p.query || s.view !== p.view || s.categoryId !== p.categoryId || s.accountId !== p.accountId || s.reviewCategoryId !== p.reviewCategoryId;
  if (otherList && (s.readerOpen || s.compose) && listLayout()) closePage();
});
// Split → List lands on the list (the cursor kept): Split's open thread is its cursor, not a page.
useAppearance.subscribe((s, p) => {
  if (s.layout === "list" && p.layout !== "list" && getApp().readerOpen) setApp({ readerOpen: false });
});

/** ⌘[ / the menu's Back / the mouse's back button. */
export function goBack(): void {
  if (!listLayout()) return;
  if (currentPage() !== "list") closePage({ focus: true });
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
    close: () => closePage({ focus: true }),
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
  const offApp = useApp.subscribe((s, p) => (s.compose !== p.compose || s.readerOpen !== p.readerOpen || s.selectedId !== p.selectedId ? onChange() : undefined));
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
 * Esc and ⌘[ (Ctrl+[ off Mac) go back from List's page there too, like ⌘L
 * and ⌘P are handed over (a menu accelerator covers ⌘[ on desktop anyway).
 */
export function forwardNavKey(e: KeyboardEvent): void {
  if (!listLayout() || currentPage() === "list" || e.defaultPrevented || e.isComposing) return;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const back = (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) || (e.key === "[" && mod && !e.altKey && !e.shiftKey);
  if (!back) return;
  e.preventDefault();
  closePage({ focus: true });
}

/** A mail frame's own document: its side buttons go back and forward too (desktop). */
export function forwardMouseNav(e: MouseEvent): void {
  if (!window.ternoDesktop || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault();
  if (e.button === 3) goBack();
  else goForward();
}

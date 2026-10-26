/**
 * Plan 24: the List layout's history. The page (list, a conversation, a new
 * message) is app state; the browser's history only mirrors it, so Back and
 * Forward (the browser's, ⌘[ / ⌘], the desktop menu, the mouse's side
 * buttons) work like they do on any site. Pure: the history, the timers and
 * what a traversal does to the app are injected, so every ordering is
 * unit-tested.
 *
 * The stack is the list (the base entry) and at most one Terno entry above
 * it. Leaving a page goes back over that entry rather than pushing the list
 * again, so Back never lands on a page twice. history.back() is
 * asynchronous: while one is on its way, a new page waits for its popstate
 * (or a fallback, when there was nothing to go back to).
 */

export type Page = "list" | "thread" | "compose";

/** What an entry carries (history.state). `list` and `mailbox` scope it: Forward never reopens a thread over another list, or another store. */
export interface EntryState {
  terno: 1;
  page: "thread" | "compose";
  id?: number;
  list: string;
  mailbox: string;
}

export interface HistoryLike {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url?: string): void;
  replaceState(state: unknown, unused: string, url?: string): void;
  back(): void;
}

export interface Shown {
  page: Page;
  id: number | null;
  /** the list it was opened over (listKey()) */
  list: string;
}

export interface PageHistoryDeps {
  history: HistoryLike;
  /** this document's mailbox: its path and query (the web's ?mailbox=, a demo's) */
  mailbox: string;
  /** location.hash now */
  hash(): string;
  /** a Forward to an entry that still applies: show that thread */
  open(id: number): void;
  /** a Back (or an entry that no longer applies): show the list */
  close(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** j/k between conversations replace the entry this long after the last move (Safari throws after 100 history calls in 30 s). */
export const REPLACE_DEBOUNCE_MS = 300;
/** a history.back() whose popstate never comes (nothing below it): the traversal is over anyway */
export const TRAVERSAL_FALLBACK_MS = 500;

export const BASE_URL = "#/";
export const threadUrl = (id: number): string => `#/thread/${id}`;
export const COMPOSE_URL = "#/compose";

/** A Terno entry of this mailbox, or null (another site's, another mailbox's, the base). */
export function entryOf(state: unknown, mailbox: string): EntryState | null {
  if (!state || typeof state !== "object") return null;
  const e = state as Partial<EntryState>;
  if (e.terno !== 1 || e.mailbox !== mailbox || typeof e.list !== "string") return null;
  if (e.page === "compose") return e as EntryState;
  if (e.page === "thread" && typeof e.id === "number" && Number.isSafeInteger(e.id) && e.id > 0) return e as EntryState;
  return null;
}

export interface PageHistory {
  /** the app's page changed (called on every change; transitions are worked out against what was last shown) */
  sync(next: Shown): void;
  /** the window's popstate */
  onPop(state: unknown, currentList: string): void;
  /** at boot, before the first list load: the thread to reopen (a reload on a conversation of this mailbox), or null */
  boot(currentList: string): number | null;
  /** for tests: what the machine believes is on screen, and whether a traversal is in flight */
  inspect(): { shown: Shown; traversing: boolean; pendingReplace: number | null };
}

export function createPageHistory(deps: PageHistoryDeps): PageHistory {
  const { history, mailbox } = deps;
  let shown: Shown = { page: "list", id: null, list: "" };
  /** a back() on its way: the generation it belongs to, and its fallback */
  let traversal: { gen: number; timer: unknown } | null = null;
  let gen = 0;
  /** what the app showed while a traversal was on its way: applied once it lands */
  let queued: Shown | null = null;
  let replace: { id: number; list: string; timer: unknown } | null = null;

  const entry = (s: Shown): EntryState => (s.page === "thread" ? { terno: 1, page: "thread", id: s.id!, list: s.list, mailbox } : { terno: 1, page: "compose", list: s.list, mailbox });
  const urlOf = (s: Shown) => (s.page === "thread" ? threadUrl(s.id!) : COMPOSE_URL);
  const ours = () => entryOf(history.state, mailbox) !== null;

  /** a pending replace: written now if it is still for the entry on top, else dropped */
  function flushReplace(write: boolean) {
    if (!replace) return;
    deps.clearTimer(replace.timer);
    const r = replace;
    replace = null;
    const top = entryOf(history.state, mailbox);
    if (write && top?.page === "thread") history.replaceState(entry({ page: "thread", id: r.id, list: r.list }), "", threadUrl(r.id));
  }

  function endTraversal() {
    if (!traversal) return;
    deps.clearTimer(traversal.timer);
    traversal = null;
    const next = queued;
    queued = null;
    if (next) apply(next);
  }

  function apply(next: Shown) {
    if (traversal) {
      // the back() hasn't landed: what's on top is still the entry it is leaving. The latest wish waits, whatever it is
      // (back on the list included: a page opened and closed meanwhile leaves nothing to push)
      queued = next;
      return;
    }
    const prev = shown;
    if (prev.page === next.page && prev.id === next.id) {
      shown = next;
      return;
    }
    shown = next;
    if (next.page === "list") {
      flushReplace(false);
      if (ours()) {
        const mine = ++gen;
        traversal = { gen: mine, timer: deps.setTimer(() => traversal?.gen === mine && endTraversal(), TRAVERSAL_FALLBACK_MS) };
        history.back();
      } else history.replaceState(null, "", BASE_URL);
      return;
    }
    if (prev.page === "list") {
      flushReplace(false);
      history.pushState(entry(next), "", urlOf(next));
      return;
    }
    if (next.page === "thread" && prev.page === "thread") {
      // j/k, an action's advance: one entry, written once the moves pause
      if (replace) deps.clearTimer(replace.timer);
      const r = { id: next.id!, list: next.list, timer: null as unknown };
      r.timer = deps.setTimer(() => replace === r && flushReplace(true), REPLACE_DEBOUNCE_MS);
      replace = r;
      return;
    }
    // a conversation becomes a new message or the other way round: the same entry (so leaving it always lands on the list)
    flushReplace(false);
    history.replaceState(entry(next), "", urlOf(next));
  }

  return {
    sync: apply,
    onPop(state, currentList) {
      if (traversal) {
        // the back() we asked for
        endTraversal();
        return;
      }
      flushReplace(false);
      const e = entryOf(state, mailbox);
      if (e?.page === "thread" && e.list === currentList) {
        shown = { page: "thread", id: e.id!, list: e.list };
        deps.open(e.id!);
        return;
      }
      // the base (Back), a new message's entry (its draft is in the strip), or an entry for another list: the list
      if (e) history.replaceState(null, "", BASE_URL);
      shown = { page: "list", id: null, list: currentList };
      deps.close();
    },
    boot(currentList) {
      const e = entryOf(history.state, mailbox);
      // a reload keeps the entry (and the base under it): a conversation comes back; anything else is the list
      if (e?.page === "thread") {
        shown = { page: "thread", id: e.id!, list: currentList };
        if (e.list !== currentList) history.replaceState(entry(shown), "", threadUrl(e.id!));
        return e.id!;
      }
      // a new message's entry, another list's, or a link typed in: the address goes back to the list's
      if (e || !/^#?\/?$/.test(deps.hash())) history.replaceState(null, "", BASE_URL);
      return null;
    },
    inspect: () => ({ shown, traversing: traversal !== null, pendingReplace: replace?.id ?? null }),
  };
}

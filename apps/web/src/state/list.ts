import type { ThreadSummary } from "@terno/core";
import { RpcError, type ThreadScope } from "@terno/core/rpc";
import { keepInPage } from "@terno/store/list";
import { prune } from "~/lib/selection";
import { activeFilter } from "~/lib/unread-filter";
import { matchesFilter } from "@terno/core";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp, getSelectionWriteRevision, setApp, setListAutoSelection, useApp } from "./app";

interface ListState {
  key: string;
  /** key of the query the current items belong to (set together with items) */
  itemsKey: string;
  items: ThreadSummary[];
  index: Map<number, number>;
  nextCursor: { lastDate: number; id: number } | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  searchMs: number | null;
  complete: boolean;
  /** the filtered mailbox's unread threads (the header's "No leídos · N"); null unfiltered, in a search, or until counted */
  unreadTotal: { key: string; n: number; capped: boolean } | null;
}

export const PAGE = 100;
/** the most rows one request brings back (a refresh of a longer window asks for it in pieces this size) */
const WINDOW_PAGE = 500;

/**
 * The list's first visible row, kept across a change of its rows (ThreadList
 * sets it): `capture` measures, the function it returns puts the row back.
 */
export const listAnchor: { capture?: () => (() => void) | void; firstVisible?: () => number | null; scrolled?: () => boolean } = {};
/** Does a same-list refresh keep the whole loaded window? List says yes (lib/page sets it); Split keeps its cap. */
export const refreshPolicy: { keepWindow: () => boolean } = { keepWindow: () => false };
/** how far past the loaded count a window refresh may read to find the rows that were on screen (new mail above them) */
const REACH = 1000;

export const useList = create<ListState>(() => ({
  key: "",
  itemsKey: "",
  items: [],
  index: new Map(),
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
  searchMs: null,
  complete: true,
  unreadTotal: null,
}));

function indexOf(items: ThreadSummary[]): Map<number, number> {
  return new Map(items.map((t, i) => [t.id, i]));
}

export function listKey(): string {
  const s = getApp();
  // the query stays last (the UI perf gate reads it from data-results-for)
  // plan 65: a folder goes before the query, only when there is one (every other list's key is as it was)
  return JSON.stringify([s.view, s.accountId, s.categoryId, s.reviewCategoryId, activeFilter(s) ?? null, ...(s.folder ? [s.folder] : []), s.query.trim()]);
}

let seq = 0;
/** optimistic edits so far: a reload or page that started before one answers with rows as they were */
let edits = 0;

/**
 * In a filtered list, the threads that stay whether read or not: the open
 * one and the checked ones (Mail keeps a message you read while it is
 * selected; it goes once the selection moves off it).
 */
export function keptIds(s = getApp()): number[] {
  if (!activeFilter(s)) return [];
  const ids = new Set(s.checked);
  if (s.selectedId !== null) ids.add(s.selectedId);
  return [...ids].slice(0, 500);
}

async function fetchPage(cursor?: { lastDate: number; id: number }, limit = PAGE) {
  const s = getApp();
  if (s.reviewCategoryId !== null) {
    // one bounded page of suggestions (each row carries its prediction)
    if (cursor) return { items: [], nextCursor: null };
    const { items } = await client.call("categorize.suggestions", { categoryId: s.reviewCategoryId, limit: 200 });
    return { items: items.map(({ prediction: _p, ...t }) => t), nextCursor: null };
  }
  const scope = currentScope()!;
  if (scope.kind === "search") return client.call("threads.search", { query: scope.query, cursor, limit, accountId: scope.accountId, categoryId: scope.categoryId, filter: scope.filter });
  const keepIds = scope.filter ? keptIds(s) : [];
  return client.call("threads.list", { view: scope.view, cursor, limit, accountId: scope.accountId, categoryId: scope.categoryId, folder: scope.folder, filter: scope.filter, keepIds: keepIds.length ? keepIds : undefined });
}

/**
 * A filtered answer's read rows, against who holds them now: asked for while
 * a thread was open, it may arrive after the selection moved off it.
 */
function heldOnly(items: ThreadSummary[]): ThreadSummary[] {
  const filter = activeFilter(getApp());
  if (items.every((t) => matchesFilter(filter, t))) return items;
  const held = new Set(keptIds());
  return items.filter((t) => matchesFilter(filter, t) || held.has(t.id));
}

/**
 * A filtered search can't ask the store to keep a thread (it is the query's
 * answer): the kept rows it showed stay as they were, at their place in the
 * loaded window. Their terms don't change by reading them; they go when the
 * selection moves.
 */
function keepSearchRows<P extends { items: ThreadSummary[]; nextCursor: { lastDate: number; id: number } | null }>(page: P, before: ThreadSummary[]): P {
  const kept = new Set(keptIds());
  if (kept.size === 0) return page;
  return { ...page, ...keepInPage(page, before.filter((t) => kept.has(t.id))) };
}


/** Every thread the current list shows, as a scope the backend can act on ("select all N"); null for "Revisar". */
export function currentScope(): ThreadScope | null {
  const s = getApp();
  if (s.reviewCategoryId !== null) return null;
  const filter = activeFilter(s);
  const q = s.query.trim();
  // plan 64: a search looks everywhere (every account, category and place, Spam and Trash too); in:, account:, category: narrow it
  if (q) return { kind: "search", query: q, ...(filter ? { filter } : {}) };
  // plan 65: a folder's list is its own (a search from it looks everywhere, as any search does)
  return { kind: "view", view: s.view, accountId: s.accountId ?? undefined, categoryId: s.categoryId ?? undefined, ...(filter ? { filter } : {}), ...(s.folder ? { folder: s.folder } : {}) };
}

/** Rows that left the view leave the selection (one write, only when something left). */
function pruneSelection(index: Map<number, number>): void {
  const s = getApp();
  const checked = prune(s.checked, index);
  const anchorGone = s.anchorId !== null && !index.has(s.anchorId);
  if (checked || anchorGone) setApp({ ...(checked ? { checked } : {}), ...(anchorGone ? { anchorId: null } : {}) });
}

/** (Re)loads the first page for the current view/search. Latest call wins. */
export async function reloadList(options: { keepSelection?: boolean; grow?: boolean; window?: boolean } = {}): Promise<void> {
  const key = listKey();
  const mine = ++seq;
  const selectionRevision = getSelectionWriteRevision();
  const current = useList.getState();
  const sameView = current.key === key;
  if (!sameView) {
    // another list: a page still on its way for the last one is no longer anyone's, and the next one may start
    pageSeq++;
    // and a refresh the last one was owed is this load
    deferred = false;
    // and its cursor goes with it: a page asked for before the new list's first answer would continue the old one
    useList.setState({ key, loading: true, error: null, loadingMore: false, nextCursor: null });
  }
  // keep as many rows as are loaded so a background refresh doesn't shrink the list
  const limit = sameView ? Math.min(Math.max(PAGE, current.items.length + (options.grow ? PAGE : 0)), WINDOW_PAGE) : PAGE;
  const editsAtStart = edits;
  const scope = currentScope();
  // the filtered mailbox's unread count, alongside the page (a search shows its own result count)
  const counting = scope?.kind === "view" && scope.filter === "unread" ? client.call("threads.scopeCount", { scope }).catch(() => null) : null;
  try {
    let page = await fetchPage(undefined, limit);
    if (mine !== seq) return;
    // plan 24, R4: the whole loaded window, however deep, in pieces (a refresh that waited behind a page must not shrink the list
    // under the cursor). In List every refresh of the same list does it (an undo, a bulk result, new mail); Split keeps its cap.
    const windowed = sameView && (options.window || refreshPolicy.keepWindow());
    if (windowed) {
      const want = current.items.length + (options.grow ? PAGE : 0);
      // the first row on screen and the cursor must be in it: mail that arrived above them pushed them further down
      const keep = [listAnchor.firstVisible?.() ?? null, getApp().selectedId].filter((id): id is number => id !== null && current.index.has(id));
      const missing = () => keep.some((id) => !page.items.some((t) => t.id === id));
      while ((page.items.length < want || missing()) && page.nextCursor && page.items.length < want + REACH) {
        const more = await fetchPage(page.nextCursor, page.items.length < want ? Math.min(WINDOW_PAGE, want - page.items.length) : WINDOW_PAGE);
        if (mine !== seq) return;
        page = { ...page, items: [...page.items, ...more.items], nextCursor: more.nextCursor };
      }
    }
    if (edits !== editsAtStart) {
      // an optimistic edit landed meanwhile: this answer may predate it (an archived row back, a read one unread)
      void reloadList({ ...options, keepSelection: true });
      if (sameView) return;
    }
    if (scope?.kind === "search" && scope.filter && (sameView || options.keepSelection)) page = keepSearchRows(page, current.items);
    if (scope?.filter) page = { ...page, items: heldOnly(page.items) };
    // the window refresh keeps the first visible row where it was (new mail above it doesn't push it down): always after a page
    // (Back finds what it left), and on the list unless it's at the very top (there, new mail shows as it arrives)
    const restore = windowed && (options.window || listAnchor.scrolled?.()) ? listAnchor.capture?.() : undefined;
    const commit = (fn: () => void) => (restore ? flushSync(fn) : fn());
    commit(() => useList.setState({
      key,
      itemsKey: key,
      items: page.items,
      index: indexOf(page.items),
      nextCursor: page.nextCursor,
      loading: false,
      error: null,
      searchMs: "tookMs" in page ? (page.tookMs as number) : null,
      complete: "complete" in page ? (page.complete as boolean) : true,
      ...(counting ? {} : { unreadTotal: null }),
    }));
    restore?.();
    if (counting)
      void counting.then((r) => {
        if (mine === seq && r) useList.setState({ unreadTotal: { key, n: r.count, capped: r.capped } });
      });
    pruneSelection(useList.getState().index);
    // the same for a first page that came back empty with more after it
    if (page.items.length === 0 && page.nextCursor) void loadMore();
    const s = getApp();
    if (!options.keepSelection && !sameView && mine === seq && key === listKey() && selectionRevision === getSelectionWriteRevision()) setListAutoSelection(page.items[0]?.id ?? null);
    else if (s.selectedId !== null && !page.items.some((t) => t.id === s.selectedId)) {
      // selected thread left this view (archived elsewhere): keep reader stable by not auto-jumping
    }
  } catch (error) {
    if (error instanceof RpcError && error.code === "CANCELLED") return;
    if (mine !== seq) return;
    useList.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** bumped when the list changes: a page that answers for an older list touches nothing (its loading flag was reset then) */
let pageSeq = 0;

/** the next page on its way: a second caller (Older while the list's own scrolling asked) waits for the same one */
let pendingMore: Promise<boolean> | null = null;

/** The next page. Resolves false when it failed (the caller may say so); true otherwise, nothing to load included. */
export function loadMore(): Promise<boolean> {
  if (pendingMore && useList.getState().loadingMore) return pendingMore;
  const p = loadNextPage();
  pendingMore = p;
  void p.finally(() => {
    if (pendingMore === p) pendingMore = null;
  });
  return p;
}

async function loadNextPage(): Promise<boolean> {
  const st = useList.getState();
  // nothing to continue until the list on screen is the one asked for (its first page is in)
  if (!st.nextCursor || st.loadingMore || st.loading || st.itemsKey !== st.key) return true;
  const key = st.key;
  const mine = pageSeq;
  const editsAtStart = edits;
  useList.setState({ loadingMore: true });
  try {
    const page = await fetchPage(st.nextCursor);
    if (mine !== pageSeq || useList.getState().key !== key) return true;
    if (edits !== editsAtStart) {
      // it may bring back a row an optimistic edit just took out: ask again from where the list ends now
      useList.setState({ loadingMore: false });
      return loadNextPage();
    }
    const seen = new Set(useList.getState().items.map((t) => t.id));
    const fresh = page.items.filter((t) => !seen.has(t.id));
    const items = [...useList.getState().items, ...(activeFilter(getApp()) ? heldOnly(fresh) : fresh)];
    useList.setState({ items, index: indexOf(items), nextCursor: page.nextCursor, loadingMore: false });
    // a filtered search may answer a page with nothing kept (and more after it): nothing on screen would ask for the next one
    if (fresh.length === 0 && page.nextCursor) void loadMore();
    return true;
  } catch (error) {
    if (mine !== pageSeq) return true;
    useList.setState({ loadingMore: false });
    // the mailbox changed since that page (a thread may have moved above it): refetch the loaded window and
    // the next page from the top instead of continuing a stale cursor
    if (error instanceof RpcError && error.code === "STALE" && useList.getState().key === key) {
      await reloadList({ keepSelection: true, grow: true });
      return true;
    }
    return false;
  }
}

/** each thread's latest optimistic edit (the edit count after it): a refetch older than it doesn't overwrite its row */
const editedAt = new Map<number, number>();
const EDITED_MAX = 5000;

/** Optimistic edits so far (a fetch started before one may predate it). */
export const editCount = (): number => edits;

/**
 * The open conversation's row, from its refreshed detail, while a page
 * covers the list and its refresh waits (Codex review): the reader's star and
 * read toggles decide from the row, so it must say what the reader shows.
 * Skipped when an optimistic edit landed after the fetch started.
 */
export function syncRow(t: Pick<ThreadSummary, "id" | "starred" | "unread" | "categoryIds">, since: number): void {
  if ((editedAt.get(t.id) ?? 0) > since) return;
  const st = useList.getState();
  const i = st.index.get(t.id);
  const row = i === undefined ? undefined : st.items[i];
  if (!row || (row.starred === t.starred && row.unread === t.unread && row.categoryIds.join() === t.categoryIds.join())) return;
  const items = st.items.slice();
  items[i!] = { ...row, starred: t.starred, unread: t.unread, categoryIds: t.categoryIds };
  useList.setState({ items });
}

/** a refresh that waited while a page covered the list (List layout) */
let deferred = false;

/**
 * The mailbox changed underneath (a backend `changed`): the list refreshes,
 * or, while a page covers it, once the list shows again (plan 24, R4: no
 * work for a list nobody sees, and its window and anchor survive).
 */
export function refreshList(covered: boolean): void {
  if (covered) {
    deferred = true;
    return;
  }
  // (List keeps its whole window on a same-list refresh: reloadList)
  void reloadList({ keepSelection: true });
}

/** The list shows again: the refresh it missed, over its whole loaded window. */
export function flushDeferredRefresh(): void {
  if (!deferred) return;
  deferred = false;
  void reloadList({ keepSelection: true, window: true });
}

/** Optimistic local edit of rows (actions apply instantly, then the backend confirms). */
export function patchRows(ids: readonly number[], patch: (t: ThreadSummary) => ThreadSummary | null): void {
  edits++;
  for (const id of ids.length <= EDITED_MAX ? ids : ids.slice(0, EDITED_MAX)) {
    editedAt.delete(id);
    editedAt.set(id, edits);
  }
  // bounded: the oldest marks go (a fetch that old has long answered)
  for (const id of editedAt.keys()) {
    if (editedAt.size <= EDITED_MAX) break;
    editedAt.delete(id);
  }
  const set = new Set(ids);
  let removed = false;
  const items = useList.getState().items.flatMap((t) => {
    if (!set.has(t.id)) return [t];
    const next = patch(t);
    removed ||= next === null;
    return next ? [next] : [];
  });
  const index = indexOf(items);
  useList.setState({ items, index });
  if (removed) pruneSelection(index);
}

// Any change of view / account / category / query reloads the list (navigation,
// search box, palette, shortcuts all just update app state).
useApp.subscribe((s, prev) => {
  if (s.view !== prev.view || s.accountId !== prev.accountId || s.categoryId !== prev.categoryId || s.folder !== prev.folder || s.reviewCategoryId !== prev.reviewCategoryId || s.query !== prev.query) {
    // "all N of that list" means nothing in another one
    if (s.scope) setApp({ scope: null });
    void reloadList();
  } else if (activeFilter(s) !== activeFilter(prev)) {
    // the same mailbox, filtered or not: the open thread stays open (and in the list, read or not)
    if (s.scope) setApp({ scope: null });
    void reloadList({ keepSelection: true });
  }
});

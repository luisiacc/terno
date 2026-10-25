import type { ThreadSummary, View } from "@terno/core";
import { RpcError, type ThreadScope } from "@terno/core/rpc";
import { keepInPage } from "@terno/store/list";
import { prune } from "~/lib/selection";
import { activeFilter } from "~/lib/unread-filter";
import { matchesFilter } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "./app";

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
  return JSON.stringify([s.view, s.accountId, s.categoryId, s.reviewCategoryId, activeFilter(s) ?? null, s.query.trim()]);
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
  return client.call("threads.list", { view: scope.view, cursor, limit, accountId: scope.accountId, categoryId: scope.categoryId, filter: scope.filter, keepIds: keepIds.length ? keepIds : undefined });
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

/** the sidebar view scopes the search unless the query says otherwise (in:…) */
const searchQuery = (q: string, view: View) => (/(^|\s)(in|en):/.test(q) || view === "all" ? q : `in:${view} ${q}`);

/** Every thread the current list shows, as a scope the backend can act on ("select all N"); null for "Revisar". */
export function currentScope(): ThreadScope | null {
  const s = getApp();
  if (s.reviewCategoryId !== null) return null;
  const filter = activeFilter(s);
  const narrow = { accountId: s.accountId ?? undefined, categoryId: s.categoryId ?? undefined, ...(filter ? { filter } : {}) };
  const q = s.query.trim();
  return q ? { kind: "search", query: searchQuery(q, s.view), ...narrow } : { kind: "view", view: s.view, ...narrow };
}

/** Rows that left the view leave the selection (one write, only when something left). */
function pruneSelection(index: Map<number, number>): void {
  const s = getApp();
  const checked = prune(s.checked, index);
  const anchorGone = s.anchorId !== null && !index.has(s.anchorId);
  if (checked || anchorGone) setApp({ ...(checked ? { checked } : {}), ...(anchorGone ? { anchorId: null } : {}) });
}

/** (Re)loads the first page for the current view/search. Latest call wins. */
export async function reloadList(options: { keepSelection?: boolean; grow?: boolean } = {}): Promise<void> {
  const key = listKey();
  const mine = ++seq;
  const current = useList.getState();
  const sameView = current.key === key;
  if (!sameView) useList.setState({ key, loading: true, error: null });
  // keep as many rows as are loaded so a background refresh doesn't shrink the list
  const limit = sameView ? Math.min(Math.max(PAGE, current.items.length + (options.grow ? PAGE : 0)), 500) : PAGE;
  const editsAtStart = edits;
  const scope = currentScope();
  // the filtered mailbox's unread count, alongside the page (a search shows its own result count)
  const counting = scope?.kind === "view" && scope.filter === "unread" ? client.call("threads.scopeCount", { scope }).catch(() => null) : null;
  try {
    let page = await fetchPage(undefined, limit);
    if (mine !== seq) return;
    if (edits !== editsAtStart) {
      // an optimistic edit landed meanwhile: this answer may predate it (an archived row back, a read one unread)
      void reloadList({ ...options, keepSelection: true });
      if (sameView) return;
    }
    if (scope?.kind === "search" && scope.filter && (sameView || options.keepSelection)) page = keepSearchRows(page, current.items);
    if (scope?.filter) page = { ...page, items: heldOnly(page.items) };
    useList.setState({
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
    });
    if (counting)
      void counting.then((r) => {
        if (mine === seq && r) useList.setState({ unreadTotal: { key, n: r.count, capped: r.capped } });
      });
    pruneSelection(useList.getState().index);
    const s = getApp();
    if (!options.keepSelection && !sameView) setApp({ selectedId: page.items[0]?.id ?? null });
    else if (s.selectedId !== null && !page.items.some((t) => t.id === s.selectedId)) {
      // selected thread left this view (archived elsewhere): keep reader stable by not auto-jumping
    }
  } catch (error) {
    if (error instanceof RpcError && error.code === "CANCELLED") return;
    if (mine !== seq) return;
    useList.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function loadMore(): Promise<void> {
  const st = useList.getState();
  if (!st.nextCursor || st.loadingMore) return;
  const key = st.key;
  const editsAtStart = edits;
  useList.setState({ loadingMore: true });
  try {
    const page = await fetchPage(st.nextCursor);
    if (useList.getState().key !== key) return;
    if (edits !== editsAtStart) {
      // it may bring back a row an optimistic edit just took out: ask again from where the list ends now
      useList.setState({ loadingMore: false });
      return void loadMore();
    }
    const seen = new Set(useList.getState().items.map((t) => t.id));
    const fresh = page.items.filter((t) => !seen.has(t.id));
    const items = [...useList.getState().items, ...(activeFilter(getApp()) ? heldOnly(fresh) : fresh)];
    useList.setState({ items, index: indexOf(items), nextCursor: page.nextCursor, loadingMore: false });
  } catch (error) {
    useList.setState({ loadingMore: false });
    // the mailbox changed since that page (a thread may have moved above it): refetch the loaded window and
    // the next page from the top instead of continuing a stale cursor
    if (error instanceof RpcError && error.code === "STALE" && useList.getState().key === key) await reloadList({ keepSelection: true, grow: true });
  }
}

/** Optimistic local edit of rows (actions apply instantly, then the backend confirms). */
export function patchRows(ids: readonly number[], patch: (t: ThreadSummary) => ThreadSummary | null): void {
  edits++;
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
  if (s.view !== prev.view || s.accountId !== prev.accountId || s.categoryId !== prev.categoryId || s.reviewCategoryId !== prev.reviewCategoryId || s.query !== prev.query) {
    // "all N of that list" means nothing in another one
    if (s.scope) setApp({ scope: null });
    void reloadList();
  } else if (activeFilter(s) !== activeFilter(prev)) {
    // the same mailbox, filtered or not: the open thread stays open (and in the list, read or not)
    if (s.scope) setApp({ scope: null });
    void reloadList({ keepSelection: true });
  }
});

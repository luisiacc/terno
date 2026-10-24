import type { ThreadSummary, View } from "@unica/core";
import { RpcError, type ThreadScope } from "@unica/core/rpc";
import { prune } from "~/lib/selection";
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
}));

function indexOf(items: ThreadSummary[]): Map<number, number> {
  return new Map(items.map((t, i) => [t.id, i]));
}

export function listKey(): string {
  const s = getApp();
  return JSON.stringify([s.view, s.accountId, s.categoryId, s.reviewCategoryId, s.query.trim()]);
}

let seq = 0;

async function fetchPage(cursor?: { lastDate: number; id: number }, limit = PAGE) {
  const s = getApp();
  if (s.reviewCategoryId !== null) {
    // one bounded page of suggestions (each row carries its prediction)
    if (cursor) return { items: [], nextCursor: null };
    const { items } = await client.call("categorize.suggestions", { categoryId: s.reviewCategoryId, limit: 200 });
    return { items: items.map(({ prediction: _p, ...t }) => t), nextCursor: null };
  }
  const scope = currentScope()!;
  if (scope.kind === "search") return client.call("threads.search", { query: scope.query, cursor, limit, accountId: scope.accountId, categoryId: scope.categoryId });
  return client.call("threads.list", { view: scope.view, cursor, limit, accountId: scope.accountId, categoryId: scope.categoryId });
}

/** the sidebar view scopes the search unless the query says otherwise (in:…) */
const searchQuery = (q: string, view: View) => (/(^|\s)(in|en):/.test(q) || view === "all" ? q : `in:${view} ${q}`);

/** Every thread the current list shows, as a scope the backend can act on ("select all N"); null for "Revisar". */
export function currentScope(): ThreadScope | null {
  const s = getApp();
  if (s.reviewCategoryId !== null) return null;
  const narrow = { accountId: s.accountId ?? undefined, categoryId: s.categoryId ?? undefined };
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
  try {
    const page = await fetchPage(undefined, limit);
    if (mine !== seq) return;
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
  useList.setState({ loadingMore: true });
  try {
    const page = await fetchPage(st.nextCursor);
    if (useList.getState().key !== key) return;
    const seen = new Set(useList.getState().items.map((t) => t.id));
    const items = [...useList.getState().items, ...page.items.filter((t) => !seen.has(t.id))];
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
  }
});

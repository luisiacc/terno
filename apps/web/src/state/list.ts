import type { ThreadSummary } from "@terno/core";
import { RpcError, type ThreadScope } from "@terno/core/rpc";
import { keepInPage } from "@terno/store/list";
import { followupsOffered } from "~/lib/ai";
import { prune } from "~/lib/selection";
import { activeFilter } from "~/lib/unread-filter";
import { DIGEST_ROW_ID, matchesFilter } from "@terno/core";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp, getSelectionWriteRevision, inPlainInbox, setApp, setListAutoSelection, useApp } from "./app";
import { noteRows, useActionRows } from "./action-preview";
import { flattenToday } from "./today";
import { useFollowups } from "./followups";
import { anyDue } from "./reminders";
import { anyPinned } from "./pins";

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
export const listAnchor: { capture?: () => (() => void) | void; firstVisible?: () => number | null; scrolled?: () => boolean; scrollAt?: () => ListScroll | null; scrollTo?: (at: ListScroll | null) => void } = {};
/** Where the list was scrolled: a row and how far into it, in rows (heights differ between lists); null: at the very top. */
export interface ListScroll {
  id: number;
  into: number;
}

/**
 * Plan 158: where each mailbox was left, so coming back (from a search, from another mailbox) finds the same thread open
 * and the same rows on screen. In memory, a few mailboxes.
 */
interface Place {
  selectedId: number | null;
  /** where it was in the list: what's nearest if that thread has gone since */
  at: number;
  scroll: ListScroll | null;
  /** rows loaded: what the first page must bring back for those rows to be there */
  rows: number;
}
const places = new Map<string, Place>();
const PLACES_MAX = 24;

/** A list's key, the same mailbox with or without its quick filter, or null for a search: results have no place to come back to. */
function placeKey(key: string): string | null {
  const parts = JSON.parse(key) as unknown[];
  if (parts.at(-1) !== "") return null;
  parts[4] = null;
  return JSON.stringify(parts);
}

function rememberPlace(selectedId: number | null): void {
  const st = useList.getState();
  if (!st.key || st.itemsKey !== st.key || st.items.length === 0) return;
  const key = placeKey(st.key);
  if (key === null) return;
  places.delete(key);
  places.set(key, { selectedId, at: selectedId === null ? 0 : (st.index.get(selectedId) ?? 0), scroll: listAnchor.scrollAt?.() ?? null, rows: st.items.length });
  if (places.size > PLACES_MAX) places.delete(places.keys().next().value!);
}

/** What a list's first page opens: where it was left, else its nearest row now, else the top. */
function openedOn(place: Place | undefined, items: readonly ThreadSummary[]): number | null {
  // plan 161: Today's first row is the digest's; a list opens on its first conversation, unless that's all there is
  if (!place || place.selectedId === null) return (items.find((t) => t.id !== DIGEST_ROW_ID) ?? items[0])?.id ?? null;
  const id = place.selectedId;
  return items.some((t) => t.id === id) ? id : (items[Math.min(place.at, items.length - 1)]?.id ?? null);
}

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
  // plan 68: a folder goes before the query, only when there is one (every other list's key is as it was)
  // plan 87: Reminders, only when it's that list (every other list's key is as it was)
  // plan 86: a Gmail tab likewise ("~promotions": never a folder's key)
  // plan 108: a search focused on an account looks only in it, so it's another list than the same search everywhere
  return JSON.stringify([s.view, s.accountId, s.categoryId, s.reviewCategoryId, activeFilter(s) ?? null, ...(s.folder ? [s.folder] : []), ...(s.gmailTab ? [`~${s.gmailTab}`] : []), ...(s.reminders ? ["reminders"] : []), ...(s.followups ? ["followups"] : []), ...(s.actionPreview ? [`action:${s.actionPreview}`] : []), ...(s.today ? ["today"] : []), ...(soloSearch(s) ? ["~solo"] : []), s.query.trim()]);
}

/** The search a list's key holds: what its rows answer to, whatever is being typed by now. Empty for a mailbox, Review or a preview. */
export function searchOfKey(key: string): string {
  if (!key) return "";
  const parts = JSON.parse(key) as unknown[];
  return parts[3] === null && !parts.some((p) => typeof p === "string" && p.startsWith("action:")) ? (parts.at(-1) as string) : "";
}

/** plan 108: a search while focused on an account: only that account's mail */
export function soloSearch(s: { soloAccountId: number | null; query: string }): boolean {
  return s.soloAccountId !== null && s.query.trim() !== "";
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

/**
 * The plain Inbox's top: first the pinned conversations (plan 179, newest pin
 * first), then those whose reminder is due (plan 87, newest due first) and the
 * follow-ups on top (plan 142), wherever they live. They lead the first page
 * and every later page leaves them out. One the user opened stays in the
 * Reminders part while it's open (its reminder ended), so it doesn't jump away
 * under the reader. `pinned`: how many of `ids` lead as pins.
 */
export interface InboxTop {
  ids: readonly number[];
  pinned: number;
  /** plan 179: how many conversations the Inbox holds, for its heading under the top (null: no top, or not counted) */
  total: { n: number; capped: boolean } | null;
}

/** The top of the list on screen: written only with the page it came with, once that page is the one shown. */
export const inboxTop: InboxTop = { ids: [], pinned: 0, total: null };

const NO_TOP: InboxTop = { ids: [], pinned: 0, total: null };

/**
 * A top row the Inbox shows only for its reminder (archived, or in a category
 * hidden from the Inbox): not one of "all N" of the Inbox (the backend's
 * scope doesn't have it), so a select-all neither checks nor acts on it.
 */
export function onlyOnTop(t: { id: number; inInbox?: boolean; categoryIds: readonly number[] }): boolean {
  if (!inboxTop.ids.includes(t.id)) return false;
  if (t.inInbox === false) return true;
  const hidden = getApp().categories.filter((c) => !c.showInInbox).map((c) => c.id);
  return t.categoryIds.some((id) => hidden.includes(id));
}

type Paged = { items: ThreadSummary[]; nextCursor: { lastDate: number; id: number } | null };

/**
 * The plain Inbox's first page with its top in front (`top` says what it is); the reader of the answer publishes it
 * (`inboxTop`) only if it shows that answer. Later pages come as they are: whoever joins them leaves the top's rows out.
 */
async function withTop<P extends Paged>(page: Promise<P>, first: boolean): Promise<P & { top?: InboxTop }> {
  const s = getApp();
  if (!first) return page;
  if (!inPlainInbox(s)) return { ...(await page), top: NO_TOP };
  const accountId = s.accountId ?? undefined;
  const pinning = anyPinned() ? client.call("pins.threads", { accountId }).then((r) => r.items, () => []) : Promise.resolve([]);
  const due = anyDue() ? client.call("reminders.threads", { dueOnly: true, accountId }).then((r) => r.items, () => []) : Promise.resolve([]);
  // plan 142: follow-ups have their own way onto the top, one row a thread under the same heading
  const followsOnTop = followupsOffered(getApp()) && useFollowups.getState().onTop > 0;
  const following = followsOnTop ? client.call("followups.threads", { onTop: true, accountId }).then((r) => r.items, () => []) : Promise.resolve([]);
  // plan 179: the Inbox's own count for its heading under the top, as "select all N" counts it; asked only when a top may lead
  const scope = currentScope();
  const counting = (anyPinned() || anyDue() || followsOnTop) && scope ? client.call("threads.scopeCount", { scope }).then((r) => ({ n: r.count, capped: r.capped }), () => null) : Promise.resolve(null);
  const [p, pinRows, dueRows, followRows, total] = await Promise.all([page, pinning, due, following, counting]);
  // a pinned one is in Pinned only, whatever else it has
  const pinnedIds = new Set(pinRows.map((t) => t.id));
  const reminding = [...dueRows, ...followRows.filter((t) => !dueRows.some((d) => d.id === t.id))].filter((t) => !pinnedIds.has(t.id));
  const held = heldInReminders(s.selectedId, pinnedIds);
  if (held && !reminding.some((t) => t.id === held.row.id)) reminding.splice(Math.min(held.at, reminding.length), 0, held.row);
  const rows = [...pinRows, ...reminding];
  const top: InboxTop = { ids: rows.map((t) => t.id), pinned: pinRows.length, total: rows.length ? total : null };
  if (rows.length === 0) return { ...p, top };
  const ids = new Set(top.ids);
  // the row as the page has it, when it's there (fresher than the top's read)
  const fresh = new Map(p.items.filter((t) => ids.has(t.id)).map((t) => [t.id, t]));
  return { ...p, items: [...rows.map((t) => fresh.get(t.id) ?? t), ...p.items.filter((t) => !ids.has(t.id))], top };
}

/**
 * The open conversation the Reminders part held (its reminder ended by opening it, plan 87), and where in that part:
 * only on the list on screen (never carried to another account's Inbox), and never once pinned (Pinned has it).
 * A row that left Pinned is never held: unpinning takes it to its place.
 */
function heldInReminders(selectedId: number | null, pinnedIds: ReadonlySet<number>): { row: ThreadSummary; at: number } | null {
  if (selectedId === null || pinnedIds.has(selectedId)) return null;
  const st = useList.getState();
  if (st.itemsKey !== listKey()) return null;
  const at = inboxTop.ids.indexOf(selectedId);
  if (at < inboxTop.pinned) return null;
  const row = st.items.find((t) => t.id === selectedId);
  return row ? { row, at: at - inboxTop.pinned } : null;
}

async function fetchPage(cursor?: { lastDate: number; id: number }, limit = PAGE) {
  const s = getApp();
  if (s.reminders) {
    // plan 87: one bounded page, soonest first
    if (cursor) return { items: [], nextCursor: null };
    const { items } = await client.call("reminders.threads", { dueOnly: false });
    return { items, nextCursor: null };
  }
  if (s.actionPreview) {
    const offset = cursor?.id ?? 0;
    const page = Math.min(limit, 500);
    const r = await client.call("ai.actionPage", { previewId: s.actionPreview, offset, limit: page, leftOut: useActionRows.getState().showLeftOut });
    // a page that answers after the preview ended (Cancel while Show was loading) notes nothing (Codex review)
    if (getApp().actionPreview === s.actionPreview) noteRows(r.items.map((t) => t.id), r.unticked, r.tags);
    return { items: r.items, nextCursor: offset + page < r.total ? { lastDate: 0, id: offset + page } : null };
  }
  if (s.today) {
    if (cursor) return { items: [], nextCursor: null };
    // the digest's row is the cursor's, not a thread's: nothing to keep, and no id the backend takes. The open one is held
    // only when it's one of these rows: holding keeps a row you're on, never adds one (a newsletter opened from the
    // digest is read as any mail is, and isn't Today's: the owner, plan 161)
    const open = s.selectedId !== null && s.selectedId !== 0 && useList.getState().index.has(s.selectedId) ? [s.selectedId] : [];
    const held = new Set([...s.checked, ...open]);
    const list = await client.call("today.list", { heldIds: [...held].slice(0, 500) });
    return { items: flattenToday(list, useList.getState().items), nextCursor: null };
  }
  if (s.followups) {
    if (cursor) return { items: [], nextCursor: null };
    const { items } = await client.call("followups.threads", { onTop: false });
    return { items, nextCursor: null };
  }
  if (s.reviewCategoryId !== null) {
    // one bounded page of suggestions (each row carries its prediction)
    if (cursor) return { items: [], nextCursor: null };
    const { items } = await client.call("categorize.suggestions", { categoryId: s.reviewCategoryId, limit: 200 });
    return { items: items.map(({ prediction: _p, ...t }) => t), nextCursor: null };
  }
  const scope = currentScope()!;
  if (scope.kind === "search") return client.call("threads.search", { query: scope.query, cursor, limit, accountId: scope.accountId, categoryId: scope.categoryId, filter: scope.filter });
  const keepIds = scope.filter ? keptIds(s) : [];
  return withTop(client.call("threads.list", { view: scope.view, cursor, limit, accountId: scope.accountId, categoryId: scope.categoryId, folder: scope.folder, tab: scope.tab, filter: scope.filter, keepIds: keepIds.length ? keepIds : undefined }), !cursor);
}

/**
 * A filtered answer's read rows, against who holds them now: asked for while
 * a thread was open, it may arrive after the selection moved off it.
 */
function heldOnly(items: ThreadSummary[], top: readonly number[] = inboxTop.ids): ThreadSummary[] {
  const filter = activeFilter(getApp());
  if (items.every((t) => matchesFilter(filter, t))) return items;
  // plans 87, 179: the Inbox's top stays under any quick filter
  const held = new Set([...keptIds(), ...top]);
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
  // Revisar, Reminders: lists of their own, no "select all N"
  if (s.reviewCategoryId !== null || s.reminders || s.followups || s.today || s.actionPreview) return null;
  const filter = activeFilter(s);
  const q = s.query.trim();
  // plan 64: a search looks everywhere (every account, category and place, Spam and Trash too); in:, account:, category: narrow it
  // plan 108: focused on an account, a search looks only in it
  if (q) return { kind: "search", query: q, ...(s.soloAccountId !== null ? { accountId: s.soloAccountId } : {}), ...(filter ? { filter } : {}) };
  // plan 68: a folder's list is its own (a search from it looks everywhere, as any search does)
  return { kind: "view", view: s.view, accountId: s.accountId ?? undefined, categoryId: s.categoryId ?? undefined, ...(filter ? { filter } : {}), ...(s.folder ? { folder: s.folder } : {}), ...(s.gmailTab ? { tab: s.gmailTab } : {}) };
}

/** Rows that left the view leave the selection (one write, only when something left). */
function pruneSelection(index: Map<number, number>): void {
  const s = getApp();
  const checked = prune(s.checked, index);
  const anchorGone = s.anchorId !== null && !index.has(s.anchorId);
  if (checked || anchorGone) setApp({ ...(checked ? { checked } : {}), ...(anchorGone ? { anchorId: null } : {}) });
}

/** (Re)loads the first page for the current view/search. Latest call wins. */
export async function reloadList(options: { keepSelection?: boolean; grow?: boolean; window?: boolean; keepWindow?: boolean } = {}): Promise<void> {
  const key = listKey();
  const mine = ++seq;
  const connection = client.connectionVersion;
  const selectionRevision = getSelectionWriteRevision();
  const openAtStart = getApp().selectedId;
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
  const placeOf = placeKey(key);
  const place = !sameView && !options.keepSelection && placeOf !== null ? places.get(placeOf) : undefined;
  const limit = sameView ? Math.min(Math.max(PAGE, current.items.length + (options.grow ? PAGE : 0)), WINDOW_PAGE) : place ? Math.min(Math.max(PAGE, place.rows), WINDOW_PAGE) : PAGE;
  const editsAtStart = edits;
  const scope = currentScope();
  // the filtered mailbox's unread count, alongside the page (a search shows its own result count)
  const counting = scope?.kind === "view" && scope.filter === "unread" ? client.call("threads.scopeCount", { scope }).catch(() => null) : null;
  try {
    let page = await fetchPage(undefined, limit);
    if (mine !== seq || connection !== client.connectionVersion) return;
    // the top this answer brings (none but the plain Inbox's): published with its rows below, never before. Pages joined to
    // it leave its rows out as they arrive, so what the window counts is rows it shows (Codex review)
    const top = ("top" in page && page.top) || NO_TOP;
    const onTop = new Set(top.ids);
    const join = (more: Paged) => ({ ...page, items: [...page.items, ...(onTop.size ? more.items.filter((t) => !onTop.has(t.id)) : more.items)], nextCursor: more.nextCursor });
    // plan 24, R4: the whole loaded window, however deep, in pieces (a refresh that waited behind a page must not shrink the list
    // under the cursor). In List every refresh of the same list does it (an undo, a bulk result, new mail); Split keeps its cap,
    // unless asked to keep it (`keepWindow`: the window, without moving to its anchor)
    const windowed = sameView && (options.window || options.keepWindow || refreshPolicy.keepWindow());
    if (windowed) {
      const want = current.items.length + (options.grow ? PAGE : 0);
      // the first row on screen and the cursor must be in it: mail that arrived above them pushed them further down
      const keep = [listAnchor.firstVisible?.() ?? null, getApp().selectedId].filter((id): id is number => id !== null && current.index.has(id));
      const missing = () => keep.some((id) => !page.items.some((t) => t.id === id));
      while ((page.items.length < want || missing()) && page.nextCursor && page.items.length < want + REACH) {
        const more = await fetchPage(page.nextCursor, page.items.length < want ? Math.min(WINDOW_PAGE, want - page.items.length) : WINDOW_PAGE);
        if (mine !== seq || connection !== client.connectionVersion) return;
        page = join(more);
      }
    }
    if (place) {
      // a mailbox left deep in its rows: as far as they were, and a little past it for mail that arrived above them
      const left = [place.scroll?.id, place.selectedId].filter((id): id is number => id != null);
      while (left.some((id) => !page.items.some((t) => t.id === id)) && page.nextCursor && page.items.length < place.rows + REACH) {
        const more = await fetchPage(page.nextCursor, WINDOW_PAGE);
        if (mine !== seq || connection !== client.connectionVersion) return;
        page = join(more);
      }
    }
    if (edits !== editsAtStart) {
      // an optimistic edit landed meanwhile: this answer may predate it (an archived row back, a read one unread)
      void reloadList({ ...options, keepSelection: true });
      if (sameView) return;
    }
    // Today holds the open row only while it's one of the list's rows: one opened while this page was on its way wasn't
    // held by it, and would leave and never come back. Ask again, holding it (Codex review, plan 161)
    const open = getApp().selectedId;
    if (sameView && getApp().today && open !== openAtStart && open !== null && open !== 0 && current.index.has(open) && !page.items.some((t) => t.id === open)) {
      void reloadList({ ...options, keepSelection: true });
      return;
    }
    if (scope?.kind === "search" && scope.filter && (sameView || options.keepSelection)) page = keepSearchRows(page, current.items);
    if (scope?.filter) page = { ...page, items: heldOnly(page.items, top.ids) };
    // the window refresh keeps the first visible row where it was (new mail above it doesn't push it down): always after a page
    // (Back finds what it left), and on the list unless it's at the very top (there, new mail shows as it arrives)
    const restore = windowed && (options.window || listAnchor.scrolled?.()) ? listAnchor.capture?.() : undefined;
    // another list starts where it was left, or at its top, in the commit that shows it
    const arrives = !sameView && !options.keepSelection;
    const commit = (fn: () => void) => (restore || arrives ? flushSync(fn) : fn());
    commit(() => {
      inboxTop.ids = top.ids;
      inboxTop.pinned = top.pinned;
      inboxTop.total = top.total;
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
    });
    restore?.();
    if (arrives) listAnchor.scrollTo?.(place?.scroll ?? null);
    if (counting)
      void counting.then((r) => {
        if (mine === seq && connection === client.connectionVersion && r) useList.setState({ unreadTotal: { key, n: r.count, capped: r.capped } });
      });
    pruneSelection(useList.getState().index);
    // the same for a first page that came back empty with more after it
    if (page.items.length === 0 && page.nextCursor) void loadMore();
    const s = getApp();
    if (!options.keepSelection && !sameView && mine === seq && key === listKey() && selectionRevision === getSelectionWriteRevision()) setListAutoSelection(openedOn(place, page.items));
    else if (s.selectedId !== null && !page.items.some((t) => t.id === s.selectedId)) {
      // selected thread left this view (archived elsewhere): keep reader stable by not auto-jumping
    }
  } catch (error) {
    if (error instanceof RpcError && error.code === "CANCELLED") return;
    if (mine !== seq || connection !== client.connectionVersion) return;
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
  const connection = client.connectionVersion;
  const editsAtStart = edits;
  useList.setState({ loadingMore: true });
  try {
    const page = await fetchPage(st.nextCursor);
    if (connection !== client.connectionVersion || mine !== pageSeq || useList.getState().key !== key) return true;
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
    if (connection !== client.connectionVersion || mine !== pageSeq) return true;
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

/** Retire cursors and pending publications from the previous transport. */
export function invalidateListConnection(): void {
  seq++;
  pageSeq++;
  pendingMore = null;
  useList.setState({ loading: false, loadingMore: false, nextCursor: null, unreadTotal: null, error: null });
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

/** plan 107: a rename being followed (an object property: memory note react-compiler-module-let) */
export const followedRename: { from: string | null; to: string | null } = { from: null, to: null };

// Any change of view / account / category / query reloads the list (navigation,
// search box, palette, shortcuts all just update app state).
useApp.subscribe((s, prev) => {
  // plan 107 (Codex code review #7): the folder you're in renamed (an IMAP one gets a new key) is the same mailbox:
  // the open thread, the reader and the checked rows stay
  const followed = s.folder !== prev.folder && followedRename.from === prev.folder && followedRename.to === s.folder && s.view === prev.view && s.accountId === prev.accountId && s.query === prev.query;
  if (followed) {
    // the same rows under the new key, the window and the checked rows as they are (Codex code review round 2 #5):
    // the backend carried the folder's threads over, the next refresh reads them there
    const key = listKey();
    // a page or reload asked under the old key is no one's now (round 7 #3: it would return without clearing
    // loadingMore, and paging would stop); the next one asks under the new key from the same cursor
    pageSeq++;
    seq++;
    pendingMore = null;
    useList.setState((l) => ({ key, itemsKey: l.itemsKey === l.key ? key : l.itemsKey, loadingMore: false, loading: false }));
    if (s.scope) setApp({ scope: null });
  } else if (s.view !== prev.view || s.accountId !== prev.accountId || s.categoryId !== prev.categoryId || s.folder !== prev.folder || s.gmailTab !== prev.gmailTab || s.reviewCategoryId !== prev.reviewCategoryId || s.reminders !== prev.reminders || s.followups !== prev.followups || s.today !== prev.today || s.actionPreview !== prev.actionPreview || s.query !== prev.query || soloSearch(s) !== soloSearch(prev)) {
    // "all N of that list" means nothing in another one
    if (s.scope) setApp({ scope: null });
    rememberPlace(prev.selectedId);
    void reloadList();
  } else if (activeFilter(s) !== activeFilter(prev)) {
    // the same mailbox, filtered or not: the open thread stays open (and in the list, read or not)
    if (s.scope) setApp({ scope: null });
    void reloadList({ keepSelection: true });
  }
});

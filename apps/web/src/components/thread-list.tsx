import { Input } from "@terno/ui/components/input";
import { Kbd } from "@terno/ui/components/kbd";
import { Skeleton } from "@terno/ui/components/skeleton";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Inbox, ListFilter, Search, SquarePen, X } from "lucide-react";
import { cn } from "@terno/ui/lib/utils";
import { isUnreadOnly } from "~/lib/unread-filter";
import { toggleUnreadFilter } from "~/lib/unread";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { openCompose } from "~/lib/actions";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { Suspense, useEffect, useRef, useState } from "react";
import { VIEW_LABEL } from "~/lib/format";
import { getApp, setApp, useApp } from "~/state/app";
import { installDragController } from "~/lib/drag-install";
import { currentScope, listKey, loadMore, useList } from "~/state/list";
import { clearSelection, selectScope } from "~/lib/select";
import { client } from "~/rpc/connection";
import { useSnack } from "~/lib/snack";
import { ThreadMenu } from "./thread-menu";
import { DraftsStrip } from "./drafts-strip";
import { ROW_HEIGHT, ThreadRow } from "./thread-row";
import { LearnedBanner } from "./learned-banner";
import { ReportRow } from "./diag/report-row";
import { DesktopBanner, GmailReconnect } from "~/lib/web-parts";

export const searchInputRef: { current: HTMLInputElement | null } = { current: null };
export const listScroller: { scrollToIndex?: (i: number) => void } = {};

/** the header's filter button, where focus goes when the empty state's "Clear filter" disappears */
export const unreadFilterButton: { current: HTMLButtonElement | null } = { current: null };

/** Mail's message filter: a quiet icon off, the accent on. */
function UnreadFilterButton({ active }: { active: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={(el) => {
              unreadFilterButton.current = el;
            }}
            data-testid="unread-filter"
            data-active={active || undefined}
            variant="ghost"
            size="icon-sm"
            aria-label="Filter by unread"
            aria-pressed={active}
            className={cn("no-drag shrink-0 text-muted-foreground hover:text-foreground", active && "text-primary hover:text-primary")}
            onClick={toggleUnreadFilter}
          >
            <ListFilter />
          </Button>
        }
      />
      <TooltipContent>
        {active ? "Show all" : "Show unread only"} <Shortcut keys="mod+l" />
      </TooltipContent>
    </Tooltip>
  );
}

/** "Filtered by: Unread · N" under the title (N: the mailbox's unread threads; a search shows its own count). */
function FilterStatus({ search }: { search: boolean }) {
  const total = useList((s) => (s.unreadTotal && s.unreadTotal.key === s.key ? s.unreadTotal : null));
  const n = !search && total && total.n > 0 ? ` · ${total.n.toLocaleString("en-US")}${total.capped ? "+" : ""}` : "";
  return (
    <p data-testid="unread-filter-status" className="truncate text-2xs leading-tight text-muted-foreground tabular">
      Filtered by: <span className="text-foreground">Unread</span>
      {n}
    </p>
  );
}

function Header({ hairlineRef }: { hairlineRef: React.Ref<HTMLDivElement> }) {
  const view = useApp((s) => s.view);
  const category = useApp((s) => s.categories.find((c) => c.id === s.categoryId));
  const review = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const account = useApp((s) => s.accounts.find((a) => a.id === s.accountId));
  const query = useApp((s) => s.query);
  const searchMs = useList((s) => s.searchMs);
  const more = useList((s) => s.nextCursor !== null);
  const complete = useList((s) => s.complete);
  const unreadOnly = useApp(isUnreadOnly);
  // a filtered search counts what matched, not the read rows it kept in place
  const count = useList((s) => (unreadOnly ? s.items.reduce((n, t) => n + (t.unread ? 1 : 0), 0) : s.items.length));
  const title = review ? `Revisar · ${review.name}` : (category?.name ?? VIEW_LABEL[view]);

  return (
    <div ref={hairlineRef} data-testid="list-header" className="drag-region scroll-hairline shrink-0 px-3 pb-2">
      <div className="flex h-[52px] items-center gap-2 pl-1">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold tracking-tight" data-testid="list-title">
            {title}
            {account && <span className="ml-1.5 text-sm font-normal tracking-normal text-muted-foreground">· {account.displayName}</span>}
          </h1>
          {unreadOnly && <FilterStatus search={query.trim() !== ""} />}
        </div>
        {query && searchMs !== null && (
          <span data-testid="search-stats" className="shrink-0 text-2xs text-muted-foreground tabular">
            {count}
            {more ? "+" : ""} resultados · {searchMs < 1 ? "<1" : Math.round(searchMs)} ms{!complete && " · indexando"}
          </span>
        )}
        {!review && <UnreadFilterButton active={unreadOnly} />}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button data-testid="compose-button" variant="ghost" size="icon-sm" aria-label="Escribir" className="no-drag shrink-0 text-muted-foreground hover:text-foreground" onClick={() => openCompose("new")}>
                <SquarePen />
              </Button>
            }
          />
          <TooltipContent>
            Escribir <Shortcut keys="c" />
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="no-drag relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={(el) => {
            searchInputRef.current = el;
          }}
          data-testid="search-input"
          value={query}
          placeholder="Buscar en todas tus cuentas"
          className="h-[30px] rounded-lg border-0 bg-tint pr-14 pl-8 text-sm shadow-none dark:bg-tint"
          onChange={(e) => {
            setApp({ query: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (getApp().query) setApp({ query: "" });
              e.currentTarget.blur();
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              e.currentTarget.blur();
            }
          }}
        />
        {query ? (
          <button
            type="button"
            aria-label="Limpiar búsqueda"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => setApp({ query: "" })}
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
        )}
      </div>
    </div>
  );
}

/**
 * Gmail's "select all": ⌘A checks the loaded rows; when the view has more,
 * this offers every thread of it, which the backend then acts on (a scope).
 */
function SelectAllBanner() {
  const loaded = useList((s) => s.items.length);
  const more = useList((s) => s.nextCursor !== null);
  const all = useApp((s) => s.checked.size > 0 && s.checked.size >= loaded);
  const scope = useApp((s) => s.scope);
  const view = useApp((s) => s.view);
  const category = useApp((s) => s.categories.find((c) => c.id === s.categoryId)?.name);
  const query = useApp((s) => s.query.trim());
  const unreadOnly = useApp(isUnreadOnly);
  const show = scope !== null || (all && more && loaded > 0);
  const [count, setCount] = useState<{ key: string; n: number; capped: boolean } | null>(null);
  const key = show ? listKey() : "";
  useEffect(() => {
    if (!show || count?.key === key) return;
    const scopeNow = currentScope();
    if (!scopeNow) return;
    let alive = true;
    void client.call("threads.scopeCount", { scope: scopeNow }).then((r) => alive && setCount({ key, n: r.count, capped: r.capped }), () => {});
    return () => {
      alive = false;
    };
  }, [show, key]);
  if (!show || (!scope && !currentScope())) return null;
  const label = `«${query || (category ?? VIEW_LABEL[view])}${unreadOnly ? " · Unread" : ""}»`;
  const n = count?.key === key ? count : null;
  const fmt = (x: number) => x.toLocaleString("es-MX");
  return (
    <div data-testid="select-all-banner" className="hairline-b flex shrink-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 bg-tint px-3 py-1.5 text-center text-xs text-muted-foreground">
      {scope ? (
        <>
          <span data-testid="select-all-scope">
            Las {fmt(scope.count)} conversaciones de {scope.label} están seleccionadas.
          </span>
          <button type="button" data-testid="select-all-clear" className="font-medium text-primary hover:underline" onClick={clearSelection}>
            Deshacer la selección
          </button>
        </>
      ) : (
        <>
          <span>Las {fmt(loaded)} conversaciones cargadas están seleccionadas.</span>
          <button
            type="button"
            data-testid="select-all-scope-button"
            disabled={!n || n.capped}
            className="font-medium text-primary hover:underline disabled:opacity-60"
            onClick={() => n && selectScope(n.n)}
          >
            {n ? (n.capped ? `Más de ${fmt(n.n)} en ${label}: acota la búsqueda` : `Seleccionar las ${fmt(n.n)} conversaciones de ${label}`) : `Seleccionar todas las de ${label}…`}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * A filtered mailbox with nothing unread. Drawn over the empty listbox, not
 * inside it (a button isn't an option); after "Clear filter" focus goes to
 * the header's filter button, which stays.
 */
function UnreadEmptyState() {
  const search = useApp((s) => s.query.trim() !== "");
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-8 text-center" data-testid="unread-empty">
      <ListFilter className="mb-2 size-7 stroke-[1.25] text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold tracking-tight">{search ? "No unread results" : "No unread conversations"}</p>
      <p className="text-xs text-muted-foreground">{search ? "Everything that matches has been read." : "You’re all caught up."}</p>
      <Button
        data-testid="unread-empty-clear"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={() => {
          toggleUnreadFilter();
          unreadFilterButton.current?.focus();
        }}
      >
        Clear filter
      </Button>
    </div>
  );
}

function EmptyState() {
  const query = useApp((s) => s.query);
  const view = useApp((s) => s.view);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
      <Inbox className="mb-2 size-7 stroke-[1.25] text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold tracking-tight">{query ? "Sin resultados" : view === "inbox" ? "Bandeja vacía" : "Nada por aquí"}</p>
      <p className="text-xs text-muted-foreground">
        {query ? "Prueba con from:, subject:, has:adjunto o quita filtros." : view === "inbox" ? "Disfruta el silencio." : "Los correos aparecerán aquí."}
      </p>
    </div>
  );
}

export function ThreadList() {
  const items = useList((s) => s.items);
  const loading = useList((s) => s.loading);
  const itemsKey = useList((s) => s.itemsKey);
  const compact = useApp((s) => s.settings?.density === "compact");
  const composing = useApp((s) => s.compose !== null);
  const showAccount = useApp((s) => s.accountId === null && s.accounts.length > 1);
  const unreadOnly = useApp(isUnreadOnly);
  const height = compact ? ROW_HEIGHT.compact : ROW_HEIGHT.comfortable;
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // the docked snackbar sits over the last rows: the list keeps room below them, and j/k stop above it
  const dock = useSnack((s) => s.inset);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => height,
    overscan: 10,
    getItemKey: (i) => items[i]!.id,
    paddingEnd: dock,
    scrollPaddingEnd: dock,
  });

  // the dock came up over the open thread's row: it moves up into view, once (after the padded spacer is in)
  useEffect(() => {
    const el = parentRef.current;
    const id = getApp().selectedId;
    const i = id === null ? undefined : useList.getState().index.get(id);
    if (!dock || !el || i === undefined) return;
    const row = virtualizer.measurementsCache[i];
    const bottom = el.scrollTop + el.clientHeight;
    if (row && row.end > bottom - dock && row.start < bottom) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [dock]);

  useEffect(() => {
    const [root, sentinel, header] = [parentRef.current, sentinelRef.current, headerRef.current];
    return root && sentinel && header ? installScrollHairline(root, sentinel, header) : undefined;
  }, []);

  // drag rows onto sidebar categories: one delegated listener on the listbox
  useEffect(() => (parentRef.current ? installDragController(parentRef.current) : undefined), []);

  useEffect(() => {
    listScroller.scrollToIndex = (i) => virtualizer.scrollToIndex(i, { align: "auto" });
  }, [virtualizer]);

  // the open thread is the listbox's active descendant; set on the element directly so moving it renders nothing
  useEffect(() => {
    const point = (id: number | null) => {
      const el = parentRef.current;
      if (!el) return;
      if (id === null) el.removeAttribute("aria-activedescendant");
      else el.setAttribute("aria-activedescendant", `thread-${Math.trunc(id)}`);
    };
    point(getApp().selectedId);
    return useApp.subscribe((s, prev) => s.selectedId !== prev.selectedId && point(s.selectedId));
  }, []);

  // the filter toggled (the same mailbox and query otherwise): the open thread, kept, comes into view
  const shownKey = useRef(itemsKey);
  useEffect(() => {
    const was = shownKey.current;
    shownKey.current = itemsKey;
    if (!was || !itemsKey || was === itemsKey) return;
    const [a, b] = [JSON.parse(was) as unknown[], JSON.parse(itemsKey) as unknown[]];
    // [view, account, category, review, unreadOnly, query]: only the filter differs
    if (a[4] === b[4] || JSON.stringify([...a.slice(0, 4), a[5]]) !== JSON.stringify([...b.slice(0, 4), b[5]])) return;
    const i = useList.getState().index.get(getApp().selectedId ?? -1);
    if (i !== undefined) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [itemsKey]);

  const virtualItems = virtualizer.getVirtualItems();
  const last = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (last && last.index >= items.length - 40) void loadMore();
  }, [last?.index, items.length]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-pane" data-testid="thread-list" data-results-for={itemsKey} data-composing={composing || undefined}>
      <Header hairlineRef={headerRef} />
      <ReportRow />
      <LearnedBanner />
      {DesktopBanner && GmailReconnect && (
        <Suspense>
          <GmailReconnect />
          <DesktopBanner />
        </Suspense>
      )}
      <SelectAllBanner />
      <DraftsStrip />
      <div className="relative flex min-h-0 flex-1 flex-col">
      <ThreadMenu>
      <div ref={parentRef} role="listbox" aria-label="Conversaciones" aria-multiselectable className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain [contain:strict]">
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        {loading && items.length === 0 ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          !unreadOnly && <EmptyState />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((v) => (
              <ThreadRow key={v.key} thread={items[v.index]!} top={v.start} height={height} compact={compact} showAccount={showAccount} />
            ))}
          </div>
        )}
      </div>
      </ThreadMenu>
      {unreadOnly && !loading && items.length === 0 && itemsKey === listKey() && <UnreadEmptyState />}
      </div>
    </section>
  );
}

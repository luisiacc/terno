import { Input } from "@unica/ui/components/input";
import { Kbd } from "@unica/ui/components/kbd";
import { Skeleton } from "@unica/ui/components/skeleton";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { VIEW_LABEL } from "~/lib/format";
import { getApp, setApp, useApp } from "~/state/app";
import { loadMore, reloadList, useList } from "~/state/list";
import { ROW_HEIGHT, ThreadRow } from "./thread-row";
import { LearnedBanner } from "./learned-banner";

export const searchInputRef: { current: HTMLInputElement | null } = { current: null };
export const listScroller: { scrollToIndex?: (i: number) => void } = {};

function Header() {
  const view = useApp((s) => s.view);
  const category = useApp((s) => s.categories.find((c) => c.id === s.categoryId));
  const account = useApp((s) => s.accounts.find((a) => a.id === s.accountId));
  const query = useApp((s) => s.query);
  const searchMs = useList((s) => s.searchMs);
  const count = useList((s) => s.items.length);
  const more = useList((s) => s.nextCursor !== null);
  const complete = useList((s) => s.complete);
  const title = category?.name ?? VIEW_LABEL[view];

  return (
    <div className="drag-region shrink-0 border-b border-border px-3 pt-2.5 pb-2">
      <div className="mb-2 flex h-6 items-baseline justify-between px-1">
        <h1 className="truncate text-[15px] font-semibold tracking-tight" data-testid="list-title">
          {title}
          {account && <span className="ml-1.5 text-sm font-normal text-muted-foreground">· {account.displayName}</span>}
        </h1>
        {query && searchMs !== null && (
          <span data-testid="search-stats" className="font-mono text-2xs text-muted-foreground tabular">
            {count}
            {more ? "+" : ""} resultados · {searchMs < 1 ? "<1" : Math.round(searchMs)} ms{!complete && " · indexando"}
          </span>
        )}
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
          className="h-8 bg-muted/60 pr-14 pl-8 text-sm"
          onChange={(e) => {
            setApp({ query: e.target.value });
            void reloadList();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (getApp().query) {
                setApp({ query: "" });
                void reloadList();
              }
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
            onClick={() => {
              setApp({ query: "" });
              void reloadList();
            }}
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

function EmptyState() {
  const query = useApp((s) => s.query);
  const view = useApp((s) => s.view);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
      <p className="text-sm font-medium">{query ? "Sin resultados" : view === "inbox" ? "Bandeja vacía" : "Nada por aquí"}</p>
      <p className="text-xs text-muted-foreground">
        {query ? "Prueba con from:, subject:, has:adjunto o quita filtros." : view === "inbox" ? "Disfruta el silencio." : "Los correos aparecerán aquí."}
      </p>
    </div>
  );
}

export function ThreadList() {
  const items = useList((s) => s.items);
  const loading = useList((s) => s.loading);
  const compact = useApp((s) => s.settings?.density === "compact");
  const showAccount = useApp((s) => s.accountId === null && s.accounts.length > 1);
  const height = compact ? ROW_HEIGHT.compact : ROW_HEIGHT.comfortable;
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => height,
    overscan: 10,
    getItemKey: (i) => items[i]!.id,
  });

  useEffect(() => {
    listScroller.scrollToIndex = (i) => virtualizer.scrollToIndex(i, { align: "auto" });
  }, [virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const last = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (last && last.index >= items.length - 40) void loadMore();
  }, [last?.index, items.length]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-pane" data-testid="thread-list">
      <Header />
      <LearnedBanner />
      <div ref={parentRef} role="listbox" aria-label="Conversaciones" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain [contain:strict]">
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
          <EmptyState />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((v) => (
              <ThreadRow key={v.key} thread={items[v.index]!} top={v.start} height={height} compact={compact} showAccount={showAccount} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

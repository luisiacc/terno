import { Input } from "@unica/ui/components/input";
import { Kbd } from "@unica/ui/components/kbd";
import { Skeleton } from "@unica/ui/components/skeleton";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Inbox, Search, SquarePen, X } from "lucide-react";
import { Button } from "@unica/ui/components/button";
import { Shortcut } from "@unica/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@unica/ui/components/tooltip";
import { openCompose } from "~/lib/actions";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { Suspense, useEffect, useRef, useState } from "react";
import { VIEW_LABEL } from "~/lib/format";
import { getApp, setApp, useApp } from "~/state/app";
import { installDragController } from "~/lib/drag-install";
import { currentScope, listKey, loadMore, useList } from "~/state/list";
import { clearSelection, selectScope } from "~/lib/select";
import { client } from "~/rpc/connection";
import { ThreadMenu } from "./thread-menu";
import { DraftsStrip } from "./drafts-strip";
import { ROW_HEIGHT, ThreadRow } from "./thread-row";
import { LearnedBanner } from "./learned-banner";
import { DesktopBanner, GmailReconnect } from "~/lib/web-parts";

export const searchInputRef: { current: HTMLInputElement | null } = { current: null };
export const listScroller: { scrollToIndex?: (i: number) => void } = {};

function Header({ hairlineRef }: { hairlineRef: React.Ref<HTMLDivElement> }) {
  const view = useApp((s) => s.view);
  const category = useApp((s) => s.categories.find((c) => c.id === s.categoryId));
  const review = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const account = useApp((s) => s.accounts.find((a) => a.id === s.accountId));
  const query = useApp((s) => s.query);
  const searchMs = useList((s) => s.searchMs);
  const count = useList((s) => s.items.length);
  const more = useList((s) => s.nextCursor !== null);
  const complete = useList((s) => s.complete);
  const title = review ? `Revisar · ${review.name}` : (category?.name ?? VIEW_LABEL[view]);

  return (
    <div ref={hairlineRef} className="drag-region scroll-hairline shrink-0 px-3 pb-2">
      <div className="flex h-[52px] items-center gap-2 pl-1">
        <h1 className="min-w-0 flex-1 truncate text-md font-semibold tracking-tight" data-testid="list-title">
          {title}
          {account && <span className="ml-1.5 text-sm font-normal tracking-normal text-muted-foreground">· {account.displayName}</span>}
        </h1>
        {query && searchMs !== null && (
          <span data-testid="search-stats" className="shrink-0 text-2xs text-muted-foreground tabular">
            {count}
            {more ? "+" : ""} resultados · {searchMs < 1 ? "<1" : Math.round(searchMs)} ms{!complete && " · indexando"}
          </span>
        )}
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
  const label = query ? `«${query}»` : `«${category ?? VIEW_LABEL[view]}»`;
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
  const height = compact ? ROW_HEIGHT.compact : ROW_HEIGHT.comfortable;
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => height,
    overscan: 10,
    getItemKey: (i) => items[i]!.id,
  });

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

  const virtualItems = virtualizer.getVirtualItems();
  const last = virtualItems[virtualItems.length - 1];
  useEffect(() => {
    if (last && last.index >= items.length - 40) void loadMore();
  }, [last?.index, items.length]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-pane" data-testid="thread-list" data-results-for={itemsKey} data-composing={composing || undefined}>
      <Header hairlineRef={headerRef} />
      <LearnedBanner />
      {DesktopBanner && GmailReconnect && (
        <Suspense>
          <GmailReconnect />
          <DesktopBanner />
        </Suspense>
      )}
      <SelectAllBanner />
      <DraftsStrip />
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
          <EmptyState />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((v) => (
              <ThreadRow key={v.key} thread={items[v.index]!} top={v.start} height={height} compact={compact} showAccount={showAccount} />
            ))}
          </div>
        )}
      </div>
      </ThreadMenu>
    </section>
  );
}

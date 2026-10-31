import { folderName } from "~/lib/account-folders";
import { Input } from "@terno/ui/components/input";
import { Kbd } from "@terno/ui/components/kbd";
import { Skeleton } from "@terno/ui/components/skeleton";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Inbox, ListFilter, Search, SquarePen, X } from "lucide-react";
import { cn } from "@terno/ui/lib/utils";
import { activeFilter } from "~/lib/unread-filter";
import { setListFilter } from "~/lib/unread";
import { matchesFilter, type ListFilter as QuickFilter } from "@terno/core";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { openCompose } from "~/lib/actions";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { formatNumber, t } from "@terno/i18n";
import { viewLabel } from "~/lib/format";
import { getApp, setApp, useApp } from "~/state/app";
import { installDragController } from "~/lib/drag-install";
import { currentScope, listKey, loadMore, useList } from "~/state/list";
import { clearSelection, selectScope } from "~/lib/select";
import { scopeLabel } from "~/lib/selection";
import { client } from "~/rpc/connection";
import { useSnack } from "~/lib/snack";
import { ThreadMenu } from "./thread-menu";
import { DraftsStrip } from "./drafts-strip";
import { ReviewAlwaysMenu } from "./review-actions";
import { ThreadRow } from "./thread-row";
import { registerDesignAnchor, useDesign } from "~/lib/design";
import { LearnedBanner } from "./learned-banner";
import { ReportRow } from "./diag/report-row";
import { DesktopBanner } from "~/lib/web-parts";
import { preloadComposer } from "./composer/lazy";
import { iconsAllowed, iconsAllowedForList } from "~/lib/sender-icons";
import { useAppearance } from "~/lib/appearance";
import { selectedTab, tabsShown } from "~/lib/tabs";
import { listAnchor } from "~/state/list";
import { ListTabs, TAB_PANEL_ID } from "./list-tabs";
import { SelectionBar } from "./selection-bar";
import { renderProbe } from "~/lib/render-probe";

export const searchInputRef: { current: HTMLInputElement | null } = { current: null };
export const listScroller: { scrollToIndex?: (i: number) => void } = {};

/** A virtualized-out option cannot be the listbox's active descendant. */
function pointListCursor(el: HTMLElement | null, id: number | null) {
  if (!el) return;
  const option = id === null ? null : el.ownerDocument.getElementById(`thread-${Math.trunc(id)}`);
  if (option && el.contains(option)) el.setAttribute("aria-activedescendant", option.id);
  else el.removeAttribute("aria-activedescendant");
}

/** The quick filters' control in effect: List's tabs carry All and Unread, so every design keeps the filter button there (plan 24 §2.7). */
function useQuickFilters(): "menu" | "chips" {
  const design = useDesign();
  const list = useAppearance((s) => s.layout === "list");
  return list ? "menu" : design.variants.quickFilters;
}

/** The scroller is wide enough for one-line rows (List only; 16 px of hysteresis so a width near the line doesn't flip back and forth). */
export const WIDE_MIN = 720;
export function nextWide(wide: boolean, width: number): boolean {
  return wide ? width >= WIDE_MIN - 16 : width >= WIDE_MIN;
}

/** the header's filter button, where focus goes when the empty state's "Clear filter" disappears */
export const unreadFilterButton: { current: HTMLButtonElement | null } = { current: null };

/** Mail's message filter: a quiet icon off, the accent on (any filter); a click turns it off, or on as Unread. */
function UnreadFilterButton({ filter }: { filter: QuickFilter | undefined }) {
  const active = filter !== undefined;
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
            aria-label={t("list.unreadFilter.label")}
            aria-pressed={active}
            className={cn("no-drag shrink-0 text-muted-foreground hover:text-foreground", active && "text-primary hover:text-primary")}
            onClick={() => setListFilter(active ? undefined : "unread")}
          >
            <ListFilter />
          </Button>
        }
      />
      <TooltipContent>
        {active ? t("list.unreadFilter.showAll") : t("list.unreadFilter.showUnread")} <Shortcut keys="mod+l" />
      </TooltipContent>
    </Tooltip>
  );
}

const FILTER_NAME = {
  unread: "list.filter.unread",
  people: "list.filter.people",
  waiting: "list.filter.waiting",
  attachments: "list.filter.attachments",
  starred: "list.filter.starred",
} as const satisfies Record<QuickFilter, string>;

/** A filter's name, at render time (the active language). */
function filterName(f: QuickFilter): string {
  return t(FILTER_NAME[f]);
}

/**
 * "Filtered by: Unread · N" under the title (N: the mailbox's unread threads;
 * a search shows its own count). Like Mail, the criterion is a menu: unread,
 * with attachments, starred.
 */
function FilterStatus({ search, filter }: { search: boolean; filter: QuickFilter }) {
  const total = useList((s) => (s.unreadTotal && s.unreadTotal.key === s.key ? s.unreadTotal : null));
  const view = useApp((s) => s.view);
  const supported = useApp((s) => s.supportedFilters);
  const n = filter === "unread" && !search && total && total.n > 0 ? `${formatNumber(total.n)}${total.capped ? "+" : ""}` : null;
  return (
    <p data-testid="unread-filter-status" className="flex min-w-0 items-center truncate text-2xs leading-tight text-muted-foreground tabular">
      {t("list.filter.by")}{" "}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button type="button" data-testid="filter-criterion" className="no-drag ml-1 inline-flex items-center gap-0.5 rounded-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
              {filterName(filter)}
              <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuRadioGroup value={filter} onValueChange={(v) => setListFilter(v as QuickFilter)}>
            {supported.filter((f) => !(f === "starred" && view === "starred")).map((f) => (
              <DropdownMenuRadioItem key={f} value={f} closeOnClick data-testid={`filter-option-${f}`}>
                {filterName(f)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {n && <span className="whitespace-pre"> · {n}</span>}
    </p>
  );
}

/**
 * Lumen: the filters as chips under the header (one choice; arrow keys move
 * between them). Waiting has a chip only while it is on: it is reached from
 * the greeting's count (or the palette), and the row stays five chips long.
 */
function QuickChips({ filter }: { filter: QuickFilter | undefined }) {
  const view = useApp((s) => s.view);
  const supported = useApp((s) => s.supportedFilters);
  const chips = (["all", ...supported] as const).filter((f) => !(f === "starred" && view === "starred") && (f !== "waiting" || filter === "waiting"));
  return (
    <ToggleGroup
      data-testid="quick-filters"
      aria-label={t("list.filter.label")}
      value={[filter ?? "all"]}
      onValueChange={(v: string[]) => v[0] && setListFilter(v[0] === "all" ? undefined : (v[0] as QuickFilter))}
      spacing={1.5}
      className="no-drag -mx-1 mt-1 mb-2 flex w-auto max-w-full overflow-x-auto px-1 py-0.5 [scrollbar-width:none]"
    >
      {chips.map((f) => (
        <ToggleGroupItem
          key={f}
          value={f}
          data-testid={`quick-filter-${f}`}
          onFocus={(e) => e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
          className="h-7 shrink-0 rounded-full bg-muted px-3 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground data-pressed:bg-primary data-pressed:text-primary-foreground"
        >
          {f === "all" ? t("list.filter.all") : filterName(f)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * Search behind a button (Lumen): open while asked for or while there's a
 * query. It closes on Esc in an empty field, on its button (which clears the
 * query too), or when another mailbox opens with nothing typed; never on blur, so focus that leaves for a moment (F6 to
 * the snack, a menu) comes back to it.
 */
const useSearchOpen = create<{ open: boolean }>(() => ({ open: false }));
useApp.subscribe((s, prev) => {
  if (useSearchOpen.getState().open && !s.query && (s.view !== prev.view || s.categoryId !== prev.categoryId || s.accountId !== prev.accountId || s.folder !== prev.folder || s.reviewCategoryId !== prev.reviewCategoryId)) useSearchOpen.setState({ open: false });
});

/** "/" and ⌘F: the search field, opened first where the design keeps it behind a button. */
export function focusSearch(): void {
  if (!searchInputRef.current) flushSync(() => useSearchOpen.setState({ open: true }));
  searchInputRef.current?.focus();
}

/** The search button: opens the field, or, while it shows, clears the query and closes it. */
function toggleSearch(): void {
  if (!searchInputRef.current) return focusSearch();
  if (getApp().query) setApp({ query: "" });
  useSearchOpen.setState({ open: false });
}

function SearchField({ autoCollapse }: { autoCollapse: boolean }) {
  const query = useApp((s) => s.query);
  const review = useApp((s) => s.reviewCategoryId !== null);
  const [focused, setFocused] = useState(false);
  const showCoverage = !review && (focused || query.trim() !== "");
  return (
    <>
      <div className="no-drag relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={(el) => {
            searchInputRef.current = el;
          }}
          data-testid="search-input"
          value={query}
          placeholder={t("list.search.placeholder")}
          aria-label={t("list.search.placeholder")}
          aria-describedby={showCoverage ? "search-coverage" : undefined}
          className="h-[30px] rounded-lg border-0 bg-tint pr-14 pl-8 text-sm shadow-none dark:bg-tint"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setApp({ query: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (getApp().query) setApp({ query: "" });
              else if (autoCollapse) {
                // an empty field behind a button closes, and focus goes back to the button
                useSearchOpen.setState({ open: false });
                requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-testid=search-button]")?.focus());
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
            aria-label={t("list.search.clear")}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => setApp({ query: "" })}
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
        )}
      </div>
      {showCoverage && <p id="search-coverage" data-testid="search-coverage" className="no-drag mt-1.5 text-2xs text-muted-foreground">{t("list.search.coverage")}</p>}
    </>
  );
}

/**
 * The waiting count's window moves with the clock (plan 17): it is asked for
 * again at the greeting's day-part boundaries and when the window comes
 * back, besides every change. No timer of its own.
 */
function refreshCounts(): void {
  void client.call("counts.get", {}).then((counts) => setApp({ counts }), () => {});
}

/** The part of the day a greeting names, re-read at its next boundary and when the window comes back (no polling). */
type DayPart = "morning" | "afternoon" | "evening";
function useDayPart(): DayPart {
  const part = (): DayPart => {
    const h = new Date().getHours();
    return h >= 5 && h < 12 ? "morning" : h >= 12 && h < 19 ? "afternoon" : "evening";
  };
  const [now, setNow] = useState(part);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      const d = new Date();
      const next = [5, 12, 19, 29].map((h) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime() + h * 3_600_000).find((t) => t > d.getTime())!;
      timer = setTimeout(() => {
        setNow(part());
        refreshCounts();
        schedule();
      }, next - d.getTime() + 1000);
    };
    const onVisible = () => {
      setNow(part());
      if (document.visibilityState === "visible") refreshCounts();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return now;
}

function Greeting() {
  const part = useDayPart();
  const first = useApp((s) => s.owner?.displayName.trim().split(/\s+/)[0] ?? "");
  const key = part === "morning" ? "list.greeting.morning" : part === "afternoon" ? "list.greeting.afternoon" : "list.greeting.evening";
  return <>{first ? t(key, { name: first }) : t(`${key}Plain` as const)}</>;
}

/**
 * "M waiting for your reply" in the greeting (plan 17): a toggle for the
 * Waiting filter. Absent while the store doesn't know yet (its backfill), or
 * an older backend doesn't say.
 */
function useWaitingCount(): number | null {
  return useApp((s) => {
    if (!s.supportedFilters.includes("waiting") || s.counts.inboxWaiting == null) return null;
    return s.accountId !== null ? (s.counts.inboxWaitingByAccount?.[s.accountId] ?? 0) : s.counts.inboxWaiting;
  });
}

/** Under a display title or the greeting: what's unread here (the filter's status when it's on); the greeting adds what waits for your reply. */
function Subtitle({ filter, search, greeting }: { filter: QuickFilter | undefined; search: boolean; greeting: boolean }) {
  const quick = useQuickFilters();
  const unread = useApp((s) =>
    s.reviewCategoryId !== null ? null : s.categoryId !== null ? (s.counts.categoryUnread[s.categoryId] ?? 0) : s.view === "inbox" ? (s.accountId !== null ? (s.counts.inboxUnreadByAccount[s.accountId] ?? 0) : s.counts.inboxUnread) : null,
  );
  const counted = useWaitingCount();
  const waiting = greeting && counted ? counted : 0;
  if (filter && quick === "menu")
    return (
      <div className="mt-1.5">
        <FilterStatus search={search} filter={filter} />
      </div>
    );
  if (unread === null) return null;
  return (
    <p data-testid="list-subtitle" className="type-list-subtitle mt-1 truncate text-muted-foreground tabular">
      {unread > 0 && <span className="type-list-subtitle-strong text-unread-ink">{t("list.unreadCount", { count: unread })}</span>}
      {unread > 0 && waiting > 0 && <span aria-hidden> · </span>}
      {waiting > 0 && (
        <button
          type="button"
          data-testid="waiting-count"
          aria-pressed={filter === "waiting"}
          className="no-drag rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring aria-pressed:underline"
          onClick={() => setListFilter(filter === "waiting" ? undefined : "waiting")}
        >
          {t("list.waitingCount", { count: waiting })}
        </button>
      )}
      {unread === 0 && waiting === 0 && t("list.caughtUp")}
    </p>
  );
}

function Header({ hairlineRef }: { hairlineRef: React.Ref<HTMLDivElement> }) {
  const view = useApp((s) => s.view);
  const category = useApp((s) => s.categories.find((c) => c.id === s.categoryId));
  const folder = useApp(folderName);
  const review = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const account = useApp((s) => s.accounts.find((a) => a.id === s.accountId));
  const query = useApp((s) => s.query);
  const searchMs = useList((s) => s.searchMs);
  const more = useList((s) => s.nextCursor !== null);
  const complete = useList((s) => s.complete);
  const filter = useApp(activeFilter);
  const design = useDesign();
  const searchOpen = useSearchOpen((s) => s.open);
  // a filtered search counts what matched, not the rows it kept in place
  const count = useList((s) => (filter ? s.items.reduce((n, t) => n + (matchesFilter(filter, t) ? 1 : 0), 0) : s.items.length));
  // plan 64: a search looks everywhere, so the list is the search's, not the sidebar mailbox's
  const searching = query.trim() !== "" && !review;
  const title = searching ? t("list.search.title") : review ? t("list.reviewTitle", { category: review.name }) : (folder ?? category?.name ?? viewLabel(view));
  // the greeting is the inbox's title (any account); everywhere else a design that greets shows its display title
  const kind = design.variants.listHeader === "greeting" && view === "inbox" && !category && !review && !searching ? "greeting" : design.variants.listHeader === "title" ? "title" : "display";
  const behindButton = design.variants.search === "button";
  const quick = useQuickFilters();
  const list = useAppearance((s) => s.layout === "list");
  const tabs = useApp((s) => list && tabsShown(s));
  const showField = !behindButton || searchOpen || query !== "";
  const stats = query && searchMs !== null && (
    <span data-testid="search-stats" className="shrink-0 text-2xs text-muted-foreground tabular">
      {t(complete ? "list.search.stats" : "list.search.statsIndexing", {
        results: more ? t("list.search.resultsMore", { count }) : t("list.search.results", { count }),
        ms: searchMs < 1 ? "<1" : Math.round(searchMs),
      })}
    </span>
  );
  const actions = (
    <>
      {!review && quick === "menu" && <UnreadFilterButton filter={filter} />}
      {behindButton && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button data-testid="search-button" variant="ghost" size="icon-sm" aria-label={t("common.search")} aria-expanded={showField} className="no-drag shrink-0 rounded-full text-muted-foreground hover:text-foreground" onClick={toggleSearch}>
                <Search />
              </Button>
            }
          />
          <TooltipContent>
            {t("common.search")} <Shortcut keys="/" />
          </TooltipContent>
        </Tooltip>
      )}
      {design.variants.compose === "list-header" && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button data-testid="compose-button" onPointerEnter={preloadComposer} onFocus={preloadComposer} variant="ghost" size="icon-sm" aria-label={t("list.compose")} className="no-drag shrink-0 text-muted-foreground hover:text-foreground" onClick={() => openCompose("new")}>
                <SquarePen />
              </Button>
            }
          />
          <TooltipContent>
            {t("list.compose")} <Shortcut keys="c" />
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
  const accountSuffix = account && !searching && <span className="ml-1.5 text-sm font-normal tracking-normal text-muted-foreground not-italic">· {account.displayName}</span>;

  return (
    <div ref={hairlineRef} data-testid="list-header" data-kind={kind} className="drag-region scroll-hairline shrink-0 px-3 pb-2">
      {kind === "title" ? (
        <div className="flex h-[52px] items-center gap-2 pl-1">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-md font-semibold tracking-tight" data-testid="list-title">
              {title}
              {accountSuffix}
            </h1>
            {filter && <FilterStatus search={query.trim() !== ""} filter={filter} />}
          </div>
          {stats}
          {actions}
        </div>
      ) : (
        <div className="flex items-start gap-2 pt-5 pb-3 pl-2">
          <div className="min-w-0 flex-1">
            <h1 className={cn("truncate", kind === "greeting" ? "type-greeting" : "type-list-title")} data-testid="list-title">
              {kind === "greeting" ? <Greeting /> : title}
              {kind !== "greeting" && accountSuffix}
            </h1>
            {query && searchMs !== null ? <p className="mt-1">{stats}</p> : <Subtitle filter={filter} search={query.trim() !== ""} greeting={kind === "greeting"} />}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 pt-0.5">{actions}</div>
        </div>
      )}
      {showField && <SearchField autoCollapse={behindButton} />}
      {!review && quick === "chips" && <QuickChips filter={filter} />}
      {tabs && <ListTabs />}
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
  const category = useApp((s) => folderName(s) ?? s.categories.find((c) => c.id === s.categoryId)?.name);
  const query = useApp((s) => s.query.trim());
  const filter = useApp(activeFilter);
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
  const label = t("list.scope.quoted", { label: scopeLabel(query || (category ?? viewLabel(view)), filter) });
  const n = count?.key === key ? count : null;
  return (
    <div data-testid="select-all-banner" className="hairline-b flex shrink-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 bg-tint px-3 py-1.5 text-center text-xs text-muted-foreground">
      {scope ? (
        <>
          <span data-testid="select-all-scope">
            {t("list.selectAll.scopeSelected", { count: scope.count, label: scope.label })}
          </span>
          <button type="button" data-testid="select-all-clear" className="font-medium text-primary hover:underline" onClick={clearSelection}>
            {t("list.selectAll.clear")}
          </button>
        </>
      ) : (
        <>
          <span>{t("list.selectAll.loadedSelected", { count: loaded })}</span>
          <button
            type="button"
            data-testid="select-all-scope-button"
            disabled={!n || n.capped}
            className="font-medium text-primary hover:underline disabled:opacity-60"
            onClick={() => n && selectScope(n.n)}
          >
            {n ? (n.capped ? t("list.selectAll.capped", { count: n.n, label }) : t("list.selectAll.select", { count: n.n, label })) : t("list.selectAll.pending", { label })}
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
/** An empty filtered list's title and line, per criterion; a search says what didn't match. */
function emptyCopy(filter: QuickFilter, search: boolean): [string, string] {
  switch (filter) {
    case "unread":
      return search ? [t("list.unreadEmpty.searchTitle"), t("list.unreadEmpty.searchBody")] : [t("list.unreadEmpty.title"), t("list.unreadEmpty.body")];
    case "people":
      return search ? [t("list.filterEmpty.searchTitle"), t("list.filterEmpty.peopleSearchBody")] : [t("list.filterEmpty.peopleTitle"), t("list.filterEmpty.peopleBody")];
    case "waiting":
      return search ? [t("list.filterEmpty.searchTitle"), t("list.filterEmpty.waitingSearchBody")] : [t("list.filterEmpty.waitingTitle"), t("list.filterEmpty.waitingBody")];
    case "attachments":
      return search ? [t("list.filterEmpty.searchTitle"), t("list.filterEmpty.attachmentsSearchBody")] : [t("list.filterEmpty.attachmentsTitle"), t("list.filterEmpty.attachmentsBody")];
    case "starred":
      return search ? [t("list.filterEmpty.searchTitle"), t("list.filterEmpty.starredSearchBody")] : [t("list.filterEmpty.starredTitle"), t("list.filterEmpty.starredBody")];
  }
}

function UnreadEmptyState({ filter }: { filter: QuickFilter }) {
  const search = useApp((s) => s.query.trim() !== "");
  const [title, body] = emptyCopy(filter, search);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-8 text-center" data-testid="unread-empty" data-filter={filter}>
      <ListFilter className="mb-2 size-7 stroke-[1.25] text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold tracking-tight">{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
      <Button
        data-testid="unread-empty-clear"
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={() => {
          setListFilter(undefined);
          // the filter's control stays: the header button, or Lumen's "All" chip
          (unreadFilterButton.current ?? document.querySelector<HTMLElement>("[data-testid=quick-filter-all]"))?.focus();
        }}
      >
        {t("list.unreadEmpty.clear")}
      </Button>
    </div>
  );
}

/**
 * An empty list has no row to carry its focus (and draws no ring, plan 52): keyboard focus moves to a visible
 * control instead, the empty state's own action first, else the view it is in.
 */
function leaveEmptyList() {
  const visible = (el: HTMLElement | null) => (el && el.checkVisibility?.() !== false && !el.closest("[inert]") ? el : null);
  // (scrolling allowed: a sidebar scrolled past its current view brings it back into sight with the focus)
  (visible(document.querySelector<HTMLElement>("[data-testid=unread-empty-clear]")) ?? visible(document.querySelector<HTMLElement>("#app-sidebar button[data-active]")))?.focus();
}

function EmptyState() {
  const query = useApp((s) => s.query);
  const view = useApp((s) => s.view);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
      <Inbox className="mb-2 size-7 stroke-[1.25] text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold tracking-tight">{query ? t("list.empty.searchTitle") : view === "inbox" ? t("list.empty.inboxTitle") : t("list.empty.title")}</p>
      <p className="text-xs text-muted-foreground">
        {query ? t("list.empty.searchBody") : view === "inbox" ? t("list.empty.inboxBody") : t("list.empty.body")}
      </p>
    </div>
  );
}

export function ThreadList() {
  renderProbe("ThreadList");
  const items = useList((s) => s.items);
  const loading = useList((s) => s.loading);
  const itemsKey = useList((s) => s.itemsKey);
  const compact = useApp((s) => s.settings?.density === "compact");
  const composing = useApp((s) => s.compose !== null);
  // results can span accounts: any search (it looks everywhere), or a mailbox of every account
  const showAccount = useApp((s) => (s.accountId === null || (s.query.trim() !== "" && s.reviewCategoryId === null)) && s.accounts.length > 1);
  // plan 22: no sender icons in spam (no request to a spammer's site, no borrowed logo on a phish), the view or a search in it
  const iconsHere = useApp((s) => iconsAllowed(s.view, s.query));
  // and the rows on screen allow them too (leaving Spam, its rows stay until the new ones arrive)
  const icons = iconsHere && iconsAllowedForList(itemsKey);
  const filter = useApp(activeFilter);
  const design = useDesign();
  // plan 24: List's full-width list draws one-line rows once its scroller is wide enough for them
  const list = useAppearance((s) => s.layout === "list");
  const [wideEnough, setWideEnough] = useState(false);
  const wide = list && wideEnough;
  const height = wide && !compact ? design.rows.wide : design.rows[compact ? "compact" : "comfortable"];
  const layout = design.variants.row;
  const many = useApp((s) => s.scope !== null || s.checked.size >= 2);
  // plan 80: a category's Review list, whose rows answer its suggestions
  const review = useApp((s) => s.reviewCategoryId);
  const tabs = useApp((s) => list && tabsShown(s));
  const tab = useApp(selectedTab);
  const parentRef = useRef<HTMLDivElement>(null);
  // a Tab stop only with rows to carry the focus (a loading skeleton has none); handed on only once truly empty
  const empty = !loading && items.length === 0;
  useEffect(() => {
    if (empty && document.activeElement === parentRef.current) leaveEmptyList();
  }, [empty]);
  const anchorRef = useRef<(() => (() => void) | void) | null>(null);
  const wideRef = useRef(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // the docked snackbar sits over the last rows: the list keeps room below them, and j/k stop above it
  const dock = useSnack((s) => s.inset);
  const getItemKey = useCallback((i: number) => items[i]!.id, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => height,
    overscan: 10,
    getItemKey,
    paddingEnd: dock,
    scrollPaddingEnd: dock,
  });

  // a new row height (design or density): every position is recomputed before paint
  const measuredHeight = useRef(height);
  useLayoutEffect(() => {
    if (measuredHeight.current === height) return;
    measuredHeight.current = height;
    virtualizer.measure();
  }, [height]);

  // a design switch keeps the first visible row where it was on screen, and the open thread in view if it was (plan 15, R3)
  useEffect(() => {
    const capture = () => {
        const el = parentRef.current;
        const rows = useList.getState().items;
        if (!el || rows.length === 0) return;
        const oldH = measuredHeight.current;
        const first = Math.min(rows.length - 1, Math.floor(el.scrollTop / oldH));
        // how far into that row the viewport starts (≥ 0), kept as the same share of the new height
        const into = el.scrollTop - first * oldH;
        const id = getApp().selectedId;
        const sel = id === null ? undefined : useList.getState().index.get(id);
        const selVisible = sel !== undefined && sel * oldH < el.scrollTop + el.clientHeight && (sel + 1) * oldH > el.scrollTop;
        const anchorId = rows[first]!.id;
        return () => {
          const i = useList.getState().index.get(anchorId);
          if (i === undefined) return;
          const h = measuredHeight.current;
          el.scrollTop = Math.max(0, i * h + into * (h / oldH));
          // where the open thread is now (rows may have arrived above it since the capture)
          const sel = id === null ? undefined : useList.getState().index.get(id);
          // the open thread was on screen: if the new heights carried it out of view, it comes back (set directly: the
          // virtualizer's own scroll would land on positions measured before this switch)
          if (selVisible && sel !== undefined) {
            const top = sel * h;
            const bottom = el.scrollTop + el.clientHeight - useSnack.getState().inset;
            if (top + h <= el.scrollTop) el.scrollTop = top;
            else if (top >= bottom) el.scrollTop = top + h - (el.clientHeight - useSnack.getState().inset);
          }
        };
    };
    // the same capture keeps the first row through a refresh that waited behind a page, and a switch to or from one-line rows (plan 24)
    anchorRef.current = capture;
    listAnchor.capture = capture;
    listAnchor.scrolled = () => (parentRef.current?.scrollTop ?? 0) > 0;
    listAnchor.firstVisible = () => {
      const el = parentRef.current;
      const rows = useList.getState().items;
      return el && rows.length ? (rows[Math.min(rows.length - 1, Math.floor(el.scrollTop / measuredHeight.current))]?.id ?? null) : null;
    };
    const off = registerDesignAnchor(capture);
    return () => {
      off();
      if (listAnchor.capture === capture) listAnchor.capture = listAnchor.firstVisible = listAnchor.scrolled = undefined;
    };
  }, [virtualizer]);

  // one-line rows from WIDE_MIN px: the switch keeps the first visible row where it was (heights change under it)
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const read = () => {
      const next = nextWide(wideRef.current, el.clientWidth);
      if (next === wideRef.current) return;
      const restore = anchorRef.current?.();
      wideRef.current = next;
      flushSync(() => setWideEnough(next));
      restore?.();
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  // Selection changes update the attribute directly without rendering the list.
  useEffect(() => useApp.subscribe((s, prev) => {
    if (s.selectedId !== prev.selectedId) pointListCursor(parentRef.current, s.selectedId);
  }), []);

  // the filter toggled (the same mailbox and query otherwise): the open thread, kept, comes into view
  const shownKey = useRef(itemsKey);
  useEffect(() => {
    const was = shownKey.current;
    shownKey.current = itemsKey;
    if (!was || !itemsKey || was === itemsKey) return;
    const [a, b] = [JSON.parse(was) as unknown[], JSON.parse(itemsKey) as unknown[]];
    // [view, account, category, review, filter, query]: only the filter differs
    if (a[4] === b[4] || JSON.stringify([...a.slice(0, 4), a[5]]) !== JSON.stringify([...b.slice(0, 4), b[5]])) return;
    const i = useList.getState().index.get(getApp().selectedId ?? -1);
    if (i !== undefined) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [itemsKey]);

  const virtualItems = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    pointListCursor(parentRef.current, getApp().selectedId);
  }, [virtualItems]);
  const last = virtualItems[virtualItems.length - 1];
  // a new list (itemsKey) asks too: one that arrives while the old one sat at its end has the same length and last row
  useEffect(() => {
    if (last && last.index >= items.length - 40) void loadMore();
  }, [last?.index, items.length, itemsKey]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-pane" data-testid="thread-list" data-results-for={itemsKey} data-composing={composing || undefined}>
      <Header hairlineRef={headerRef} />
      <ReportRow />
      <LearnedBanner />
      {DesktopBanner && (
        <Suspense>
          <DesktopBanner />
        </Suspense>
      )}
      {/* List has no reader pane for a multi-selection: its actions are a toolbar over the rows (plan 24) */}
      {list && many && <SelectionBar variant="toolbar" />}
      <SelectAllBanner />
      <DraftsStrip />
      {/* under tabs the rows are what they control (tabpanel); the listbox is one Tab stop and restores focus when a page closes */}
      <div className="relative flex min-h-0 flex-1 flex-col" {...(tabs ? { role: "tabpanel", id: TAB_PANEL_ID, "aria-labelledby": `list-tab-${tab}` } : {})}>
      <ThreadMenu>
      <div ref={parentRef} data-keep-scroll="list" role={items.length > 0 ? "listbox" : "group"} tabIndex={items.length > 0 ? 0 : -1} onFocus={(e) => empty && e.target === e.currentTarget && leaveEmptyList()} aria-label={t("list.label")} aria-multiselectable={items.length > 0 ? true : undefined} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [contain:strict]">
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
          !filter && <EmptyState />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((v) => (
              <ThreadRow key={v.key} thread={items[v.index]!} top={v.start} height={height} compact={compact} wide={wide} showAccount={showAccount} icons={icons} layout={layout} review={review} />
            ))}
          </div>
        )}
      </div>
      </ThreadMenu>
      {review !== null && <ReviewAlwaysMenu />}
      {filter && !loading && items.length === 0 && itemsKey === listKey() && <UnreadEmptyState filter={filter} />}
      </div>
    </section>
  );
}

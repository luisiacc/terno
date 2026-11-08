import { folderName } from "~/lib/account-folders";
import { SearchField } from "@terno/ui/components/search-field";
import { Skeleton } from "@terno/ui/components/skeleton";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bell, ChevronDown, Inbox, ListFilter, Newspaper, Search, SquarePen, Sun, ListChecks } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { activeFilter } from "~/lib/unread-filter";
import { setListFilter } from "~/lib/unread";
import { matchesFilter, rowMatchOf, savesRuleOnly, tabRef, type ListFilter as QuickFilter } from "@terno/core";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { openCompose } from "~/lib/actions";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { formatNumber, t } from "@terno/i18n";
import { viewLabel } from "~/lib/format";
import { useActionPreview } from "~/state/action-preview";
import { navigate, getApp, setApp, useApp } from "~/state/app";
import { installDragController } from "~/lib/drag-install";
import { currentScope, inboxTop, listKey, loadMore, searchOfKey, useList } from "~/state/list";
import { wantExcerpts } from "~/state/excerpts";
import { useToday, type TodayGroup } from "~/state/today";
import { pressRow, releaseRow } from "~/lib/select";
import { DIGEST_ROW_ID, type ThreadSummary } from "@terno/core";
import { clearSelection, selectScope } from "~/lib/select";
import { scopeLabel } from "~/lib/selection";
import { SearchHelp } from "./search-help";
import { client } from "~/rpc/connection";
import { useSnack } from "~/lib/snack";
import { bottomInset, usePinned } from "~/lib/pinned-draft-state";
import { ThreadMenu } from "./thread-menu";
import { DraftsStrip } from "./drafts-strip";
import { ReviewAlwaysMenu } from "./review-actions";
import { RAIL, ROW_SHAPE, ThreadRow } from "./thread-row";
import { registerDesignAnchor, useDesign } from "~/lib/design";
import { LEARNED_H, LearnedBanner, LearnedSource, useLearnedProposal } from "./learned-banner";
import { ForwardQuestion } from "./forward-question";
import { ReportRow } from "./diag/report-row";
import { DesktopBanner } from "~/lib/web-parts";
import { iconsAllowed, iconsAllowedForList } from "~/lib/sender-icons";
import { useAppearance } from "~/lib/appearance";
import { fitTabs, selectedTab, tabsShown } from "~/lib/tabs";
import { listAnchor } from "~/state/list";
import { ListTabs, TAB_PANEL_ID } from "./list-tabs";
import { SelectionBar } from "./selection-bar";
import ActionPreviewHeader from "./action-preview-header";
import { renderProbe } from "~/lib/render-probe";

/** plan 87: the Inbox top's label and the gap after it (px; a row's height comes from the design) */
/** What covers the list's last rows now: List's snack dock or pinned draft (Split's are over the reader, plan 158). */
const listInset = (): number => (useAppearance.getState().layout === "list" ? bottomInset(useSnack.getState().inset, usePinned.getState().inset) : 0);

const TOP_LABEL = 28;
const EMPTY_GROUPS: readonly TodayGroup[] = [];

/** Plan 145: what the rows under it are, drawn in space the row above leaves. Not a stop for arrow keys: a listbox holds only its options. */
function TodayHeading({ kind, top }: { kind: TodayGroup["kind"]; top: number }) {
  return (
    <div aria-hidden data-testid="today-heading" data-kind={kind} className="absolute inset-x-0 flex items-end px-5 pb-1 text-xs font-medium text-muted-foreground" style={{ top, height: TOP_LABEL }}>
      {t(kind === "needsYou" ? "today.needsYou" : kind === "reminders" ? "today.reminders" : "today.newsletters")}
    </div>
  );
}

/** The digest in the list: it takes the cursor as a row does, and nothing else a thread can. */
function DigestListRow({ thread, top, height }: { thread: ThreadSummary; top: number; height: number }) {
  const selected = useApp((s) => s.selectedId === DIGEST_ROW_ID);
  return (
    <div
      role="option"
      id="thread-digest"
      aria-selected={selected}
      data-cursor={selected || undefined}
      data-testid="digest-row"
      onMouseDown={(e) => e.button === 0 && pressRow(DIGEST_ROW_ID, { meta: false, ctrl: false, shift: false })}
      onClick={() => releaseRow(DIGEST_ROW_ID)}
      className={cn("group/row absolute left-0 flex w-full cursor-default items-center gap-2.5 px-5 select-none", ROW_SHAPE, selected ? "text-row-selected-foreground before:bg-row-selected" : "hover:before:bg-row-hover")}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      {selected && <span aria-hidden className={RAIL} />}
      <Newspaper className={cn("relative size-4 shrink-0", selected ? "" : "text-muted-foreground")} />
      <span className="type-row-subject relative min-w-0 flex-1 truncate">{thread.subject}</span>
    </div>
  );
}
const TOP_GAP = 9;

export const searchInputRef: { current: HTMLInputElement | null } = { current: null };
export const listScroller: { scrollToIndex?: (i: number) => void } = {};

/** A virtualized-out option cannot be the listbox's active descendant. */
function pointListCursor(el: HTMLElement | null, id: number | null) {
  if (!el) return;
  const option = id === null ? null : el.ownerDocument.getElementById(`thread-${Math.trunc(id)}`);
  if (option && el.contains(option)) el.setAttribute("aria-activedescendant", option.id);
  else el.removeAttribute("aria-activedescendant");
}

/** The scroller is wide enough for one-line rows (List only; 16 px of hysteresis so a width near the line doesn't flip back and forth). */
export const WIDE_MIN = 720;
export function nextWide(wide: boolean, width: number): boolean {
  return wide ? width >= WIDE_MIN - 16 : width >= WIDE_MIN;
}

/** the header's filter control, where focus goes when the empty state's "Clear filter" disappears */
export const unreadFilterButton: { current: HTMLButtonElement | null } = { current: null };

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

/** The filters this list offers (not Starred in Starred): one set, in the menu and the chips alike. */
function useOfferedFilters(): readonly QuickFilter[] {
  const view = useApp((s) => s.view);
  const supported = useApp((s) => s.supportedFilters);
  return useMemo(() => supported.filter((f) => !(f === "starred" && view === "starred")), [supported, view]);
}

/** The filters behind More filters: what isn't All or Unread. */
const MORE_FILTERS = (f: QuickFilter) => f !== "unread";

/**
 * Where a design keeps its filters in a menu (plan 158): the one that's used most is one click, on a segmented All |
 * Unread, and the rest are in a small More filters menu beside it, which is filled while one of them is on (its name on
 * hover and in its own). Nothing changes shape with a filter; ⇧U and ⇧A still work from anywhere, and All clears any.
 */
function FilterControl({ filter, search }: { filter: QuickFilter | undefined; search: boolean }) {
  const offered = useOfferedFilters();
  // on, Unread says how many it shows (the mailbox's unread threads; a search counts its own)
  const total = useList((s) => (s.unreadTotal && s.unreadTotal.key === s.key ? s.unreadTotal : null));
  const n = filter === "unread" && !search && total && total.n > 0 ? `${formatNumber(total.n)}${total.capped ? "+" : ""}` : null;
  const more = useMemo(() => offered.filter(MORE_FILTERS), [offered]);
  const other = filter && filter !== "unread" ? filter : undefined;
  const moreName = other ? t("list.filter.moreOn", { name: filterName(other) }) : t("list.filter.more");
  return (
    <div data-testid="filter-control" className="no-drag flex shrink-0 items-center gap-1">
      <ToggleGroup
        data-testid="filter-segments"
        aria-label={t("list.filter.label")}
        variant="segmented"
        // with another filter on, neither: All clears it, Unread takes its place
        value={filter === "unread" ? ["unread"] : other ? [] : ["all"]}
        onValueChange={(v: string[]) => v[0] && setListFilter(v[0] === "all" ? undefined : "unread")}
      >
        {(["all", "unread"] as const).map((f) => (
          <Tooltip key={f}>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value={f}
                  data-testid={`filter-segment-${f}`}
                  className="h-6 px-2.5 text-xs"
                  ref={
                    f === "all"
                      ? (el: HTMLButtonElement | null) => {
                          unreadFilterButton.current = el;
                        }
                      : undefined
                  }
                />
              }
            >
              {f === "all" ? t("list.filter.all") : filterName("unread")}
            </TooltipTrigger>
            <TooltipContent>
              {f === "unread" && n ? t("list.filter.onCount", { name: filterName("unread"), n }) : f === "all" ? t("list.filter.allHelp") : t("list.filter.unreadHelp")} <Shortcut keys={f === "all" ? "shift+a" : "shift+u"} />
            </TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
      {more.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      data-testid="filter-menu"
                      data-active={other ? true : undefined}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={moreName}
                      className={cn("text-muted-foreground hover:text-foreground aria-expanded:text-foreground", other && "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground")}
                    />
                  }
                />
              }
            >
              <ListFilter />
            </TooltipTrigger>
            <TooltipContent>{moreName}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuRadioGroup value={other ?? ""} onValueChange={(v) => setListFilter(v === other ? undefined : (v as QuickFilter))}>
              {more.map((f) => (
                <DropdownMenuRadioItem key={f} value={f} closeOnClick data-testid={`filter-option-${f}`}>
                  <span className="min-w-0 flex-1 truncate">{filterName(f)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

const CHIP_GAP = 6;

/**
 * Lumen: the filters as chips under the header, in Split and List alike (one choice is always on; arrow keys move
 * between them). All is quiet; a filter that hides mail is on the accent. What doesn't fit
 * goes behind More, never a clipped label; the chip that's on always shows. Waiting has a chip only while it is on: it
 * is reached from the subtitle's count (or the palette). Widths come from a hidden copy, each observed (no polling).
 */
function QuickChips({ filter }: { filter: QuickFilter | undefined }) {
  const offered = useOfferedFilters();
  const rest = useMemo(() => offered.filter((f) => f !== "waiting" || filter === "waiting"), [offered, filter]);
  const stripRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<{ available: number; widths: number[]; all: number; more: number }>({ available: Infinity, widths: [], all: 0, more: 0 });
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const mirror = mirrorRef.current;
    if (!strip || !mirror) return;
    const read = () => {
      const w = [...mirror.children].map((el) => (el as HTMLElement).offsetWidth);
      const next = { available: strip.clientWidth, all: w[0] ?? 0, widths: w.slice(1, -1), more: w.at(-1) ?? 0 };
      setM((p) => (p.available === next.available && p.all === next.all && p.more === next.more && p.widths.join() === next.widths.join() ? p : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(strip);
    for (const el of mirror.children) ro.observe(el);
    return () => ro.disconnect();
  }, [rest]);
  const fit = m.widths.length === rest.length ? fitTabs({ widths: m.widths, available: m.available, pinned: m.all, more: m.more, gap: CHIP_GAP, selected: filter ? rest.indexOf(filter) : -1 }) : { visible: rest.map((_, i) => i), overflow: [] };
  const visible = ["all" as const, ...fit.visible.map((i) => rest[i]!)];
  const overflow = fit.overflow.map((i) => rest[i]!);
  const chip = "h-7 shrink-0 rounded-full px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground data-pressed:bg-muted data-pressed:text-foreground";
  const label = (f: QuickFilter | "all") => (f === "all" ? t("list.filter.all") : filterName(f));
  return (
    // grows to what its chips need and no further, so List's tabs beside it keep the rest
    <div ref={stripRef} className="no-drag relative flex min-w-0 flex-1 items-center gap-1.5 py-0.5" style={{ maxWidth: m.widths.length ? m.all + m.widths.reduce((n, w) => n + w + CHIP_GAP, 0) : undefined }}>
      <ToggleGroup
        data-testid="quick-filters"
        aria-label={t("list.filter.label")}
        value={[filter ?? "all"]}
        onValueChange={(v: string[]) => v[0] && setListFilter(v[0] === "all" ? undefined : (v[0] as QuickFilter))}
        spacing={1.5}
        className="flex w-auto"
      >
        {visible.map((f) => (
          <ToggleGroupItem key={f} value={f} data-testid={`quick-filter-${f}`} className={cn(chip, f !== "all" && "data-pressed:bg-accent data-pressed:text-accent-foreground")}>
            {label(f)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button type="button" data-testid="quick-filter-more" aria-label={t("list.filter.moreLabel", { count: overflow.length })} className={cn(chip, "flex items-center gap-0.5")}>
                {t("list.tabs.more")}
                <ChevronDown aria-hidden className="size-3" />
              </button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-44">
            {/* the one that's on always shows above, so nothing here is on */}
            <DropdownMenuRadioGroup value="" onValueChange={(v) => setListFilter(v as QuickFilter)}>
              {overflow.map((f) => (
                <DropdownMenuRadioItem key={f} value={f} closeOnClick data-testid={`quick-filter-${f}`}>
                  {filterName(f)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div aria-hidden inert className="pointer-events-none invisible absolute top-0 left-0 size-0 overflow-hidden">
        <div ref={mirrorRef} className="flex w-max">
          {(["all", ...rest] as const).map((f) => (
            <span key={f} className={cn(chip, "flex items-center")}>{label(f)}</span>
          ))}
          <span className={cn(chip, "flex items-center gap-0.5")}>
            {t("list.tabs.more")}
            <ChevronDown className="size-3" />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Search behind a button (Lumen): open while asked for or while there's a
 * query. It closes on leaving search (Esc), on its button (which clears the
 * query too), or when another mailbox opens with nothing typed; never on blur, so focus that leaves for a moment (F6 to
 * the snack, a menu) comes back to it.
 */
const useSearchOpen = create<{ open: boolean }>(() => ({ open: false }));
useApp.subscribe((s, prev) => {
  if (useSearchOpen.getState().open && !s.query && (s.view !== prev.view || s.categoryId !== prev.categoryId || s.accountId !== prev.accountId || s.folder !== prev.folder || s.gmailTab !== prev.gmailTab || s.reviewCategoryId !== prev.reviewCategoryId || s.reminders !== prev.reminders || s.followups !== prev.followups || s.today !== prev.today)) useSearchOpen.setState({ open: false });
});

/**
 * Plan 158: a search typed in a category's Review is a search, of everything (as the palette's and the row menu's are);
 * Esc out of it comes back to the Review it was typed in. Forgotten once the search ends or goes elsewhere.
 */
const searchFrom: { review: number | null } = { review: null };
useApp.subscribe((s, prev) => {
  if (searchFrom.review !== null && (!s.query.trim() || s.view !== prev.view || s.categoryId !== prev.categoryId || s.accountId !== prev.accountId || s.folder !== prev.folder || s.reminders || s.followups || s.today)) searchFrom.review = null;
});

/** What the field types into the app: from a Review, a search of everything. */
function typeQuery(q: string): void {
  const review = getApp().reviewCategoryId;
  const back = searchFrom.review;
  if (review !== null && q.trim()) {
    setApp({ query: q, reviewCategoryId: null });
    searchFrom.review = review;
  } else if (back !== null && !q.trim() && getApp().categories.some((c) => c.id === back)) setApp({ query: q, reviewCategoryId: back });
  else setApp({ query: q });
}

/** "/" and ⌘F: the search field, opened first where the design keeps it behind a button. */
export function focusSearch(): void {
  if (!searchInputRef.current) flushSync(() => useSearchOpen.setState({ open: true }));
  // under List's selection toolbar: searching ends the selection, and the field is there to take the focus
  if (searchInputRef.current?.closest("[inert]")) flushSync(clearSelection);
  searchInputRef.current?.focus();
}

/** The search button: opens the field, or, while it shows, clears the query and closes it. */
function toggleSearch(): void {
  if (!searchInputRef.current) return focusSearch();
  if (getApp().query) typeQuery("");
  useSearchOpen.setState({ open: false });
}

/** A field behind a button with nothing in it: Esc from the rows closes it too. */
export function closeEmptySearch(): void {
  if (useSearchOpen.getState().open) useSearchOpen.setState({ open: false });
}

const listRows = () => document.querySelector<HTMLElement>("[data-testid=thread-list] [data-keep-scroll=list]");

/** Focus on the rows (where j/k and Esc are the list's), as soon as there are some: an empty list hands focus away. */
export function focusRows(): void {
  if (useList.getState().items.length) return void listRows()?.focus({ preventScroll: true });
  const off = useList.subscribe((l) => {
    if (l.loading) return;
    off();
    if (l.items.length && document.activeElement === document.body) requestAnimationFrame(() => listRows()?.focus({ preventScroll: true }));
  });
}

/** Plan 158, the skip link: the rows, or with none the list's own first control (its header, or a preview's), never a wait. */
export function skipToList(): void {
  if (useList.getState().items.length) return focusRows();
  document.querySelector<HTMLElement>("[data-testid=thread-list] :is(button, input):not([disabled])")?.focus();
}

/**
 * Plan 158, Esc's last step in every design: the query goes, a field behind a button closes, the mailbox comes back
 * where it was left (state/list) and the keys are the rows' again. The step before it: focusSearch, from the results.
 */
function leaveSearch(field: HTMLInputElement): void {
  field.blur();
  if (getApp().query) typeQuery("");
  closeEmptySearch();
  focusRows();
}

function ListSearch() {
  const query = useApp((s) => s.query);
  // plan 108: focused on an account, the field says whose mail it looks in
  const soloName = useApp((s) => (s.soloAccountId === null ? null : (s.accounts.find((a) => a.id === s.soloAccountId)?.displayName ?? null)));
  const placeholder = soloName === null ? t("list.search.placeholder") : t("list.search.placeholderIn", { account: soloName });
  const coverage = useCoverageNote();
  // plan 158: arriving at an empty field, what it can do: quiet, over the rows, gone at the first letter and not back when
  // it's emptied again (that's the mailbox coming back, its rows wanted)
  const [help, setHelp] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={wrapper}
      className="relative"
      onFocus={(e) => {
        if (!wrapper.current?.contains(e.relatedTarget as Node | null)) setHelp(true);
      }}
      onBlur={(e) => {
        if (!wrapper.current?.contains(e.relatedTarget as Node | null)) setHelp(false);
      }}
    >
    <SearchField
        className="no-drag"
        ref={(el) => {
          searchInputRef.current = el;
        }}
        data-testid="search-input"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-describedby={coverage ? "search-coverage" : undefined}
        clearLabel={t("list.search.clear")}
        hint={<Shortcut keys="/" />}
        // the list's compact field, on the tint; its ring in the app's weight, not louder than the results it's for
        fieldClassName="h-[30px] bg-tint text-sm dark:bg-tint focus-visible:ring-2"
        onValueChange={(q) => {
          setHelp(false);
          typeQuery(q);
        }}
        clearOnEscape={false}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            leaveSearch(e.currentTarget);
          } else if (e.key === "Enter" || e.key === "ArrowDown") {
            // nothing to move to: the field keeps the keys
            if (!useList.getState().items.length) return e.preventDefault();
            // Enter goes on to open the cursor's row (the document's handler); ↓ only arrives on it
            if (e.key === "ArrowDown") e.preventDefault();
            listRows()?.focus({ preventScroll: true });
          }
        }}
      />
      {help && query === "" && (
        <div
          role="group"
          aria-label={t("search.help.title")}
          data-testid="search-help-panel"
          className="no-drag absolute inset-x-0 top-full z-30 mt-1.5 rounded-menu bg-popover p-1.5 text-popover-foreground shadow-menu"
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            // Esc from a row here is Esc from the field
            if (e.key !== "Escape" || !searchInputRef.current) return;
            e.preventDefault();
            leaveSearch(searchInputRef.current);
          }}
        >
          <SearchHelp onPick={(text) => { setHelp(false); typeQuery(text); searchInputRef.current?.focus(); }} scope={soloName === null ? t("search.help.scope") : t("search.help.scopeIn", { account: soloName })} />
        </div>
      )}
    </div>
  );
}

/** Plan 158: few results or none are when it matters that only saved mail is searched; a filtered empty list says what to do itself. */
const FEW_RESULTS = 3;
function useCoverageNote(): boolean {
  const searching = useApp((s) => s.query.trim() !== "" && s.reviewCategoryId === null);
  const filtered = useApp((s) => activeFilter(s) !== undefined);
  return useList((l) => searching && l.itemsKey === l.key && !l.loading && !l.nextCursor && l.items.length <= FEW_RESULTS && (l.items.length > 0 || !filtered));
}

function CoverageNote({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <p id="search-coverage" data-testid="search-coverage" className={cn("text-xs text-muted-foreground", className)} style={style}>{t("list.search.coverage")}</p>;
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

/** The waiting count's window follows the clock (its day-part boundaries, the window coming back); nothing drawn. */
function CountsClock() {
  useDayPart();
  return null;
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

/** A count under the title that is also its filter: BoardUI's secondary link button, at the line's own size. */
const COUNT_LINK = "no-drag align-baseline text-[length:inherit] leading-[inherit] font-normal text-muted-foreground hover:text-foreground aria-pressed:text-foreground aria-pressed:underline";

/** Under a display title: what's unread here; the greeting's adds what waits for your reply. */
function Subtitle({ filter, greeting }: { filter: QuickFilter | undefined; greeting: boolean }) {
  const unread = useApp((s) =>
    s.reviewCategoryId !== null
      ? null
      : s.categoryId !== null
        ? (s.counts.categoryUnread[s.categoryId] ?? 0)
        : // plan 86 (Codex code review #7): a Gmail tab's own count, not its account's Inbox's
          s.gmailTab !== null && s.accountId !== null
          ? (s.counts.tabUnread?.[tabRef(s.accountId, s.gmailTab)] ?? 0)
          : s.view === "inbox"
            ? s.accountId !== null
              ? (s.counts.inboxUnreadByAccount[s.accountId] ?? 0)
              : s.counts.inboxUnread
            : null,
  );
  const counted = useWaitingCount();
  const waiting = greeting && counted ? counted : 0;
  if (unread === null) return null;
  return (
    <p data-testid="list-subtitle" className="type-list-subtitle flex min-w-0 items-center gap-1 text-muted-foreground tabular">
      <span className="min-w-0 truncate">
      {greeting && <CountsClock />}
      {/* plan 158: the line says only what can be acted on, and each count does it: what's unread shows it (Unread), what
          waits for you shows that (Waiting). The same quiet ink as the rest; on, underlined in the ink */}
      {unread > 0 && (
        <Button
          variant="link-secondary"
          data-testid="unread-count"
          aria-pressed={filter === "unread"}
          className={COUNT_LINK}
          onClick={() => setListFilter(filter === "unread" ? undefined : "unread")}
        >
          {t("list.unreadCount", { count: unread })}
        </Button>
      )}
      {unread > 0 && waiting > 0 && <span aria-hidden> · </span>}
      {waiting > 0 && (
        // a link button (BoardUI's secondary link) that shows what it says: on, it stays underlined in the ink, its chip beside
        <Button
          variant="link-secondary"
          data-testid="waiting-count"
          aria-pressed={filter === "waiting"}
          className={COUNT_LINK}
          onClick={() => setListFilter(filter === "waiting" ? undefined : "waiting")}
        >
          {t("list.waitingCount", { count: waiting })}
        </Button>
      )}
      {unread === 0 && waiting === 0 && t("list.caughtUp")}
      </span>
    </p>
  );
}

function Header({ hairlineRef, oneRow }: { hairlineRef: React.Ref<HTMLDivElement>; /** List's full-width list: everything that fits sits on the title's line */ oneRow: boolean }) {
  const view = useApp((s) => s.view);
  const category = useApp((s) => s.categories.find((c) => c.id === s.categoryId));
  const folder = useApp(folderName);
  const review = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  // plan 87: Reminders is a list of its own, unfiltered (no quick filters)
  const reminders = useApp((s) => s.reminders || s.followups || s.today);
  const today = useApp((s) => s.today);
  const todayMore = useToday((s) => (today ? s.more : 0));
  const followups = useApp((s) => s.followups);
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
  const title = searching ? t("list.search.title") : review ? t("list.reviewTitle", { category: review.name }) : today ? t("today.title") : followups ? t("followups.title") : reminders ? t("view.reminders") : (folder ?? category?.name ?? viewLabel(view));
  // the title names the mailbox; the greeting is the words under the inbox's (any account; not a Gmail tab of it, plan 86)
  const kind = design.variants.listHeader === "greeting" && view === "inbox" && !folder && !category && !review && !searching ? "greeting" : design.variants.listHeader === "title" ? "title" : "display";
  const behindButton = design.variants.search === "button";
  const quick = design.variants.quickFilters;
  const list = useAppearance((s) => s.layout === "list");
  const tabs = useApp((s) => list && tabsShown(s));
  const showField = !behindButton || searchOpen || query !== "";
  const inlineTabs = oneRow && tabs && quick === "menu";
  // List's selection toolbar stands on this line: what's under it can't be reached until it goes
  const covered = useApp((s) => list && (s.scope !== null || s.checked.size >= 1));
  const results = t("list.search.inSaved", { results: more ? t("list.search.resultsMore", { count }) : t("list.search.results", { count }) });
  // none found: the list says so under the field, with what to try; the count is still said, not shown (plan 158)
  const found = count > 0 || more || !complete;
  const stats = query && searchMs !== null && (
    <span data-testid="search-stats" data-found={found || undefined} role="status" className={found ? "shrink-0 text-xs text-muted-foreground tabular" : "sr-only"}>
      {complete ? results : t("list.search.statsIndexing", { results })}
    </span>
  );
  // the one filter control sits with the header's actions, in every width and whatever the list holds
  const filterControl = !review && !reminders && quick === "menu" && <FilterControl filter={filter} search={query.trim() !== ""} />;
  const actions = (
    <>
      {todayMore > 0 && (
        <Button variant="link-secondary" size="xs" className="no-drag shrink-0" data-testid="today-more" onClick={() => {
          navigate({ view: "inbox" });
          setListFilter("waiting");
        }}>{t("today.showAll", { count: todayMore })}</Button>
      )}
      {behindButton && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button data-testid="search-button" variant="ghost" size="icon-sm" aria-label={showField ? t("list.search.close") : t("common.search")} aria-expanded={showField} className="no-drag shrink-0 rounded-full text-muted-foreground hover:text-foreground" onClick={toggleSearch}>
                <Search />
              </Button>
            }
          />
          <TooltipContent>
            {showField ? t("list.search.close") : <>{t("common.search")} <Shortcut keys="/" /></>}
          </TooltipContent>
        </Tooltip>
      )}
      {design.variants.compose === "list-header" && (
        <Tooltip>
          <TooltipTrigger
            render={
              // the mail's own action in words, where the row has them: a raised button, not a loud one
              // plan 158: under 25rem (a 1100 px window) its words go first, so the title is never what's cut ("In…")
              <Button data-testid="compose-button" variant="outline" size="sm" aria-label={t("compose.newMessage")} className="no-drag shrink-0 @max-[25rem]:aspect-square @max-[25rem]:px-0" onClick={() => openCompose("new")}>
                <SquarePen />
                {/* plan 158: the same in a search: the header keeps its shape, only the title changes */}
                <span className="@max-[25rem]:hidden">{t("compose.newMessage")}</span>
              </Button>
            }
          />
          <TooltipContent>
            {t("compose.newMessage")} <Shortcut keys="c" />
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
  // plan 108: focused on an account, a search looks only in it: it says whose, and offers every account
  const soloSearch = useApp((s) => s.soloAccountId !== null) && searching;
  const searchAll = soloSearch && (
    <Button variant="link" data-testid="solo-search-all" className="no-drag text-2xs" onClick={() => {
        setApp({ soloAccountId: null });
        // the button goes with the narrowed search: the keyboard stays in the search (Codex code review #5)
        searchInputRef.current?.focus();
      }}>
      {t("list.search.allAccounts")}
    </Button>
  );
  // the compact title row's count, under the field (plan 158)
  const underField = !oneRow && kind === "title" && !!query && ((searchMs !== null && found) || !!searchAll);
  // (the compact title row leaves it to "Search all accounts": beside the stats it would only truncate)
  const accountSuffix = account && (!searching || (soloSearch && kind !== "title")) && <span className="ml-1.5 text-sm font-normal tracking-normal text-muted-foreground not-italic">· {account.displayName}</span>;
  // plan 158: a filter behind More filters is named where the place is, as an account is (Unread says so on its segment,
  // and in a display title's count): the title keeps its own words, the name is what truncates
  const filterSuffix = filter && filter !== "unread" && quick === "menu" && !review && !reminders && (
    <span data-testid="list-title-filter" className="ml-1.5 text-sm font-normal tracking-normal text-muted-foreground not-italic">· {filterName(filter)}</span>
  );

  return (
    // every fill starts at 8 px, as a row's selection does; every line of text at 20 px, as a row's does
    <div ref={hairlineRef} data-testid="list-header" data-kind={kind} className="drag-region scroll-hairline @container shrink-0 pr-4 pb-1.5 pl-2">
      {oneRow ? (
        <div inert={covered} className="flex h-[52px] min-w-0 items-center gap-3 pr-1.5 pl-3">
          {/* tabs on this line: the selected one says this, and says what's unread */}
          <h1 className={cn("min-w-0 max-w-[40cqw] truncate", inlineTabs && !account ? "sr-only" : kind === "title" ? "text-md font-semibold tracking-tight" : kind === "greeting" ? "type-greeting" : "type-list-title")} data-testid="list-title">
            {title}
            {accountSuffix}
            {filterSuffix}
          </h1>
          {query && (searchMs !== null || searchAll) ? (
            <p className="flex shrink-0 items-center gap-2">
              {stats}
              {searchAll}
            </p>
          ) : (
            kind !== "title" && !inlineTabs && <Subtitle filter={filter} greeting={kind === "greeting"} />
          )}
          {/* what the row leaves goes to the tabs, then to nothing: the controls keep the right edge */}
          <div className="flex min-w-0 flex-1 items-center">{inlineTabs && <ListTabs inline />}</div>
          {/* the tabs name the place, so the filter is named beside its control */}
          {inlineTabs && !account && filter && filter !== "unread" && <span data-testid="list-filter-name" className="shrink-0 truncate text-xs text-muted-foreground">{filterName(filter)}</span>}
          {filterControl}
          {showField && (
            <div className="w-[clamp(14.5rem,24cqw,20rem)] shrink-0">
              <ListSearch />
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2 empty:hidden">{actions}</div>
        </div>
      ) : kind === "title" ? (
        <div inert={covered} className="flex h-[52px] items-center gap-2 pr-1.5 pl-3">
          <h1 className="min-w-0 flex-1 truncate text-md font-semibold tracking-tight" data-testid="list-title">
            {title}
            {accountSuffix}
            {filterSuffix}
          </h1>
          {/* none found: said here, shown by the list */}
          {!underField && stats}
          {filterControl}
          {actions}
        </div>
      ) : (
        <>
          {/* on the reader toolbar's line */}
          <div inert={covered} className="flex h-[52px] items-center gap-2 pr-1.5 pl-3">
            <h1 className={cn("min-w-0 flex-1 truncate", kind === "greeting" ? "type-greeting" : "type-list-title")} data-testid="list-title">
              {title}
              {accountSuffix}
              {filterSuffix}
            </h1>
            {filterControl}
            <div className="flex shrink-0 items-center gap-0.5 empty:hidden">{actions}</div>
          </div>
          {/* gives way as the list scrolls (at once: moving through a list never animates), unless it says what a search found */}
          <div
            data-keep={query ? true : undefined}
            // on a short window it gives its room to the rows (the counts are the sidebar's too), unless it says what a search found
            className="-mt-1.5 pb-2 pl-3 group-data-scrolled/list:not-data-keep:hidden [@media(max-height:760px)]:not-data-keep:hidden"
          >
            {query && (searchMs !== null || searchAll) ? (
              <p className="flex items-center gap-2">
                {stats}
                {searchAll}
              </p>
            ) : (
              <Subtitle filter={filter} greeting={kind === "greeting"} />
            )}
          </div>
        </>
      )}
      {!oneRow && showField && <ListSearch />}
      {/* plan 158: the compact title row keeps its title and controls in a search: what it found goes under the field, on its text's line */}
      {underField && (
        <p className="flex items-center gap-2 px-3 pt-1.5">
          {stats}
          {searchAll}
        </p>
      )}
      {((tabs && (!oneRow || quick === "chips")) || (!review && !reminders && quick === "chips")) && (
        <div className="mt-1 flex min-w-0 items-center gap-3 pl-3 empty:hidden">
          {tabs && (!oneRow || quick === "chips") && <ListTabs />}
          {!review && !reminders && quick === "chips" && <QuickChips filter={filter} />}
        </div>
      )}
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
  // its links in the ink: the accent fails AA on the tint in three palettes (contrast.ts)
  return (
    <div data-testid="select-all-banner" className="hairline-b flex shrink-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 bg-tint px-3 py-1.5 text-center text-xs text-muted-foreground">
      {scope ? (
        <>
          <span data-testid="select-all-scope">
            {t("list.selectAll.scopeSelected", { count: scope.count, label: scope.label })}
          </span>
          <Button variant="link-secondary" data-testid="select-all-clear" className="text-xs" onClick={clearSelection}>
            {t("list.selectAll.clear")}
          </Button>
        </>
      ) : (
        <>
          <span>{t("list.selectAll.loadedSelected", { count: loaded })}</span>
          <Button variant="link-secondary" data-testid="select-all-scope-button" disabled={!n || n.capped} className="text-xs" onClick={() => n && selectScope(n.n)}>
            {n ? (n.capped ? t("list.selectAll.capped", { count: n.n, label }) : t("list.selectAll.select", { count: n.n, label })) : t("list.selectAll.pending", { label })}
          </Button>
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
  const query = useApp((s) => s.query.trim());
  const search = query !== "";
  const [title, body] = emptyCopy(filter, search);
  // a search answers under its field, as one with no filter does (plan 158): what to clear, then what a search understands
  return (
    <div className={cn("absolute inset-0 flex flex-col gap-1", search ? "px-5 pt-3" : "items-center justify-center px-8 text-center")} data-testid="unread-empty" data-filter={filter}>
      {!search && <ListFilter className="mb-2 size-7 text-muted-foreground" aria-hidden />}
      <p className={search ? "text-md font-semibold tracking-tight" : "text-lg font-semibold tracking-tight"}>{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
      <Button
        data-testid="unread-empty-clear"
        variant="secondary"
        size="sm"
        className={cn("mt-3", search && "self-start")}
        onClick={() => {
          setListFilter(undefined);
          // the filter's control stays: the header button, or Lumen's "All" chip
          (unreadFilterButton.current ?? document.querySelector<HTMLElement>("[data-testid=quick-filter-all]"))?.focus();
        }}
      >
        {t("list.unreadEmpty.clear")}
      </Button>
      {search && (
        <div className="-mx-2 mt-4">
          <SearchHelp around={query} onPick={(text) => { typeQuery(text); searchInputRef.current?.focus(); }} />
        </div>
      )}
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
  const reminders = useApp((s) => s.reminders);
  const followups = useApp((s) => s.followups);
  const today = useApp((s) => s.today);
  const previewing = useApp((s) => s.actionPreview !== null);
  const ruleOnly = useActionPreview((s) => s.preview !== null && savesRuleOnly(s.preview));
  const coverage = useCoverageNote();
  if (previewing && ruleOnly)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
        <p className="text-lg font-semibold tracking-tight">{t("action.rule.emptyTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("action.rule.emptyBody")}</p>
      </div>
    );
  if (today)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
        <Sun className="mb-2 size-7 text-muted-foreground" aria-hidden />
        <p className="text-lg font-semibold tracking-tight">{t("today.empty")}</p>
      </div>
    );
  if (followups)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
        <ListChecks className="mb-2 size-7 text-muted-foreground" aria-hidden />
        <p className="text-lg font-semibold tracking-tight">{t("followups.empty")}</p>
        <p className="text-xs text-muted-foreground">{t("followups.emptyHint")}</p>
      </div>
    );
  if (reminders)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
        <Bell className="mb-2 size-7 text-muted-foreground" aria-hidden />
        <p className="text-lg font-semibold tracking-tight">{t("remind.empty")}</p>
        <p className="text-xs text-muted-foreground">{t("remind.emptyHint")}</p>
      </div>
    );
  // plan 158: a search that found nothing answers under its field, on the rows' line: what it understands (a row puts the
  // words to use), and what it looks through. Nothing floats in the reader
  if (query)
    return (
      <div className="flex flex-col px-3 pt-3" data-testid="list-empty">
        <p className="px-2 text-md font-semibold tracking-tight [overflow-wrap:anywhere]">{t("list.empty.searchTitle", { query: query.trim() })}</p>
        <div className="mt-3">
          <SearchHelp around={query} onPick={(text) => { typeQuery(text); searchInputRef.current?.focus(); }} />
        </div>
        {coverage && <CoverageNote className="hairline-t mx-2 mt-2 pt-2" />}
      </div>
    );
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
      <Inbox className="mb-2 size-7 text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold tracking-tight">{view === "inbox" ? t("list.empty.inboxTitle") : t("list.empty.title")}</p>
      <p className="text-xs text-muted-foreground">{view === "inbox" ? t("list.empty.inboxBody") : t("list.empty.body")}</p>
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
  const searching = useApp((s) => s.query.trim() !== "" && s.reviewCategoryId === null);
  const coverage = useCoverageNote();
  const design = useDesign();
  // plan 24: List's full-width list draws one-line rows once its scroller is wide enough for them
  const list = useAppearance((s) => s.layout === "list");
  const [wideEnough, setWideEnough] = useState(false);
  const wide = list && wideEnough;
  // plan 158: the search these rows answer, not what's being typed by now (the row height and marks change with the rows they're for)
  const resultsOf = searchOfKey(itemsKey);
  const height = wide && !compact ? design.rows.wide : design.rows[compact ? "compact" : resultsOf ? "results" : "comfortable"];
  const layout = design.variants.row;
  // List has no pane to say a row is checked: the toolbar comes with the first (one conversation, as with x)
  const many = useApp((s) => s.scope !== null || s.checked.size >= (list ? 1 : 2));
  const previewing = useApp((s) => s.actionPreview !== null);
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
  const sectionRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pressing = useRef(false);

  // List's docked snackbar sits over the last rows: the list keeps room below them (scroll room, no row moves), and j/k
  // stop above it; so does List's pinned draft (plan 115). Split's are over the reader, never the rows (plan 158)
  const over = useAppearance((s) => s.layout === "list");
  const dock = bottomInset(useSnack((s) => (over ? s.inset : 0)), usePinned((s) => (over ? s.inset : 0)));
  const getItemKey = useCallback((i: number) => items[i]!.id, [items]);
  // plan 87: the Inbox's top (due reminders) under a "Reminders" label, a hairline gap before the rest
  const top = useMemo(() => {
    let n = 0;
    while (n < items.length && inboxTop.ids.includes(items[n]!.id)) n++;
    return n;
  }, [items]);
  const topGap = top > 0 && top < items.length ? TOP_GAP : 0;
  // plan 158: the rule offer is the list's first item: room above the first row, and it goes up with them
  const learned = useLearnedProposal();
  const lead = learned.proposal && !previewing ? LEARNED_H : 0;
  const leadRef = useRef(lead);
  leadRef.current = lead;
  const inToday = useApp((s) => s.today);
  const todayGroups = useToday((s) => (inToday ? s.groups : EMPTY_GROUPS));
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // plan 145: a section's heading is space under the row before it, or above the first
    estimateSize: (i) => height + (i === top - 1 ? topGap : 0) + (todayGroups.some((g) => g.at === i + 1) ? TOP_LABEL : 0),
    paddingStart: lead + (top > 0 || todayGroups.length ? TOP_LABEL : 0),
    overscan: 10,
    getItemKey,
    paddingEnd: dock,
    scrollPaddingEnd: dock,
  });

  // the top came or went (or grew), or the offer above it: positions recomputed before paint
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [top, topGap, todayGroups, lead]);
  // the offer came or went while the list was scrolled: what's on screen stays where it is (at the top, it's the first item arriving)
  const shownLead = useRef(lead);
  // the offset as last scrolled: by the time the change is laid out, a shorter list has already clamped the element's own (at its end)
  const lastTop = useRef(0);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const read = () => (lastTop.current = el.scrollTop);
    el.addEventListener("scroll", read, { passive: true });
    return () => el.removeEventListener("scroll", read);
  }, []);
  useLayoutEffect(() => {
    const d = lead - shownLead.current;
    shownLead.current = lead;
    const el = parentRef.current;
    if (d && el && lastTop.current > 0) el.scrollTop = lastTop.current + d;
  }, [lead]);

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
        // the offer above the rows keeps its height whatever theirs: only what's past it is measured in rows
        const lead = leadRef.current;
        const above = Math.min(el.scrollTop, lead);
        const y = el.scrollTop - above;
        const first = Math.min(rows.length - 1, Math.floor(y / oldH));
        // how far into that row the viewport starts (≥ 0), kept as the same share of the new height
        const into = y - first * oldH;
        const id = getApp().selectedId;
        const sel = id === null ? undefined : useList.getState().index.get(id);
        const selVisible = sel !== undefined && lead + sel * oldH < el.scrollTop + el.clientHeight && lead + (sel + 1) * oldH > el.scrollTop;
        const anchorId = rows[first]!.id;
        return () => {
          const i = useList.getState().index.get(anchorId);
          if (i === undefined) return;
          const h = measuredHeight.current;
          el.scrollTop = Math.max(0, above + i * h + into * (h / oldH));
          // where the open thread is now (rows may have arrived above it since the capture)
          const sel = id === null ? undefined : useList.getState().index.get(id);
          // the open thread was on screen: if the new heights carried it out of view, it comes back (set directly: the
          // virtualizer's own scroll would land on positions measured before this switch)
          if (selVisible && sel !== undefined) {
            const top = leadRef.current + sel * h;
            const bottom = el.scrollTop + el.clientHeight - listInset();
            if (top + h <= el.scrollTop) el.scrollTop = top;
            else if (top >= bottom) el.scrollTop = top + h - (el.clientHeight - listInset());
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
      return el && rows.length ? (rows[Math.min(rows.length - 1, Math.floor(Math.max(0, el.scrollTop - leadRef.current) / measuredHeight.current))]?.id ?? null) : null;
    };
    // plan 158: where a mailbox was left, and back there (or to the top) when it shows again
    listAnchor.scrollAt = () => {
      const el = parentRef.current;
      const rows = useList.getState().items;
      // (scrolled only into the offer above the rows is the top)
      if (!el || rows.length === 0 || el.scrollTop <= leadRef.current) return null;
      const h = measuredHeight.current;
      const y = el.scrollTop - leadRef.current;
      const first = Math.min(rows.length - 1, Math.floor(y / h));
      return { id: rows[first]!.id, into: y / h - first };
    };
    listAnchor.scrollTo = (at) => {
      const i = at ? useList.getState().index.get(at.id) : undefined;
      // through the virtualizer: a scrollToIndex of the last list's (j, then Esc) may still be settling, and this replaces it
      virtualizer.scrollToOffset(at && i !== undefined ? leadRef.current + (i + at.into) * measuredHeight.current : 0);
    };
    const off = registerDesignAnchor(capture);
    return () => {
      off();
      if (listAnchor.capture === capture) listAnchor.capture = listAnchor.firstVisible = listAnchor.scrolled = listAnchor.scrollAt = listAnchor.scrollTo = undefined;
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
    const [root, sentinel, header, section] = [parentRef.current, sentinelRef.current, headerRef.current, sectionRef.current];
    if (!root || !sentinel) return;
    // the header's hairline, and (on the section, for the header and the banner under it) what gives way to the list
    const offs = [header && installScrollHairline(root, sentinel, header), section && installScrollHairline(root, sentinel, section)];
    return () => offs.forEach((off) => off?.());
  }, []);

  // drag rows onto sidebar categories: one delegated listener on the listbox
  useEffect(() => (parentRef.current ? installDragController(parentRef.current) : undefined), []);

  useEffect(() => {
    listScroller.scrollToIndex = (i) => virtualizer.scrollToIndex(i, { align: "auto" });
  }, [virtualizer]);

  // Selection changes update the attribute directly without rendering the list.
  useEffect(() => useApp.subscribe((s, prev) => {
    // plan 158: among several selected, j/k's cursor needs a mark of its own (the rows all look alike); a click needs none
    const several = s.scope !== null || s.checked.size >= 2;
    if (!several) delete sectionRef.current?.dataset.keyed;
    if (s.selectedId === prev.selectedId) return;
    pointListCursor(parentRef.current, s.selectedId);
    if (several && !pressing.current && sectionRef.current) sectionRef.current.dataset.keyed = "";
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
  // for rows that don't show why they matched, the sentence that does
  const match = useMemo(() => (resultsOf ? rowMatchOf(resultsOf) : null), [resultsOf]);
  useEffect(() => {
    wantExcerpts(resultsOf, match, virtualItems.flatMap((v) => items[v.index] ?? []));
  }, [match, virtualItems, items]);
  const last = virtualItems[virtualItems.length - 1];
  // a new list (itemsKey) asks too: one that arrives while the old one sat at its end has the same length and last row
  useEffect(() => {
    if (last && last.index >= items.length - 40) void loadMore();
  }, [last?.index, items.length, itemsKey]);

  return (
    <section ref={sectionRef} className="group/list relative flex h-full min-h-0 flex-col bg-pane" data-testid="thread-list" data-results-for={itemsKey} data-composing={composing || undefined} data-many={many || undefined}
      onPointerDownCapture={() => {
        pressing.current = true;
        delete sectionRef.current?.dataset.keyed;
      }}
      onPointerUpCapture={() => (pressing.current = false)}
    >
      {previewing ? (
        <ActionPreviewHeader />
      ) : (
        <>
          <Header hairlineRef={headerRef} oneRow={wide} />
          <ReportRow />
          <ForwardQuestion />
          {DesktopBanner && <DesktopBanner />}
        </>
      )}
      {/* List has no reader pane for a multi-selection: its actions are a toolbar over the header's line (plan 24); no row moves for it (plan 158) */}
      {list && many && !previewing && <SelectionBar variant="toolbar" />}
      {!previewing && <SelectAllBanner />}
      {/* under tabs the rows are what they control (tabpanel); the listbox is one Tab stop and restores focus when a page closes */}
      <div className="relative flex min-h-0 flex-1 flex-col" {...(tabs ? { role: "tabpanel", id: TAB_PANEL_ID, "aria-labelledby": `list-tab-${tab}` } : {})}>
      <LearnedSource />
      {learned.proposal && lead > 0 && <LearnedBanner proposal={learned.proposal} scroller={parentRef} />}
      <ThreadMenu>
      <div ref={parentRef} data-keep-scroll="list" role={items.length > 0 ? "listbox" : "group"} tabIndex={items.length > 0 ? 0 : -1} onFocus={(e) => empty && e.target === e.currentTarget && leaveEmptyList()} aria-label={t("list.label")} aria-multiselectable={items.length > 0 ? true : undefined} className="@container/rows relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [contain:strict]">
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        {loading && items.length === 0 ? (
          <div className="space-y-3 p-4" style={lead ? { marginTop: lead } : undefined}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton shape="text" className="w-1/3" />
                <Skeleton shape="text" className="w-5/6" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          !filter && <EmptyState />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {top > 0 && (
              // what the rows under it are (each row says "Reminder" to a screen reader itself)
              <div aria-hidden data-testid="inbox-reminders-label" className="absolute inset-x-0 flex items-end gap-1.5 px-5 pb-1 text-xs font-medium text-muted-foreground" style={{ top: lead, height: TOP_LABEL }}>
                <Bell className="size-3" />
                {t("view.reminders")}
              </div>
            )}
            {topGap > 0 && <div aria-hidden data-testid="inbox-reminders-end" className="absolute inset-x-5 h-(--hairline-w) bg-hairline" style={{ top: lead + TOP_LABEL + top * height + topGap / 2 }} />}
            {todayGroups.map((g, i) => (
              <TodayHeading key={g.kind} kind={g.kind} top={lead + i * TOP_LABEL + g.at * height} />
            ))}
            {virtualItems.map((v) => (
              items[v.index]!.id === DIGEST_ROW_ID ? <DigestListRow key={v.key} thread={items[v.index]!} top={v.start} height={height} /> :
              <ThreadRow key={v.key} thread={items[v.index]!} top={v.start} height={height} compact={compact} wide={wide} showAccount={showAccount} icons={icons} layout={layout} review={review} reminderTop={v.index < top} reminderEnd={topGap > 0 && v.index === top - 1} match={match} />
            ))}
          </div>
        )}
      </div>
      </ThreadMenu>
      {review !== null && <ReviewAlwaysMenu />}
      {filter && !loading && items.length === 0 && itemsKey === listKey() && <UnreadEmptyState filter={filter} />}
      {coverage && items.length > 0 && <CoverageNote className="pointer-events-none absolute inset-x-0 px-5 pt-3" style={{ top: virtualizer.getTotalSize() }} />}
      </div>
      {/* plan 158: nothing with the results that isn't one */}
      {!previewing && !searching && <DraftsStrip />}
    </section>
  );
}

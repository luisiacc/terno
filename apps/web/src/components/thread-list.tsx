import { folderName } from "~/lib/account-folders";
import { SearchField } from "@terno/ui/components/search-field";
import { Skeleton } from "@terno/ui/components/skeleton";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bell, ChevronDown, ChevronRight, Inbox, ListFilter, Newspaper, Search, SquarePen, Sun, ListChecks, Tags } from "@terno/ui/icons";
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
import { formatNumber, getLocale, t } from "@terno/i18n";
import { viewLabel } from "~/lib/format";
import { useActionPreview } from "~/state/action-preview";
import { navigate, getApp, setApp, useApp } from "~/state/app";
import { installDragController } from "~/lib/drag-install";
import { currentScope, inboxTop, listKey, loadMore, searchOfKey, useList } from "~/state/list";
import { wantExcerpts } from "~/state/excerpts";
import { digestFrom, digestLabel, useToday, type TodayGroup } from "~/state/today";
import { DIGEST_ROW_ID } from "@terno/core";
import { clearSelection, selectScope } from "~/lib/select";
import { scopeLabel } from "~/lib/selection";
import { SearchHelp } from "./search-help";
import { client } from "~/rpc/connection";
import { useSnack } from "~/lib/snack";
import { bottomInset, pinnedInsetNow, usePinnedInset } from "~/lib/pinned-draft-state";
import { usePinnedAsk } from "~/lib/pinned-ask-state";
import { ThreadMenu } from "./thread-menu";
import { DraftsStrip } from "./drafts-strip";
import { ReviewAlwaysMenu, ReviewButtons } from "./review-actions";
import { ReviewSwitcher } from "./review-switcher";
import { reviewTotals } from "~/lib/review";
import { ThreadRow } from "./thread-row";
import { registerDesignAnchor, useDesign } from "~/lib/design";
import { LearnedBanner, LearnedSource, useLearnedProposal } from "./learned-banner";
import { ForwardQuestion } from "./forward-question";
import { ReportRow } from "./diag/report-row";
import { DesktopBanner } from "~/lib/web-parts";
import { iconsAllowed, iconsAllowedForList } from "~/lib/sender-icons";
import { useAppearance } from "~/lib/appearance";
import { fitStrip } from "~/lib/fit-strip";
import { listAnchor } from "~/state/list";
import { SelectionBar } from "./selection-bar";
import ActionPreviewHeader from "./action-preview-header";
import { renderProbe } from "~/lib/render-probe";
import { LIST_TITLE } from "~/lib/list-title";
import { listCovered, usePage } from "~/lib/page";
import { pressRow, releaseRow } from "~/lib/select";

/** plan 87: the Inbox top's label and the gap after it (px; a row's height comes from the design) */
/**
 * What covers the list's last rows now: List's pinned draft (Split's is over the reader, plan 158), and Split's pinned
 * answer where it reaches over the list (plan 165). Plan 160: List's toast covers none, the list's viewport ends above it;
 * the draft covers only what reaches past the toast's room.
 */
const pinnedOver = (snack: number, pinned: number): number => Math.max(0, bottomInset(snack, pinned) - snack);
const askOverList = (): number => (usePinnedAsk.getState().overList ? usePinnedAsk.getState().inset : 0);
const listInset = (): number => (useAppearance.getState().layout === "list" ? pinnedOver(listCovered() ? 0 : useSnack.getState().inset, pinnedInsetNow()) : askOverList());

const TOP_LABEL = 28;
const EMPTY_GROUPS: readonly TodayGroup[] = [];

/** Plan 145: what the rows under it are, drawn in space the row above leaves. Not a stop for arrow keys: a listbox holds only its options. */
function TodayHeading({ kind, top }: { kind: TodayGroup["kind"]; top: number }) {
  // plan 162 (after ai162-r01): a section's name in the ink at the rows' size, a real heading (it was a 12 px grey label,
  // quieter than the digest's row above it)
  return (
    <div aria-hidden data-testid="today-heading" data-kind={kind} className="absolute inset-x-0 flex items-end px-5 pb-1 text-sm font-medium text-foreground" style={{ top, height: TOP_LABEL }}>
      {sectionName(kind)}
    </div>
  );
}

/** Each of Today's sections has a heading of its own, in the sections' style. */
const SECTION_NAME = { needsYou: "today.needsYou", reminders: "today.reminders" } as const satisfies Record<TodayGroup["kind"], string>;

/** Plan 162 (Codex review): a section's name, said to assistive tech by its first row (the drawn heading is aria-hidden) */
function sectionName(kind: TodayGroup["kind"]): string;
function sectionName(kind: TodayGroup["kind"] | undefined): string | undefined;
function sectionName(kind: TodayGroup["kind"] | undefined): string | undefined {
  return kind ? t(SECTION_NAME[kind]) : undefined;
}

/**
 * Plan 162 (after ai162-r02): the digest's way in, in Today's header under its sentence: above the fold and never before a
 * person (as the list's first row it led a page that says these need you; after them it fell below the fold, ai-r00).
 * After ai162-r05: a row in the list's anatomy, not a caption (it was the smallest thing on the page: five reports): its
 * glyph in an avatar's tile, its count line at the sender's size and weight, under it who they're from, a chevron. List's
 * one-line header holds it on the title's line, one line at the row's size. The selection's fill while the digest is
 * open; its test id is the row's it replaced.
 */
export function TodayDigestEntry({ inline }: { /** List's full-width title row: beside the sentence, at its own width */ inline?: boolean }) {
  const digest = useToday((s) => s.digest);
  const selected = useApp((s) => s.selectedId === DIGEST_ROW_ID);
  if (!digest) return null;
  const from = digestFrom(digest, getLocale());
  return (
    <button
      type="button"
      data-testid="digest-row"
      aria-current={selected ? "true" : undefined}
      // every fill starts at 8 px, as a row's selection does; the tile on the header's text edge
      className={cn(
        "no-drag flex min-w-0 cursor-pointer items-center rounded-lg text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        inline ? "h-8 max-w-[44cqw] shrink-0 gap-2 ps-2 pe-1.5" : "-ms-3 mt-1.5 w-[calc(100%+0.75rem)] gap-3 py-1.5 ps-3 pe-2",
        selected ? "bg-row-selected text-row-selected-foreground" : "text-foreground hover:bg-row-hover",
      )}
      // the ordinary row's press and release (Codex review): a bulk selection ends, as opening any row ends it
      onClick={() => {
        pressRow(DIGEST_ROW_ID, { meta: false, ctrl: false, shift: false });
        releaseRow(DIGEST_ROW_ID);
      }}
    >
      <span aria-hidden data-testid="digest-row-tile" className={cn("grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4", inline ? "size-6" : "size-8")}>
        <Newspaper />
      </span>
      <span className="sr-only">{t("today.newsletters")}, </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate type-row-from font-medium" data-testid="digest-row-title">{digestLabel(digest)}</span>
        {!inline && from && <span className={cn("block truncate text-xs", !selected && "text-muted-foreground")} data-testid="digest-row-from">{from}</span>}
      </span>
      <ChevronRight aria-hidden className={cn("size-4 shrink-0", !selected && "text-muted-foreground")} />
    </button>
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
  const fit = m.widths.length === rest.length ? fitStrip({ widths: m.widths, available: m.available, pinned: m.all, more: m.more, gap: CHIP_GAP, selected: filter ? rest.indexOf(filter) : -1 }) : { visible: rest.map((_, i) => i), overflow: [] };
  const visible = ["all" as const, ...fit.visible.map((i) => rest[i]!)];
  const overflow = fit.overflow.map((i) => rest[i]!);
  const chip = "h-7 shrink-0 rounded-full px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground data-pressed:bg-muted data-pressed:text-foreground";
  const label = (f: QuickFilter | "all") => (f === "all" ? t("list.filter.all") : filterName(f));
  return (
    <div ref={stripRef} className="no-drag relative flex min-w-0 flex-1 items-center gap-1.5 py-0.5">
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
                {t("list.filter.overflow")}
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
            {t("list.filter.overflow")}
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
        // a link button (BoardUI's secondary link) that shows what it says: on, it stays underlined in the ink, its chip beside.
        // Plan 159: what counts, in words, on hover and as its description (it can be more than what's unread)
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="link-secondary"
                data-testid="waiting-count"
                aria-pressed={filter === "waiting"}
                aria-description={t("list.waitingCount.tip")}
                className={COUNT_LINK}
                onClick={() => setListFilter(filter === "waiting" ? undefined : "waiting")}
              >
                {t("list.waitingCount", { count: waiting })}
              </Button>
            }
          />
          <TooltipContent data-testid="waiting-count-tip" className="max-w-72">{t("list.waitingCount.tip")}</TooltipContent>
        </Tooltip>
      )}
      {unread === 0 && waiting === 0 && t("list.caughtUp")}
      </span>
    </p>
  );
}

/**
 * Plan 161: Today's numbers in words, under its title in every header. Pass 3: one sentence, never a second total to read
 * against the Inbox's: what the list is ("Showing 12 of 41", 41 being the sidebar's count; plan 162) and, when it's
 * capped, the way to the rest by the Inbox filter's own name. The digest's way in is the list's first row.
 */
export function TodayLine() {
  const needs = useApp((s) => s.counts.today ?? null);
  const shown = useToday((s) => s.needsShown);
  const more = useToday((s) => s.more);
  const count = needs ?? shown;
  const capped = needs !== null && needs > shown && shown > 0;
  return (
    // plan 162 (after ai162-r01): what the list is, as a sentence ("The newest 12 of 41 that need you"), and apart from it a
    // way to the rest named by its place, the Inbox, a 24 px target (the filter's name in the sentence read as a typo)
    <p data-testid="today-line" className="type-list-subtitle flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground tabular">
      {count > 0 && <span data-testid="today-needs" className="text-foreground">{capped ? t("today.line.newest", { count, shown }) : t("today.line.needs", { count })}</span>}
      {more > 0 && (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="link-secondary"
                  data-testid="today-more"
                  aria-description={t("today.line.moreTip", { filter: t("list.filter.waiting") })}
                  className={cn(COUNT_LINK, "-mx-1 inline-flex h-6 items-center gap-0.5 rounded-md px-1 font-medium")}
                  onClick={() => {
                    navigate({ view: "inbox" });
                    setListFilter("waiting");
                  }}
                >
                  {t("today.line.more")}
                  <ChevronRight aria-hidden className="size-[1.15em]" />
                </Button>
              }
            />
            <TooltipContent className="max-w-72">{t("today.line.moreTip", { filter: t("list.filter.waiting") })}</TooltipContent>
          </Tooltip>
        </>
      )}
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
  const followups = useApp((s) => s.followups);
  const account = useApp((s) => s.accounts.find((a) => a.id === s.accountId));
  const query = useApp((s) => s.query);
  const soloName = useApp((s) => (s.soloAccountId === null ? null : (s.accounts.find((a) => a.id === s.soloAccountId)?.displayName ?? null)));
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
  // plan 159: Review says what it's for; the category in view is its switcher's, under the title
  const title = searching ? t("list.search.title") : review ? t("sidebar.sort") : today ? t("today.title") : followups ? t("followups.title") : reminders ? t("view.reminders") : (folder ?? category?.name ?? viewLabel(view));
  // the title names the mailbox; the greeting is the words under the inbox's (any account; not a Gmail tab of it, plan 86)
  const kind = design.variants.listHeader === "greeting" && view === "inbox" && !folder && !category && !review && !searching ? "greeting" : design.variants.listHeader === "title" ? "title" : "display";
  const behindButton = design.variants.search === "button";
  const quick = design.variants.quickFilters;
  const list = useAppearance((s) => s.layout === "list");
  const showField = !behindButton || searchOpen || query !== "";
  // List's selection toolbar stands on this line: what's under it can't be reached until it goes
  const covered = useApp((s) => list && (s.scope !== null || s.checked.size >= 1));
  // in the field's own words (plan 158: "in saved mail" was a term nobody knew); the few-results note says what's looked through
  const counted = more ? t("list.search.resultsMore", { count }) : t("list.search.results", { count });
  const results = soloName === null ? t("list.search.inAll", { results: counted }) : t("list.search.inAccount", { results: counted, account: soloName });
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
        <div inert={covered} className="flex h-(--pane-bar) min-w-0 items-center gap-3 pr-1.5 pl-3">
          <h1 className={cn("min-w-0 max-w-[40cqw] truncate", LIST_TITLE[kind])} data-testid="list-title">
            {title}
            {accountSuffix}
            {filterSuffix}
          </h1>
          {query && (searchMs !== null || searchAll) ? (
            <p className="flex shrink-0 items-center gap-2">
              {stats}
              {searchAll}
            </p>
          ) : review ? (
            <ReviewSwitcher />
          ) : today ? (
            <>
              <TodayLine />
              <TodayDigestEntry inline />
            </>
          ) : (
            kind !== "title" && <Subtitle filter={filter} greeting={kind === "greeting"} />
          )}
          {/* what the row leaves stays empty: the controls keep the right edge */}
          <div className="min-w-0 flex-1" />
          {filterControl}
          {showField && (
            <div className="w-[clamp(14.5rem,24cqw,20rem)] shrink-0">
              <ListSearch />
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2 empty:hidden">{actions}</div>
        </div>
      ) : kind === "title" ? (
        <div inert={covered} className="flex h-(--pane-bar) items-center gap-2 pr-1.5 pl-3">
          <h1 className={cn("min-w-0 flex-1 truncate", LIST_TITLE.title)} data-testid="list-title">
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
          <div inert={covered} className="flex h-(--pane-bar) items-center gap-2 pr-1.5 pl-3">
            <h1 className={cn("min-w-0 flex-1 truncate", LIST_TITLE[kind])} data-testid="list-title">
              {title}
              {accountSuffix}
              {filterSuffix}
            </h1>
            {filterControl}
            <div className="flex shrink-0 items-center gap-0.5 empty:hidden">{actions}</div>
          </div>
          {/* gives way as the list scrolls (at once: moving through a list never animates), unless it says what a search found */}
          {!review && <div
            // plan 161: Today's line is its way to the digest: it stays
            data-keep={query || today ? true : undefined}
            // on a short window it gives its room to the rows (the counts are the sidebar's too), unless it says what a search found
            className="-mt-1.5 pb-2 pl-3 group-data-scrolled/list:not-data-keep:hidden [@media(max-height:760px)]:not-data-keep:hidden"
          >
            {query && (searchMs !== null || searchAll) ? (
              <p className="flex items-center gap-2">
                {stats}
                {searchAll}
              </p>
            ) : today ? (
              <>
                <TodayLine />
                <TodayDigestEntry />
              </>
            ) : (
              <Subtitle filter={filter} greeting={kind === "greeting"} />
            )}
          </div>}
        </>
      )}
      {/* plan 161: the title row has no subtitle line: Today's numbers and its digest get one of their own */}
      {!oneRow && kind === "title" && today && !searching && (
        <div className="-mt-1.5 pb-2 pl-3">
          <TodayLine />
          <TodayDigestEntry />
        </div>
      )}
      {/* plan 159: Review's switcher on a line of its own under the title, in every header (it never gives way: it's where you are) */}
      {!oneRow && review && !searching && (
        <div className="-mt-1.5 pb-2 pl-3">
          <ReviewSwitcher />
        </div>
      )}
      {!oneRow && showField && <ListSearch />}
      {/* plan 158: the compact title row keeps its title and controls in a search: what it found goes under the field, on its text's line */}
      {underField && (
        <p className="flex items-center gap-2 px-3 pt-1.5">
          {stats}
          {searchAll}
        </p>
      )}
      {!review && !reminders && quick === "chips" && (
        <div className="mt-1 flex min-w-0 items-center pl-3">
          <QuickChips filter={filter} />
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
  // (scrolling allowed: a sidebar scrolled past its current view brings it back into sight with the focus). No sidebar row
  // is current during a search (plan 158), so an empty search hands it to the Inbox's
  (visible(document.querySelector<HTMLElement>("[data-testid=unread-empty-clear]")) ??
    visible(document.querySelector<HTMLElement>("#app-sidebar button[data-active]")) ??
    visible(document.querySelector<HTMLElement>("#app-sidebar [data-testid=nav-inbox]")))?.focus();
}

function EmptyState() {
  const query = useApp((s) => s.query);
  const view = useApp((s) => s.view);
  const reminders = useApp((s) => s.reminders);
  const followups = useApp((s) => s.followups);
  const today = useApp((s) => s.today);
  const review = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const reviewLeft = useApp((s) => (s.reviewCategoryId === null ? 0 : reviewTotals(s.categories, s.counts.categorySuggestions).total));
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
  // plan 159: Review's last one answered: it stays (Undo brings the rows back here), and says where to go on
  if (review)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
        <Tags className="mb-2 size-7 text-muted-foreground" aria-hidden />
        <p className="text-lg font-semibold tracking-tight">{t("review.empty.title")}</p>
        <p className="text-xs text-muted-foreground">{reviewLeft > 0 ? t("review.empty.more", { category: review.name }) : t("review.empty.none")}</p>
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
  // plan 161: a preview still finding, with no row yet, is loading: its skeleton, never an empty state, and its focus stays
  const inPreview = useApp((s) => s.actionPreview !== null);
  const scanning = useActionPreview((s) => s.preview?.scanning === true);
  const loading = useList((s) => s.loading) || (inPreview && scanning && items.length === 0);
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
  // (a page over List's rows has the toast: the rows keep their viewport under it)
  const page = usePage();
  const toastOver = over && page === "list";
  const toastRoom = useSnack((s) => (toastOver ? s.inset : 0));
  const askOver = usePinnedAsk((s) => (!over && s.overList ? s.inset : 0));
  const dock = pinnedOver(toastRoom, Math.max(usePinnedInset(over), askOver));
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
  // plan 159: as tall as it's laid out (it wraps rather than cutting the rule)
  const lead = learned.proposal && !previewing ? learned.height : 0;
  const leadRef = useRef(lead);
  leadRef.current = lead;
  const inToday = useApp((s) => s.today);
  const todayGroups = useToday((s) => (inToday ? s.groups : EMPTY_GROUPS));
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // plan 145: a section's heading is space under the row before it, or above the first
    estimateSize: (i) => height + (i === top - 1 ? topGap : 0) + (todayGroups.some((g) => g.at === i + 1) ? TOP_LABEL : 0),
    paddingStart: lead + (top > 0 || todayGroups.some((g) => g.at === 0) ? TOP_LABEL : 0),
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

  // the dock came up over the open thread's row, or the toast's room grew over it: it moves up into view, once (after the
  // padded spacer is in). Only a row that was in view: one the user had scrolled away stays where they left it (Codex review)
  const lastToastRoom = useRef(0);
  useEffect(() => {
    const grew = Math.max(0, toastRoom - lastToastRoom.current);
    lastToastRoom.current = toastRoom;
    const el = parentRef.current;
    const id = getApp().selectedId;
    const i = id === null ? undefined : useList.getState().index.get(id);
    if ((!dock && !toastRoom) || !el || i === undefined) return;
    const row = virtualizer.measurementsCache[i];
    const bottom = el.scrollTop + el.clientHeight;
    // where the viewport ended before the toast's room grew
    const before = bottom + grew;
    if (row && row.start < before && row.end > el.scrollTop && row.end > bottom - dock) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [dock, toastRoom]);

  useEffect(() => {
    const [root, sentinel, header, section] = [parentRef.current, sentinelRef.current, headerRef.current, sectionRef.current];
    if (!root || !sentinel) return;
    // the header's hairline, and (on the section, for the header and the banner under it) what gives way to the list
    const offs = [header && installScrollHairline(root, sentinel, header), section && installScrollHairline(root, sentinel, section)];
    return () => offs.forEach((off) => off?.());
  }, []);

  // drag rows onto sidebar categories: one delegated listener on the listbox
  useEffect(() => (parentRef.current ? installDragController(parentRef.current) : undefined), []);

  // plan 158: the cursor moved by keys keeps a row of look-ahead each way, so the next row always shows (never the
  // cursor pinned against the edge or the draft dock)
  useEffect(() => {
    listScroller.scrollToIndex = (i) => {
      const el = parentRef.current;
      const rows = virtualizer.measurementsCache;
      if (!el || !rows[i]) return virtualizer.scrollToIndex(i, { align: "auto" });
      const at = rows[i]!, after = rows[Math.min(i + 1, rows.length - 1)]!, before = rows[Math.max(i - 1, 0)]!;
      const room = el.clientHeight - (virtualizer.options.scrollPaddingEnd ?? 0);
      const bottom = el.scrollTop + room;
      // the cursor's own row first: where a row of look-ahead doesn't fit with it (a tall pinned card), only it shows whole
      if (after.end > bottom) virtualizer.scrollToIndex(after.end - at.start <= room ? after.index : i, { align: "end" });
      else if (before.start < el.scrollTop) virtualizer.scrollToIndex(at.end - before.start <= room ? before.index : i, { align: "start" });
    };
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
      {/* the listbox is one Tab stop and restores focus when a page closes */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <LearnedSource />
      {learned.proposal && lead > 0 && <LearnedBanner proposal={learned.proposal} scroller={parentRef} />}
      <ThreadMenu>
      <div ref={parentRef} data-keep-scroll="list" role={items.length > 0 ? "listbox" : "group"} tabIndex={items.length > 0 ? 0 : -1} onFocus={(e) => empty && e.target === e.currentTarget && leaveEmptyList()} aria-label={t("list.label")} aria-multiselectable={items.length > 0 ? true : undefined} className="@container/rows relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [contain:strict]" style={toastRoom ? { marginBottom: toastRoom } : undefined}>
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
            {/* plan 161, pass 2: each heading from its row's real offset (the digest's row is shorter than the rest) */}
            {todayGroups.map((g) => (
              <TodayHeading key={g.kind} kind={g.kind} top={(virtualizer.measurementsCache[g.at]?.start ?? lead + TOP_LABEL) - TOP_LABEL} />
            ))}
            {virtualItems.map((v) => (
              <ThreadRow key={v.key} thread={items[v.index]!} top={v.start} height={height} compact={compact} wide={wide} showAccount={showAccount} icons={icons} layout={layout} review={review} reminderTop={v.index < top} reminderEnd={topGap > 0 && v.index === top - 1} match={match} pick={list} section={sectionName(todayGroups.find((g) => g.at === v.index)?.kind)} />
            ))}
          </div>
        )}
      </div>
      </ThreadMenu>
      {/* plan 158: the Review rows' answers as buttons, outside the listbox (a row is an option, which holds none) */}
      {review !== null && items.length > 0 && <ReviewButtons scroller={parentRef} tick={`${itemsKey}|${virtualItems.map((v) => v.key).join()}|${virtualizer.scrollOffset}|${virtualItems.length}|${virtualItems[0]?.index}|${items.length}|${virtualizer.getTotalSize()}|${height}|${wide}|${virtualizer.scrollRect?.width}|${virtualizer.scrollRect?.height}`} />}
      {review !== null && <ReviewAlwaysMenu />}
      {filter && !loading && items.length === 0 && itemsKey === listKey() && <UnreadEmptyState filter={filter} />}
      {coverage && items.length > 0 && <CoverageNote className="pointer-events-none absolute inset-x-0 px-5 pt-3" style={{ top: virtualizer.getTotalSize() }} />}
      </div>
      {/* plan 158: nothing with the results that isn't one */}
      {!previewing && !searching && <DraftsStrip />}
    </section>
  );
}

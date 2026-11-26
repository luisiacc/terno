import { formatNumber, t } from "@terno/i18n";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { SearchField } from "@terno/ui/components/search-field";
import { Shortcut } from "@terno/ui/components/shortcut";
import { cn } from "@terno/ui/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { LIST_TITLE } from "~/lib/list-title";
import { enterPerson, enterSearch, loadPeople, morphName, peopleList, reloadPage, searchPeople, selectPerson } from "~/lib/people";
import { renderProbe } from "~/lib/render-probe";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { useAppearance } from "~/lib/appearance";
import { useDesign } from "~/lib/design";
import { useApp } from "~/state/app";
import { indexOf, matchedParts, peopleRows, usePeople, type PeopleRow } from "~/state/people";
import { Marked } from "../match-mark";
import { SenderAvatar } from "../sender-avatar";
import { itemGlyph, itemParts, itemWhen } from "./person-item";
import { PersonPage } from "./person-page";

/** where the list was left: coming back to People finds it there */
const kept = { top: 0 };

/**
 * Plan 281: People's list, in the list pane: its title, how many have something open, the search (names and addresses,
 * never content), then Open (who has something open with you, most pressing first) and Everyone (those you've written to,
 * best first), one virtualized list. A row selects its person: their page shows in the reader (Split), or here over the
 * list (List, with "‹ People" back).
 */
export function People() {
  const list = useAppearance((s) => s.layout === "list");
  const onPage = useApp((s) => s.person !== null) && list;
  const pane = useRef<HTMLDivElement>(null);
  // List: the page covers the list it was opened from, which goes inert: the keyboard moves to the page (its way back),
  // quietly, rather than dropping to nowhere
  useEffect(() => {
    if (!onPage) return;
    const from = document.activeElement;
    if (from === document.body || from === null || from.closest("[inert]")) pane.current?.querySelector<HTMLElement>("[data-testid=person-back]")?.focus({ preventScroll: true });
  }, [onPage]);
  // List: the person's page is this pane's, over the list (kept laid out under it: its scroll and place stay)
  return (
    <div className="relative h-full min-h-0">
      <div className={cn("h-full min-h-0", onPage && "invisible")} inert={onPage}>
        <PeopleList wide={list} />
      </div>
      {onPage && (
        <div ref={pane} className="absolute inset-0 bg-background">
          <PersonPage inList />
        </div>
      )}
    </div>
  );
}

/** List layout's pane is the window's width: People's rows keep a reading width in it, centred, as What matters' feed does */
const WIDE = "mx-auto w-full max-w-[44rem]";
/** the header's: its own padding outside the reading width, as the rows' scroller has (title, field and rows on one line) */
const WIDE_HEADER = "mx-auto w-full max-w-[45rem] pr-2";

function PeopleList({ wide }: { wide: boolean }) {
  const design = useDesign();
  const state = usePeople((s) => s.list);
  const query = usePeople((s) => s.query);
  const hits = usePeople((s) => s.hits);
  const held = usePeople((s) => s.held);
  const selected = useApp((s) => s.person);
  const rows = useMemo(() => peopleRows(state, query, hits, held), [state, query, hits, held]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]!.kind === "heading" ? 44 : 60),
    getItemKey: (i) => `${rows[i]!.kind}:${rows[i]!.id}`,
    overscan: 8,
    paddingEnd: 16,
  });

  // read when it shows (a reload of the app, or coming back from Review or a preview, lands here too), and the selected
  // person's page with it; the events keep both current after
  useEffect(() => {
    void loadPeople();
    reloadPage();
  }, []);

  const placeOf = useMemo(() => new Map(rows.flatMap((r, i) => (r.kind === "person" ? [[r.key, i] as const] : []))), [rows]);
  useEffect(() => {
    peopleList.rows = () => rows;
    peopleList.toKey = (key, focus) => {
      const i = placeOf.get(key);
      if (i === undefined) return;
      virtualizer.scrollToIndex(i, { align: "auto" });
      // the keyboard was on a row: it goes to the selected one, once it's drawn
      if (focus) requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-testid=person-row][data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }));
    };
    // (what was typed selected: typing replaces it)
    peopleList.focusSearch = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    return () => {
      peopleList.rows = peopleList.toKey = peopleList.focusSearch = undefined;
    };
  }, [virtualizer, placeOf, rows]);

  // the selected person's row comes into view when the selection changes (Open in People, j/k), never on a reload
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selected === null || selectedRef.current === selected) return;
    const i = placeOf.get(selected);
    // (once their row is drawn: coming to People with someone chosen, Open in People, j/k)
    if (i === undefined) return;
    selectedRef.current = selected;
    virtualizer.scrollToIndex(i, { align: "auto" });
  }, [selected, placeOf, virtualizer]);

  // one Tab stop for the rows: the selected person's, else the first (the arrows, j and k move within); when that row
  // isn't drawn (scrolled far off), the first that is, so Tab always lands on a person
  const drawn = virtualizer.getVirtualItems();
  const preferred = selected !== null && placeOf.has(selected) ? selected : (rows.find((r) => r.kind === "person")?.id ?? null);
  const preferredAt = preferred === null ? undefined : placeOf.get(preferred);
  const firstDrawn = drawn.map((v) => rows[v.index]).find((r) => r?.kind === "person")?.id ?? null;
  const tabKey = preferredAt !== undefined && drawn.some((v) => v.index === preferredAt) ? preferred : (firstDrawn ?? preferred);

  // coming back, where it was left; leaving, where that is
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = kept.top;
    return () => void (kept.top = el?.scrollTop ?? 0);
  }, []);

  useEffect(() => {
    const [root, sentinel, header] = [scrollRef.current, sentinelRef.current, headerRef.current];
    return root && sentinel && header ? installScrollHairline(root, sentinel, header) : undefined;
  }, []);

  const failed = usePeople((s) => s.failed);
  const openCount = state?.open.length ?? 0;
  const index = indexOf(state);
  const searching = query.trim() !== "";
  const empty = state !== null && rows.length === 0;
  const everyoneCount = (rows.find((r) => r.kind === "heading" && r.id === "everyone") as Extract<PeopleRow, { kind: "heading" }> | undefined)?.count ?? 0;
  /** a section's heading to the top of the list (the header's jump) */
  const jump = (id: "open" | "everyone") => {
    const i = rows.findIndex((r) => r.kind === "heading" && r.id === id);
    if (i < 0) return;
    virtualizer.scrollToIndex(i, { align: "start" });
    // and the keyboard to its first person (else it stays on the jump, and Tab has the rows to find)
    const first = rows[i + 1];
    if (first?.kind === "person") requestAnimationFrame(() => peopleList.toKey?.(first.key, true));
  };
  return (
    <section className="relative flex h-full min-h-0 flex-col bg-pane" data-testid="people">
      <header ref={headerRef} className={cn("drag-region scroll-hairline shrink-0 pr-4 pb-2 pl-2", wide && WIDE_HEADER)}>
        <div className="flex h-(--pane-bar) items-center pr-1.5 pl-3">
          <h1 className={cn("min-w-0 flex-1 truncate", LIST_TITLE[design.variants.listHeader === "title" ? "title" : "display"])} data-testid="list-title">
            {t("people.title")}
          </h1>
        </div>
        {/* what's here: a search's count, or each section's, each a jump to it (Everyone is under the whole of Open) */}
        <p data-testid="people-line" aria-live={searching ? "polite" : undefined} className="type-list-subtitle -mt-1.5 flex min-h-[1lh] items-center gap-1 pb-2 pl-3 text-muted-foreground tabular">
          {searching ? (
            hits && t("people.found", { count: hits.hits.length })
          ) : (
            <>
              {openCount > 0 && (
                <Button variant="link-secondary" size="xs" data-testid="people-jump-open" className="h-auto px-0 text-[length:inherit] font-normal" onClick={() => jump("open")}>
                  {t("people.openLine", { count: openCount })}
                </Button>
              )}
              {openCount > 0 && everyoneCount > 0 && <span aria-hidden>·</span>}
              {everyoneCount > 0 && (
                <Button variant="link-secondary" size="xs" data-testid="people-jump-everyone" className="h-auto px-0 text-[length:inherit] font-normal" onClick={() => jump("everyone")}>
                  {t("people.everyoneLine", { count: everyoneCount })}
                </Button>
              )}
            </>
          )}
        </p>
        <SearchField
          className="no-drag"
          ref={(el) => {
            inputRef.current = el;
          }}
          data-testid="people-search"
          value={query}
          placeholder={t("people.search")}
          aria-label={t("people.search")}
          clearLabel={t("people.searchClear")}
          hint={<Shortcut keys="/" />}
          fieldClassName="h-[30px] bg-tint text-sm dark:bg-tint"
          onValueChange={searchPeople}
          clearOnEscape={false}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              // the query first, then the field
              if (query) searchPeople("");
              else if (tabKey !== null) peopleList.toKey?.(tabKey, true);
              return;
            }
            // Enter opens the first person (of what's typed, once its answer is in); ↓ goes onto the rows
            if (e.key === "Enter") {
              e.preventDefault();
              return enterSearch();
            }
            if (e.key !== "ArrowDown") return;
            const first = rows.find((r) => r.kind === "person");
            if (!first || first.kind !== "person") return;
            e.preventDefault();
            const to = rows.find((r) => r.kind === "person" && r.key === tabKey) ?? first;
            if (to.kind !== "person") return;
            if (!wide) selectPerson(to.key, to.email);
            peopleList.toKey?.(to.key, true);
          }}
        />
      </header>
      <div ref={scrollRef} tabIndex={-1} data-morph-clip data-testid="people-rows" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 [scrollbar-gutter:stable]">
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        <ul aria-label={t("people.list")} className={cn("relative", wide ? WIDE : "w-full")} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]!;
            return (
              <li key={v.key} ref={virtualizer.measureElement} data-index={v.index} aria-setsize={rows.length} aria-posinset={v.index + 1} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)` }}>
                {row.kind === "heading" ? <Heading row={row} /> : <PersonRow row={row} selected={row.key === selected} tabbable={row.key === tabKey} query={searching ? query : ""} />}
              </li>
            );
          })}
        </ul>
        {/* what the list says when it holds nobody, or not yet, or its read failed */}
        {failed && state === null ? (
          <p data-testid="people-note" role="alert" className={cn("flex items-center gap-2 px-3 pt-3 text-sm text-muted-foreground", wide && WIDE)}>
            {t("people.listFailed")}
            <Button variant="link-secondary" size="xs" data-testid="people-retry" className="px-0" onClick={() => void loadPeople()}>
              {t("common.retry")}
            </Button>
          </p>
        ) : (
          (empty || (!searching && index !== "ready") || (searching && hits?.index === "warming")) && (
            <p data-testid="people-note" className={cn("px-3 pt-3 text-sm text-muted-foreground", wide && WIDE)}>
              {searching ? (hits?.index === "warming" ? t("people.warming") : hits ? t("people.noHits", { query: query.trim() }) : null) : index === "warming" ? t("people.warming") : index === "off" ? t("people.off") : t("people.empty")}
            </p>
          )
        )}
      </div>
    </section>
  );
}

/**
 * A section's heading: its title in the list's section type, its count in BoardUI's neutral badge (What matters' own);
 * Everyone says its order.
 */
function Heading({ row }: { row: Extract<PeopleRow, { kind: "heading" }> }) {
  return (
    <h2 data-testid="people-heading" data-kind={row.id} className="flex items-baseline gap-2 px-3 pt-5 pb-1.5 text-base font-semibold text-foreground">
      {t(row.id === "open" ? "people.section.open" : "people.section.everyone")}
      <Badge variant="neutral" className="tabular self-center">
        {formatNumber(row.count)}
      </Badge>
      {row.id === "everyone" && <span className="ms-auto min-w-0 truncate text-xs font-normal text-muted-foreground">{t("people.everyoneOrder")}</span>}
    </h2>
  );
}

/**
 * A person: their face and name, when, and under it what's most pressing between you (and how many more), or their
 * address. `data-morph` names the row for an act's morph: it moves (from Open to Everyone) in the same change as the page.
 */
const PersonRow = memo(function PersonRow({ row, selected, tabbable, query }: { row: Extract<PeopleRow, { kind: "person" }>; selected: boolean; /** the rows' one Tab stop */ tabbable: boolean; /** a search's words: what they matched is marked */ query: string }) {
  renderProbe("PeopleRow");
  // what's open now leads; something put off with Later only when that's all there is
  const first = row.open?.items.find((i) => !itemWhen(i).later) ?? row.open?.items[0];
  const parts = first ? itemParts(first) : null;
  const Glyph = first ? itemGlyph(first) : null;
  // the right column is what's open's when: with nothing open, none (the page says when you last wrote each other)
  const when = first ? itemWhen(first) : { text: null, late: false, later: false };
  // what else is open now (what's put off waits on their page, under Put off)
  const items = row.open?.items ?? [];
  const now = items.filter((i) => !itemWhen(i).later).length;
  const more = (now || items.length) - 1;
  // held in place with nothing open any more (their last item just done)
  const cleared = row.open !== null && row.open.items.length === 0;
  return (
    <button
      type="button"
      data-morph={morphName("p", row.key)}
      data-testid="person-row"
      data-key={row.key}
      aria-current={selected || undefined}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => selectPerson(row.key, row.email)}
      onKeyDown={(e) => {
        // into their page: Enter (the button's own click selects them too) and →
        if (e.key !== "Enter" && e.key !== "ArrowRight") return;
        e.preventDefault();
        enterPerson(row.key, row.email);
      }}
      className={cn(
        "group/row relative flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-row-selected text-row-selected-foreground" : "hover:bg-row-hover focus:bg-row-hover",
      )}
    >
      <SenderAvatar name={row.name} email={row.email} person className="size-8 text-xs" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="type-row-from min-w-0 flex-1 truncate">
            <Marked text={row.name} needles={undefined} parts={query ? matchedParts(row.name, query) : null} testId="people-match" />
          </span>
          {when.text && <span className={cn("shrink-0 text-sm tabular", selected ? "text-row-selected-foreground" : when.late ? "font-medium text-destructive-ink" : "text-row-preview")}>{when.text}</span>}
        </span>
        <span className={cn("mt-0.5 flex min-w-0 items-center gap-1.5 text-sm", selected ? "text-row-selected-foreground" : "text-row-preview")}>
          {first && Glyph ? (
            <>
              <Glyph aria-hidden className="size-[1.15em] shrink-0 opacity-80" />
              {/* what's open, in words: its kind, then what */}
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{parts!.label}</span> · {parts!.text}
              </span>
              {more > 0 && (
                <Badge variant="neutral" className="ms-auto tabular" title={t("people.moreSaid", { count: more })}>
                  <span aria-hidden>{t("people.more", { count: more })}</span>
                  <span className="sr-only">{t("people.moreSaid", { count: more })}</span>
                </Badge>
              )}
            </>
          ) : cleared ? (
            <span className="min-w-0 truncate">{t("people.noOpen")}</span>
          ) : (
            <span className="min-w-0 truncate">
              <Marked text={row.email} needles={undefined} parts={query ? matchedParts(row.email, query) : null} testId="people-match" />
            </span>
          )}
          {!first && row.openCount > 0 && (
            <Badge variant="neutral" className="tabular">
              {t("people.openCount", { count: row.openCount })}
            </Badge>
          )}
        </span>
      </span>
      {!selected && <span aria-hidden className="hairline-b pointer-events-none absolute start-14 end-3 -bottom-px group-hover/row:invisible" />}
    </button>
  );
});


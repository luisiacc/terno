import { formatNumber, t } from "@terno/i18n";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { SearchField } from "@terno/ui/components/search-field";
import { Shortcut } from "@terno/ui/components/shortcut";
import { cn } from "@terno/ui/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { listDate } from "~/lib/format";
import { LIST_TITLE } from "~/lib/list-title";
import { enterPerson, loadPeople, morphName, peopleList, reloadPage, searchPeople, selectPerson } from "~/lib/people";
import { renderProbe } from "~/lib/render-probe";
import { installScrollHairline } from "~/lib/scroll-hairline";
import { useAppearance } from "~/lib/appearance";
import { useApp } from "~/state/app";
import { indexOf, matchedParts, peopleRows, usePeople, type PeopleRow } from "~/state/people";
import { Marked } from "../match-mark";
import { SenderAvatar } from "../sender-avatar";
import { itemGlyph, itemLine, itemParts, itemWhen, kindSaid } from "./person-item";
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

function PeopleList({ wide }: { wide: boolean }) {
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
    peopleList.focusSearch = () => inputRef.current?.focus();
    return () => {
      peopleList.rows = peopleList.toKey = peopleList.focusSearch = undefined;
    };
  }, [virtualizer, placeOf, rows]);

  // the selected person's row comes into view when the selection changes (Open in People, j/k), never on a reload
  const selectedRef = useRef(selected);
  useEffect(() => {
    if (selected === null || selectedRef.current === selected) return;
    selectedRef.current = selected;
    const i = placeOf.get(selected);
    if (i !== undefined) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [selected, placeOf, virtualizer]);

  // one Tab stop for the rows: the selected person's, else the first (the arrows, j and k move within)
  const tabKey = selected !== null && placeOf.has(selected) ? selected : (rows.find((r) => r.kind === "person")?.id ?? null);

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
  const line = searching ? (hits ? t("people.found", { count: hits.hits.length }) : null) : openCount > 0 ? t("people.openLine", { count: openCount }) : null;
  return (
    <section className="relative flex h-full min-h-0 flex-col bg-pane" data-testid="people">
      <header ref={headerRef} className={cn("drag-region scroll-hairline shrink-0 pr-4 pb-2 pl-2", wide && WIDE)}>
        <div className="flex h-(--pane-bar) items-center pr-1.5 pl-3">
          <h1 className={cn("min-w-0 flex-1 truncate", LIST_TITLE.title)} data-testid="list-title">
            {t("people.title")}
          </h1>
        </div>
        <p data-testid="people-line" className="type-list-subtitle -mt-1.5 min-h-[1lh] pb-2 pl-3 text-muted-foreground tabular">
          {line}
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
              else e.currentTarget.blur();
              return;
            }
            // ↓ onto the first row; Enter opens it (the first match, while searching)
            if (e.key !== "ArrowDown" && e.key !== "Enter") return;
            const first = rows.find((r) => r.kind === "person");
            if (!first || first.kind !== "person") return;
            e.preventDefault();
            if (e.key === "Enter") selectPerson(first.key, first.email);
            peopleList.toKey?.(e.key === "Enter" ? first.key : (tabKey ?? first.key), true);
          }}
        />
      </header>
      <div ref={scrollRef} data-morph-clip data-testid="people-rows" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 [scrollbar-gutter:stable]">
        <div ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
        <ul aria-label={t("people.list")} className={cn("relative", wide ? WIDE : "w-full")} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]!;
            return (
              <li key={v.key} ref={virtualizer.measureElement} data-index={v.index} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)` }}>
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
  const first = row.open?.items[0];
  const parts = first ? itemParts(first) : null;
  const Glyph = first ? itemGlyph(first) : null;
  const when = first ? itemWhen(first) : { text: row.last ? listDate(row.last) : null, late: false, later: false };
  const more = (row.open?.items.length ?? 0) - 1;
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
      // (its open item, in words: the glyph and a kind left unsaid are said here)
      aria-description={first ? itemLine(first) : undefined}
      onClick={() => selectPerson(row.key, row.email)}
      onKeyDown={(e) => {
        // into their page: Enter (the button's own click selects them too) and →
        if (e.key !== "Enter" && e.key !== "ArrowRight") return;
        e.preventDefault();
        enterPerson(row.key, row.email);
      }}
      className={cn(
        "group/row relative flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-row-selected text-row-selected-foreground" : "hover:bg-row-hover",
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
              {/* what it is first; its kind only when it isn't the usual one (a reply waiting on you) */}
              <span className="min-w-0 flex-1 truncate">
                {kindSaid(first) && <span className="font-medium">{parts!.label} · </span>}
                {parts!.text}
              </span>
              {more > 0 && (
                <Badge variant="neutral" className="ms-auto tabular">
                  {t("people.more", { count: more })}
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


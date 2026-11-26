import { formatAddressList, personItemId, type PersonPage as Page } from "@terno/core";
import { formatNumber, t } from "@terno/i18n";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { Skeleton } from "@terno/ui/components/skeleton";
import { ChevronLeft, Copy, SquarePen, Users } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { composeLanding } from "~/lib/compose";
import { listDate } from "~/lib/format";
import { leavePerson, morphName, notePagePlace, openFromPerson, pagePlaces, retryPage, takePageFocus } from "~/lib/people";
import { PANE_TITLE, PANE_TITLE_TOP, READING_COLUMN } from "~/lib/pane-lines";
import { setApp, useApp } from "~/state/app";
import { usePeople } from "~/state/people";
import { useLayoutEffect, useRef, useState } from "react";
import { SenderAvatar } from "../sender-avatar";
import { copyAddress } from "../sender-menu-items";
import { itemWhen, PersonItemLine } from "./person-item";

/**
 * Plan 281: a person's page: who they are and when you last wrote each other, a new message to them, what's open between
 * you (each item with Done and Later, its line opening its conversation) and your recent conversations. In Split it's the
 * reader's while no conversation is open; in List, the list pane's, over the People list (`inList`: "‹ People" back).
 */
export function PersonPage({ inList = false }: { inList?: boolean }) {
  const person = useApp((s) => s.person);
  const page = usePeople((s) => (s.page?.key === person ? s.page : null));
  const reading = usePeople((s) => s.reading?.key === person);
  const failed = usePeople((s) => s.pageFailed !== null && s.pageFailed.key === person);
  // Enter or → on the person's row: the keyboard comes in once the page is drawn
  useLayoutEffect(() => {
    if (page) takePageFocus();
  }, [page]);
  const scroller = useRef<HTMLDivElement>(null);
  // back from a conversation opened here: where the page was, the keyboard on the line it was opened from (once)
  useLayoutEffect(() => {
    const place = person === null || page === null ? undefined : pagePlaces.get(person);
    if (!place || !scroller.current) return;
    pagePlaces.delete(person!);
    scroller.current.scrollTop = place.top;
    if (place.from) scroller.current.querySelector<HTMLElement>(`[data-place="${CSS.escape(place.from)}"]`)?.focus({ preventScroll: true });
  }, [person, page === null]);
  if (person === null)
    return (
      <div data-testid="person-none" className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
        <Users aria-hidden className="size-5" />
        {t("people.none")}
      </div>
    );
  return (
    <section data-testid="person-page" aria-label={page?.name || page?.email} className="@container flex h-full min-h-0 flex-col bg-background data-shield:[&_[data-testid=person-item]]:pointer-events-none">
      {inList && (
        <div className={cn(READING_COLUMN, "flex h-(--pane-bar) shrink-0 items-center")}>
          <Button variant="ghost" size="sm" data-testid="person-back" aria-label={t("people.back")} aria-keyshortcuts="Escape" onClick={leavePerson} className="-ms-2.5 text-muted-foreground hover:text-foreground">
            <ChevronLeft data-icon="inline-start" />
            {t("people.title")}
          </Button>
        </div>
      )}
      <div
        ref={scroller}
        data-morph-clip
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        // a line that opens a conversation: where the page is, to come back to
        onClickCapture={(e) => {
          const from = (e.target as Element).closest<HTMLElement>("[data-place]")?.dataset.place ?? null;
          if (from) notePagePlace(person, e.currentTarget.scrollTop, from);
        }}
      >
        <div className={cn(READING_COLUMN, inList ? "pt-2" : PANE_TITLE_TOP, "pb-16")}>
          {page ? (
            <Body page={page} />
          ) : reading ? (
            <Loading />
          ) : failed ? (
            <p role="alert" data-testid="person-failed" className="flex items-center gap-2 text-sm text-muted-foreground">
              {t("people.pageFailed")}
              <Button variant="link-secondary" size="xs" data-testid="person-retry" className="px-0" onClick={retryPage}>
                {t("common.retry")}
              </Button>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Loading() {
  return (
    <div className="space-y-6" data-testid="person-loading">
      <div className="flex items-center gap-4">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton shape="text" className="w-1/3" />
          <Skeleton shape="text" className="w-1/2" />
        </div>
      </div>
      <Skeleton shape="text" className="w-5/6" />
      <Skeleton shape="text" className="w-2/3" />
    </div>
  );
}

/** a page draws this many open items, then this many more each time it's asked */
const ITEMS_STEP = 30;

function Body({ page }: { page: Page }) {
  const name = page.name || page.email;
  const [shown, setShown] = useState(ITEMS_STEP);
  // what's put off with Later, apart: it's still open, further on
  const stamp = Date.now();
  const now = page.items.filter((i) => !itemWhen(i, stamp).later);
  const later = page.items.filter((i) => itemWhen(i, stamp).later);
  const newest = page.conversations[0];
  const write = () => void composeLanding("new", null, 0, () => ({ toText: formatAddressList([{ name: page.name, email: page.email }]) }), newest?.accountId);
  return (
    <>
      {/* who, and what to do with them, on one band: the page's first screen is what's open, not its header */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 pb-5">
        <SenderAvatar name={name} email={page.email} person className="size-11 text-sm" />
        {/* (the identity keeps 18rem: in a narrow pane the actions go under it rather than cutting the name or address) */}
        <div className="min-w-0 flex-1 basis-[18rem]">
          <h1 className={cn(PANE_TITLE, "truncate")} data-testid="person-name">
            {name}
          </h1>
          <p className="truncate text-sm text-muted-foreground tabular">
            {page.name ? page.email : null}
            {page.name && newest ? " · " : null}
            {newest ? t("people.lastEmail", { when: listDate(newest.lastDate) }) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" data-testid="person-write" onClick={write}>
            <SquarePen data-icon="inline-start" />
            {t("people.write")}
          </Button>
          <Button variant="ghost" size="sm" data-testid="person-copy" onClick={() => copyAddress(page.email)} className="text-foreground-soft">
            <Copy data-icon="inline-start" />
            {t("threadMenu.copyAddress")}
          </Button>
        </div>
      </header>
      <section aria-labelledby="person-between" className="border-t border-hairline pt-5">
        <h2 id="person-between" className="flex items-center gap-2 pb-1.5 text-base font-semibold">
          {t("people.between")}
          {now.length > 0 && (
            <Badge variant="neutral" className="tabular">
              {formatNumber(now.length)}
            </Badge>
          )}
        </h2>
        {page.items.length ? (
          <>
            <ul data-testid="person-items" className="-mx-3">
              {now.slice(0, shown).map((item) => (
                <PersonItemLine key={personItemId(item)} item={item} morphName={morphName("i", personItemId(item))} />
              ))}
            </ul>
            {/* one person can hold much of what's open: drawn a step at a time */}
            {now.length > shown && (
              <Button variant="link-secondary" size="xs" data-testid="person-more-items" className="mt-2 px-0 font-normal" onClick={() => setShown((n) => n + ITEMS_STEP)}>
                {t("people.showMore", { count: Math.min(ITEMS_STEP, now.length - shown) })}
              </Button>
            )}
            {later.length > 0 && (
              <>
                <h3 className="flex items-center gap-2 pt-4 pb-1 text-sm font-medium text-muted-foreground" data-testid="person-later-heading">
                  {t("people.laterGroup")}
                  <span className="tabular">{formatNumber(later.length)}</span>
                </h3>
                <ul data-testid="person-later-items" className="-mx-3">
                  {later.map((item) => (
                    <PersonItemLine key={personItemId(item)} item={item} morphName={morphName("i", personItemId(item))} />
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p data-testid="person-nothing" className="py-2 text-sm text-muted-foreground">
            {t("people.noOpen")}
          </p>
        )}
      </section>
      <section aria-labelledby="person-recent" className="pt-6">
        <h2 id="person-recent" className="pb-1.5 text-base font-semibold">
          {t("people.recent")}
        </h2>
        {page.conversations.length ? (
          <ul data-testid="person-conversations" className="-mx-3">
            {page.conversations.map((c) => (
              <li key={c.id} className="group/conv relative rounded-lg hover:bg-row-hover">
                <button type="button" data-testid="person-conversation" data-place={`conv:${c.id}`} onClick={() => openFromPerson(c.id)} className="block w-full min-w-0 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="relative flex min-w-0 items-baseline gap-3">
                    {/* unread: a dot in the gutter, so every subject starts on the same line */}
                    {c.unread && <span aria-hidden className="absolute top-[calc(0.5lh-3px)] -start-2.5 size-1.5 rounded-full bg-unread" />}
                    <span className={cn("min-w-0 flex-1 truncate", c.unread ? "type-row-subject font-semibold" : "type-row-subject")}>
                      {c.unread && <span className="sr-only">{t("people.unread")} </span>}
                      {c.subject || t("common.noSubject")}
                    </span>
                    <span className="shrink-0 text-sm text-row-preview tabular">{listDate(c.lastDate)}</span>
                  </span>
                  <span className="type-row-snippet mt-0.5 block truncate text-row-preview">{c.snippet}</span>
                </button>
                <span aria-hidden className="hairline-b pointer-events-none absolute start-3 end-3 -bottom-px group-hover/conv:invisible" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">{t("people.noConversations")}</p>
        )}
        {page.conversations.length > 0 && (
          <Button variant="link-secondary" size="xs" data-testid="person-all" className="mt-2 px-0 font-normal" onClick={() => setApp({ query: page.email, view: "all", categoryId: null, reviewCategoryId: null, checked: new Set(), scope: null })}>
            {t("people.allConversations", { name })}
          </Button>
        )}
      </section>
    </>
  );
}

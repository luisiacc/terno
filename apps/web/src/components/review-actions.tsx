import type { AlwaysScope } from "@terno/core";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "@terno/ui/components/dropdown-menu";
import { t } from "@terno/i18n";
import { Check, ChevronDown, MessageSquareText, UserRound } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { answerReview, fileAlways, filterNameOf } from "~/lib/categorize";
import { scopeLabel } from "~/lib/similar";
import { client } from "~/rpc/connection";
import { formatCount } from "./category-snackbar";
import { getApp, setApp, useApp } from "~/state/app";
import { useList } from "~/state/list";

/** The one "Always" menu of the Review list: which row's button opened it (rows hold no Base UI primitives). */
const useAlwaysMenu = create<{ threadId: number | null; anchor: HTMLElement | null }>(() => ({ threadId: null, anchor: null }));

const listbox = () => document.querySelector<HTMLElement>("[data-testid=thread-list] [role=listbox]");

type Offers = { senderName: string | null; offers: { scope: AlwaysScope; count: number; capped: boolean }[] };

const PILL = "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-fast";
const ACCEPT = "border border-primary/25 bg-accent text-accent-foreground hover:border-primary/40 hover:bg-[color-mix(in_oklab,var(--accent)_85%,var(--primary))]";
const ALWAYS = "shrink-0 border border-border bg-background text-foreground hover:bg-muted";

/**
 * Plan 80: a Review row's two answers, in words: "Add to C" (it belongs) and "Add similar ▾" (the same subject or
 * everything from the sender, now and in the future), in place of the row's preview line. A row is an option, which can't
 * hold a button, so the row keeps only their room and their look, hidden (this); the buttons themselves are
 * `ReviewButtons`, laid over it from outside the list (plan 158). y / n and the thread menu answer too.
 */
export function ReviewControls({ threadId, category }: { threadId: number; category: string }) {
  return (
    <span aria-hidden data-review-slot={threadId} className="invisible flex min-w-0 items-center gap-1.5">
      <span className={`${PILL} ${ACCEPT}`}>
        <Check className="size-3.5 shrink-0" />
        <span className="truncate">{t("review.accept", { category })}</span>
      </span>
      <span className={`${PILL} ${ALWAYS}`}>
        {t("review.similar")}
        <ChevronDown className="size-3.5" />
      </span>
    </span>
  );
}

type Box = { left: number; top: number; width: number; height: number };
type Spot = { id: number; accept: Box; always: Box };

const boxOf = (el: Element, base: DOMRect): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
};

/**
 * Plan 158: the Review rows' answers as real buttons, named and reachable by Tab (the open row's; the others by y / n
 * once open), each laid exactly over its row's room for it (`ReviewControls`). Outside the listbox, in a layer clipped
 * to it, so the list stays a list of options. Measured again whenever the list renders (`tick`: a scroll, a resize, the
 * rows changing), and only in a Review list.
 */
export function ReviewButtons({ scroller, tick }: { scroller: React.RefObject<HTMLDivElement | null>; tick: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const [laid, setLaid] = useState<{ clip: Box; spots: Spot[] } | null>(null);
  const category = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const open = useApp((s) => s.selectedId);
  useLayoutEffect(() => {
    const list = scroller.current, host = layer.current?.parentElement;
    if (!list || !host) return;
    const base = host.getBoundingClientRect();
    const clip = boxOf(list, base);
    const at = list.getBoundingClientRect();
    const spots = [...list.querySelectorAll<HTMLElement>("[data-review-slot]")].flatMap((slot) => {
      const [accept, always] = slot.children;
      return accept && always ? [{ id: Number(slot.dataset.reviewSlot), accept: boxOf(accept, at), always: boxOf(always, at) }] : [];
    });
    const next = { clip, spots };
    setLaid((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  }, [tick, scroller]);
  const name = category?.name ?? "";
  // only a row of the list on screen now: never one a layer not yet measured again kept from another list
  const live = (id: number) => scroller.current?.querySelector(`[data-review-slot="${id}"]`) != null;
  const answered = (e: React.MouseEvent<HTMLButtonElement>) => {
    // answered from the keyboard: the row goes with its buttons, so the list takes focus back
    if (document.activeElement === e.currentTarget) requestAnimationFrame(() => listbox()?.focus({ preventScroll: true }));
  };
  const at = (b: Box) => ({ left: b.left, top: b.top, width: b.width, height: b.height });
  return (
    <div ref={layer} className="pointer-events-none absolute overflow-hidden" style={laid ? at(laid.clip) : { display: "none" }}>
      {category &&
        laid?.spots.map((spot) => (
          <div key={spot.id} role="group" aria-label={name} aria-describedby={`thread-${spot.id}`}>
            <button
              type="button"
              data-testid="row-review-accept"
              data-thread-id={spot.id}
              tabIndex={spot.id === open ? 0 : -1}
              title={t("review.accept", { category: name })}
              // a press doesn't take focus from the list (j / k go on from there)
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                if (!live(spot.id)) return;
                answered(e);
                void answerReview(spot.id, category.id, true);
              }}
              className={`${PILL} ${ACCEPT} pointer-events-auto absolute outline-none focus-visible:ring-2 focus-visible:ring-ring`}
              style={at(spot.accept)}
            >
              <Check aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{t("review.accept", { category: name })}</span>
            </button>
            <button
              type="button"
              data-testid="row-review-always"
              data-thread-id={spot.id}
              tabIndex={spot.id === open ? 0 : -1}
              aria-haspopup="menu"
              title={t("review.similar.title", { category: name })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => live(spot.id) && useAlwaysMenu.setState({ threadId: spot.id, anchor: e.currentTarget })}
              className={`${PILL} ${ALWAYS} pointer-events-auto absolute outline-none focus-visible:ring-2 focus-visible:ring-ring`}
              style={at(spot.always)}
            >
              {t("review.similar")}
              <ChevronDown aria-hidden className="size-3.5" />
            </button>
          </div>
        ))}
    </div>
  );
}

/** The Review list's "Always add to C" menu: same subject from the sender first, then all from them, counted when it opens. */
export function ReviewAlwaysMenu() {
  const { threadId, anchor } = useAlwaysMenu();
  const category = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const open = threadId !== null && anchor !== null && category !== undefined;
  const [offers, setOffers] = useState<Offers | "loading" | "failed">("loading");
  const close = () => useAlwaysMenu.setState({ threadId: null, anchor: null });

  // global shortcuts wait while it is open (as for the thread menu)
  useEffect(() => {
    if (!open) return;
    setApp({ menuOpen: true });
    return () => setApp({ menuOpen: false });
  }, [open]);

  useEffect(() => {
    if (!open || !category) return;
    let alive = true;
    setOffers("loading");
    client.call("categorize.alwaysOffers", { categoryId: category.id, threadId }).then(
      (r) => alive && setOffers(r),
      () => alive && setOffers("failed"),
    );
    return () => {
      alive = false;
    };
  }, [threadId, category?.id]);

  // its row left the list (answered elsewhere, a sync, another view): the menu goes with it
  useEffect(() => {
    if (threadId === null) return;
    const gone = () => !useList.getState().index.has(threadId) || getApp().reviewCategoryId === null;
    if (gone()) return close();
    const offList = useList.subscribe(() => gone() && close());
    const offApp = useApp.subscribe(() => gone() && close());
    return () => {
      offList();
      offApp();
    };
  }, [threadId]);

  if (!open) return null;
  const list = typeof offers === "object" ? offers.offers : [];
  return (
    <DropdownMenu
      open
      onOpenChange={(next) => {
        if (next) return;
        close();
        // a press outside leaves focus nowhere (Base UI restores none then): the list takes it back, a frame later
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) listbox()?.focus({ preventScroll: true });
        });
      }}
    >
      <DropdownMenuContent
        anchor={anchor}
        align="end"
        className="w-72"
        data-testid="review-always-menu"
        // back to the list, where the user was (the row's control is no focus target); focus the user already moved
        // elsewhere (a click into search or the composer) stays there, as the thread menu does
        finalFocus={() => {
          const active = document.activeElement;
          if (active && active !== document.body && !active.closest("[role=menu]")) return false;
          return listbox() ?? true;
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-xs font-normal text-muted-foreground">{t("review.always.header", { category: category.name })}</DropdownMenuLabel>
          {offers === "loading" ? (
            <DropdownMenuItem disabled data-testid="review-always-loading" className="h-auto px-2.5 py-2">
              <span className="h-8 w-full animate-pulse rounded-md bg-muted" />
            </DropdownMenuItem>
          ) : list.length === 0 ? (
            <DropdownMenuItem disabled data-testid="review-always-none" className="h-auto px-2.5 py-2">
              {offers === "failed" ? t("review.always.failed") : t("review.always.none")}
            </DropdownMenuItem>
          ) : (
            list.map((o) => {
              const name = (offers as Offers).senderName;
              const Icon = o.scope.kind === "subject" ? MessageSquareText : UserRound;
              return (
                <DropdownMenuItem
                  key={o.scope.kind}
                  data-testid={`review-always-${o.scope.kind}`}
                  title={o.scope.kind === "subject" ? o.scope.subject : o.scope.email}
                  onClick={() => {
                    close();
                    void fileAlways(category.id, o.scope, threadId, filterNameOf(o.scope, name, category.name));
                  }}
                  className="h-auto items-start gap-2.5 rounded-md px-2.5 py-2"
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {/* both lines the same rhythm: what it is, then exactly what it matches */}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate leading-5">{o.scope.kind === "subject" ? scopeLabel(o.scope, name) : t("threadMenu.allFrom", { name: name || o.scope.email })}</span>
                    <span className="truncate text-xs leading-4 text-muted-foreground">{o.scope.kind === "subject" ? o.scope.subject : o.scope.email}</span>
                  </span>
                  <span data-testid={`review-always-${o.scope.kind}-count`} className="shrink-0 rounded-full bg-muted px-1.5 text-xs leading-5 text-muted-foreground tabular">
                    {formatCount(o)}
                  </span>
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** For the thread menu: the same offers, asked for when it opens on a Review row. */
export function useAlwaysOffers(threadId: number | null, categoryId: number | null): Offers | null {
  const [offers, setOffers] = useState<Offers | null>(null);
  useEffect(() => {
    setOffers(null);
    if (threadId === null || categoryId === null) return;
    let alive = true;
    client.call("categorize.alwaysOffers", { categoryId, threadId }).then(
      (r) => alive && setOffers(r),
      () => alive && setOffers({ senderName: null, offers: [] }),
    );
    return () => {
      alive = false;
    };
  }, [threadId, categoryId]);
  return offers;
}

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
import { forwardWheel } from "~/lib/wheel";

/** The one "Always" menu of the Review list: which row's button opened it (rows hold no Base UI primitives). */
const useAlwaysMenu = create<{ threadId: number | null; anchor: HTMLElement | null }>(() => ({ threadId: null, anchor: null }));

const listbox = () => document.querySelector<HTMLElement>("[data-testid=thread-list] [role=listbox]");

type Offers = { senderName: string | null; offers: { scope: AlwaysScope; count: number; capped: boolean }[] };

const PILL = "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-fast";
const ACCEPT = "border border-primary/25 bg-accent text-accent-foreground";
const ALWAYS = "shrink-0 border border-border bg-background text-foreground";
// its button's states, drawn by the pill in the row, which is what shows: hovered (data-hover), and Tab's ring (data-focus,
// gated as focus-visible: is)
const ACCEPT_HOT = "data-hover:border-primary/40 data-hover:bg-[color-mix(in_oklab,var(--accent)_85%,var(--primary))]";
const ALWAYS_HOT = "data-hover:bg-muted";
const RING = "[:root[data-focus-ring]_&[data-focus]]:ring-2 [:root[data-focus-ring]_&[data-focus]]:ring-ring";

/**
 * Plan 80: a Review row's two answers, in words: "Add to C" (it belongs) and "Add similar ▾" (the same subject or
 * everything from the sender, now and in the future), in place of the row's preview line. A row is an option, which can't
 * hold a button, so the row draws them (this, hidden from assistive tech) and the buttons themselves are `ReviewButtons`,
 * laid over it from outside the list (plan 158). Drawn here, they scroll with their row in the very frame it moves: a
 * layer outside the scroller is placed again only after the scroll, so what it drew trailed the rows. y / n and the
 * thread menu answer too.
 */
export function ReviewControls({ threadId, category }: { threadId: number; category: string }) {
  return (
    <span aria-hidden data-review-slot={threadId} className="flex min-w-0 items-center gap-1.5">
      <span className={`${PILL} ${ACCEPT} ${ACCEPT_HOT} ${RING}`}>
        <Check className="size-3.5 shrink-0" />
        <span className="truncate">{t("review.accept", { category })}</span>
      </span>
      <span className={`${PILL} ${ALWAYS} ${ALWAYS_HOT} ${RING}`}>
        {t("review.similar")}
        <ChevronDown className="size-3.5" />
      </span>
    </span>
  );
}

/** A button over its pill: clear, focused too (the pill under it shows, ringed: a button shown here would trail it). */
const CLEAR = "pointer-events-auto absolute opacity-0 outline-none";

type Mark = { id: number; part: number };
type Box = { left: number; top: number; width: number; height: number };
type Spot = { id: number; accept: Box; always: Box };

const boxOf = (el: Element, base: DOMRect): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
};

/**
 * Plan 158: the Review rows' answers as real buttons, named and reachable by Tab (the open row's; the others by y / n
 * once open), each laid exactly over its row's pill (`ReviewControls`). Outside the listbox, in a layer clipped to it,
 * so the list stays a list of options. Measured again whenever the list renders (`tick`: a scroll, a resize, the rows
 * changing), and only in a Review list. That comes a frame or more after the rows scroll, so the buttons are clear and
 * the pills in the rows are what shows: a hovered button lights its pill, and a focused one rings it.
 */
export function ReviewButtons({ scroller, tick, show }: { scroller: React.RefObject<HTMLDivElement | null>; tick: string; show?: (threadId: number) => void }) {
  const layer = useRef<HTMLDivElement>(null);
  const [laid, setLaid] = useState<{ clip: Box; spots: Spot[] } | null>(null);
  const category = useApp((s) => s.categories.find((c) => c.id === s.reviewCategoryId));
  const open = useApp((s) => s.selectedId);
  // the button under the pointer and the one focused, by row and part: their pills in the rows draw them
  const marks = useRef<Record<"hover" | "focus", Mark | null>>({ hover: null, focus: null });
  const light = () => {
    const list = scroller.current;
    if (!list) return;
    for (const kind of ["hover", "focus"] as const) {
      for (const pill of list.querySelectorAll(`[data-review-slot] > [data-${kind}]`)) pill.removeAttribute(`data-${kind}`);
      const m = marks.current[kind];
      // a row scrolled away or answered takes its mark with it; a row drawn again (scrolled back) gets it back
      if (m) list.querySelector(`[data-review-slot="${m.id}"]`)?.children[m.part]?.setAttribute(`data-${kind}`, "");
    }
  };
  const mark = (kind: "hover" | "focus", m: Mark | null) => {
    marks.current[kind] = m;
    light();
  };
  const unmark = (kind: "hover" | "focus", id: number, part: number) => {
    const m = marks.current[kind];
    if (m?.id === id && m.part === part) mark(kind, null);
  };
  const states = (id: number, part: number) => ({
    onPointerEnter: () => mark("hover", { id, part }),
    onPointerLeave: () => unmark("hover", id, part),
    // Tab reaches the open row's even scrolled out of sight: it comes into view, so its ring shows
    onFocus: () => {
      mark("focus", { id, part });
      show?.(id);
    },
    onBlur: () => unmark("focus", id, part),
  });
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
    for (const kind of ["hover", "focus"] as const) if (!spots.some((s) => s.id === marks.current[kind]?.id)) marks.current[kind] = null;
    light();
  }, [tick, scroller]);
  const name = category?.name ?? "";
  // only a row of the list on screen now: never one a layer not yet measured again kept from another list
  const live = (id: number) => scroller.current?.querySelector(`[data-review-slot="${id}"]`) != null;
  // the row a press answers: the one whose pill is under the pointer now (the pills move with a scroll, their buttons
  // only once measured again); from the keyboard (no pointer), the focused button's own
  const pressed = (e: React.MouseEvent, id: number, part: number): number | null => {
    if (e.detail === 0) return live(id) ? id : null;
    for (const slot of scroller.current?.querySelectorAll<HTMLElement>("[data-review-slot]") ?? []) {
      const r = slot.children[part]?.getBoundingClientRect();
      if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return Number(slot.dataset.reviewSlot);
    }
    return null;
  };
  const answered = (e: React.MouseEvent<HTMLButtonElement>) => {
    // answered from the keyboard: the row goes with its buttons, so the list takes focus back
    if (document.activeElement === e.currentTarget) requestAnimationFrame(() => listbox()?.focus({ preventScroll: true }));
  };
  const at = (b: Box) => ({ left: b.left, top: b.top, width: b.width, height: b.height });
  return (
    // outside the list's scroller: a wheel over a button still moves the list, as it would over the row it lies on
    <div ref={layer} className="pointer-events-none absolute overflow-hidden" style={laid ? at(laid.clip) : { display: "none" }} onWheel={(e) => forwardWheel(e, scroller.current)}>
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
              {...states(spot.id, 0)}
              onClick={(e) => {
                const id = pressed(e, spot.id, 0);
                if (id === null) return;
                answered(e);
                void answerReview(id, category.id, true);
              }}
              className={`${PILL} ${CLEAR}`}
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
              {...states(spot.id, 1)}
              onClick={(e) => {
                const id = pressed(e, spot.id, 1);
                const anchor = id === spot.id ? e.currentTarget : layer.current?.querySelector<HTMLElement>(`[data-testid=row-review-always][data-thread-id="${id}"]`);
                if (id !== null && anchor) useAlwaysMenu.setState({ threadId: id, anchor });
              }}
              className={`${PILL} ${CLEAR}`}
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

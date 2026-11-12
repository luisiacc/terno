import type { Category } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Tags } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { announce } from "~/lib/announce";
import { useReviewWork } from "~/lib/categorize";
import { useCovered } from "~/lib/covered";
import { focusQuietly, quietFocus } from "~/lib/quiet-focus";
import { nextToSort, reviewToInbox, switchReview } from "~/lib/review";
import { dockInUse, useSnack } from "~/lib/snack";
import { useApp } from "~/state/app";
import { useList } from "~/state/list";
import { CountdownPill, type Countdown } from "./countdown-pill";

/** Plan 192: how long an emptied Review waits before going on to the next category. */
export const NEXT_MS = 5000;

const lostFocus = () => !document.activeElement || document.activeElement === document.body;
const actionIn = (slot: HTMLElement | null) => slot?.querySelector<HTMLElement>("[data-empty-action]") ?? null;

/**
 * Plans 159, 192: Review's last suggestion answered. It stays (an Undo brings the rows back here) and goes on: to the
 * category with the most waiting, by itself after 5 s (the pill's border drains) or at once when pressed; with none
 * left anywhere, to the Inbox when asked.
 */
export function ReviewEmpty({ category }: { category: Category }) {
  const next = useApp((s) => nextToSort(s.categories, s.counts.categorySuggestions, category.id));
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
      <Tags className="mb-2 size-7 text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold tracking-tight">{t("review.empty.title")}</p>
      <p className="text-xs text-muted-foreground">{next ? t("review.empty.more", { category: category.name }) : t("review.empty.none")}</p>
      <Action next={next} />
    </div>
  );
}

/**
 * The one control under it: the next category's countdown pill, or Go to Inbox. One slot, so focus in one moves to
 * the other when the counts swap them.
 */
function Action({ next }: { next: Category | null }) {
  const slot = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  // focus left on nothing by the last row's going (its own ✓ pressed), or on the emptied list: the way on takes it
  useEffect(() => {
    const list = document.querySelector('[data-keep-scroll="list"]');
    if (lostFocus() || (list && document.activeElement === list)) focusQuietly(actionIn(slot.current));
  }, []);
  return (
    <div
      ref={slot}
      className="mt-3 flex max-w-full justify-center"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => {
        // focus the app moved here itself (this list handing it on, a page closing) isn't the user's: it doesn't hold
        if (!quietFocus.moving) setFocused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {next ? <NextPill key={next.id} next={next} slot={slot} held={hover || focused} /> : <ToInbox slot={slot} />}
    </div>
  );
}

/**
 * The action leaving with focus in it (swapped, or the rows came back by Undo): focus goes to what took its place, the
 * other action or the list's rows, never the page. A layout cleanup runs while it's still in the page (focus readable).
 */
function useHandOff(ref: RefObject<HTMLElement | null>, slot: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (!el?.contains(document.activeElement)) return;
      const container = slot.current;
      requestAnimationFrame(() => {
        if (!lostFocus()) return;
        const action = container?.isConnected ? actionIn(container) : null;
        focusQuietly(action ?? document.querySelector<HTMLElement>('[data-keep-scroll="list"][role="listbox"]'));
      });
    };
  }, [ref, slot]);
}

/** Wherever the user is busy, the countdown waits: it never moves them on from something they're in the middle of. */
function useHeld(slot: RefObject<HTMLElement | null>, own: boolean): boolean {
  // a dialog or a menu (the category switcher), or a conversation or message in the reader (switching would close it)
  const app = useApp((s) => s.dialog !== null || s.menuOpen || s.selectedId !== null || s.compose !== null || s.heldView !== null);
  const dock = useSnack(dockInUse);
  // an answer or a filing still on its way: a failure brings its row back to the category in view
  const answering = useReviewWork((s) => s.pending > 0);
  // a list that failed to load isn't an emptied one
  const loaded = useList((s) => s.itemsKey === s.key && s.error === null);
  const covered = useCovered(slot);
  return own || app || dock || answering || !loaded || covered;
}

/**
 * Elapsed time of a countdown that holds and resumes, and runs `done` when it's spent. One timeout while running, none
 * while held. The pill's ring is drawn from the same clock.
 */
function useCountdown(ms: number, held: boolean, done: () => void): Countdown {
  const [clock, setClock] = useState<{ elapsed: number; since: number | null }>({ elapsed: 0, since: null });
  const run = useRef(done);
  useLayoutEffect(() => {
    run.current = done;
  });
  useEffect(() => {
    setClock((c) => {
      if (held) return c.since === null ? c : { elapsed: c.elapsed + performance.now() - c.since, since: null };
      return c.since !== null ? c : { elapsed: c.elapsed, since: performance.now() };
    });
  }, [held]);
  useEffect(() => {
    if (clock.since === null) return;
    const left = ms - clock.elapsed - (performance.now() - clock.since);
    const timer = setTimeout(() => run.current(), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [clock, ms]);
  return { duration: ms, elapsed: () => clock.elapsed + (clock.since === null ? 0 : performance.now() - clock.since), paused: clock.since === null, sync: clock };
}

/** "Next: {category}", its border draining over 5 s; a new next category is a fresh countdown (keyed by its id). */
function NextPill({ next, slot, held: own }: { next: Category; slot: RefObject<HTMLElement | null>; held: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useHandOff(ref, slot);
  const held = useHeld(slot, own);
  const go = (byItself: boolean) => {
    const had = slot.current?.contains(document.activeElement) ?? false;
    switchReview(next.id);
    if (byItself) announce(t("review.empty.nextNow", { category: next.name }));
    // where a switch made by hand leaves it (the pill goes with this list)
    if (had) focusQuietly(document.querySelector<HTMLElement>("[data-testid=review-category]"));
  };
  const countdown = useCountdown(NEXT_MS, held, () => go(true));
  // said once per destination, as it appears: where it goes, and when
  useEffect(() => announce(t("review.empty.nextSoon", { category: next.name })), [next.id]);
  return (
    <span ref={ref} className="contents">
      <CountdownPill
        testId="review-next"
        data-empty-action
        data-held={countdown.paused || undefined}
        label={t("review.empty.next", { category: next.name })}
        name={t("review.empty.nextName", { category: next.name })}
        onClick={() => go(false)}
        className="max-w-full"
        countdown={countdown}
      />
    </span>
  );
}

/** Nothing left to sort anywhere: out to the Inbox, focus with it if it was here. */
function ToInbox({ slot }: { slot: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLSpanElement>(null);
  useHandOff(ref, slot);
  return (
    <span ref={ref} className="contents">
      <Button
        data-testid="review-inbox"
        data-empty-action
        variant="secondary"
        size="sm"
        onClick={() => {
          const had = slot.current?.contains(document.activeElement) ?? false;
          reviewToInbox();
          if (had) focusQuietly(document.querySelector<HTMLElement>("#app-sidebar [data-testid=nav-inbox]"));
        }}
      >
        {t("review.empty.inbox")}
      </Button>
    </span>
  );
}

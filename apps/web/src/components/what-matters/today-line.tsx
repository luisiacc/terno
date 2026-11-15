import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import type { TodayCounts } from "@terno/core";
import { setComingUpOpen, useToday } from "~/state/today";

/**
 * Plan 210 (iteration 2, the owner): the header's numbers, "6 today · 8 this week", with what's Missed first when there's
 * some ("2 missed · 6 today"), so the sidebar's badge (Missed + Today) reads as the sum of what's said; a part that's
 * nothing isn't said. Null: nothing to say.
 */
export function todayCountsLine(c: TodayCounts): string | null {
  const parts = [c.missed > 0 && t("today.line.missed", { count: c.missed }), c.today > 0 && t("today.line.today", { count: c.today }), c.thisWeek > 0 && t("today.line.thisWeek", { count: c.thisWeek })].filter((p): p is string => typeof p === "string");
  return parts.length ? parts.reduce((a, b) => t("today.line.joined", { a, b })) : null;
}

/** the count's quiet link, as the list header's (its size and line the sentence's) */
const COUNT_LINK = "no-drag align-baseline text-[length:inherit] leading-[inherit] font-normal text-muted-foreground hover:text-foreground aria-pressed:text-foreground aria-pressed:underline";

/**
 * Plan 161: What matters' numbers in words, under its title. Pass 3: one sentence, never a second total to read against
 * the Inbox's. Plan 204: the feed holds all of it (no cap), so the sentence is the count; after it, Coming up's quiet
 * toggle ("4 coming up"), which opens its lines under the rest. Plan 210: the feed's own, since the feed is the only view;
 * iteration 2: its numbers by when ("6 today · 8 this week"), the backend's projection's.
 */
export function TodayLine() {
  const counts = useToday((s) => s.counts);
  const comingUp = useToday((s) => s.comingUp);
  const open = useToday((s) => s.comingUpOpen);
  const said = todayCountsLine(counts);
  return (
    <p data-testid="today-line" className="type-list-subtitle flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground tabular">
      {said && <span data-testid="today-needs" className="text-foreground">{said}</span>}
      {comingUp > 0 && (
        <Button variant="link-secondary" data-testid="today-coming-up" aria-expanded={open} className={COUNT_LINK} onClick={() => setComingUpOpen(!open)}>
          {open ? t("today.line.hideComingUp") : t("today.line.comingUp", { count: comingUp })}
        </Button>
      )}
    </p>
  );
}

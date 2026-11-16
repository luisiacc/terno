import { t } from "@terno/i18n";
import type { TodayCounts } from "@terno/core";
import { useToday } from "~/state/today";

/**
 * Plan 210 (iteration 3, revision 8, the owner's "'Waiting on you' in Today"): the header's numbers, "1 missed · 3 to do
 * today · 5 waiting" (iteration 4: what Today counts is what's to do, your reminders with it, never its plans), disjoint,
 * so the sidebar's badge reads as the sum of what's said; a part that's nothing isn't said. Null: nothing to say.
 */
export function todayCountsLine(c: TodayCounts): string | null {
  const parts = [c.missed > 0 && t("today.line.missed", { count: c.missed }), c.today > 0 && t("today.line.today", { count: c.today }), c.waiting > 0 && t("today.line.waiting", { count: c.waiting })].filter((p): p is string => typeof p === "string");
  return parts.length ? parts.reduce((a, b) => t("today.line.joined", { a, b })) : null;
}

/**
 * Plan 161: What matters' numbers in words, under its title. Pass 3: one sentence, never a second total to read against
 * the Inbox's. Plan 204: the feed holds all of it (no cap), so the sentence is the count. Plan 210: the feed's own, since
 * the feed is the only view; iteration 3: its numbers by when and who ("1 missed · 3 to do today · 5 waiting"), the
 * backend's projection's. Iteration 4 (the Codex review's revision 9): Coming up isn't said here: it's the feed's last
 * heading, its own disclosure ("Coming up · 3").
 */
export function TodayLine() {
  const counts = useToday((s) => s.counts);
  const said = todayCountsLine(counts);
  return (
    <p data-testid="today-line" className="type-list-subtitle flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground tabular">
      {said && <span data-testid="today-needs" className="text-foreground">{said}</span>}
    </p>
  );
}

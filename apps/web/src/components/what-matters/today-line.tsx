import { t } from "@terno/i18n";
import { Collapsible, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import type { TodayCounts } from "@terno/core";
import { setComingUpOpen, useToday } from "~/state/today";

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
 * Coming up's disclosure in the sentence's size and line: quiet until hovered or open, its chevron beside its words (the
 * catalog's Collapsible trigger, as an earlier answer's sources are on Ask's page)
 */
/** The feed's rows, what Coming up's disclosure shows more of (its rows join their days there: no panel of its own) */
export const FEED_ROWS_ID = "wm-feed-rows";

const DISCLOSURE = "no-drag w-auto gap-1 text-[length:inherit] leading-[inherit] font-normal text-muted-foreground hover:text-foreground data-panel-open:text-foreground [&>[data-slot=collapsible-chevron]]:ms-0 [&>[data-slot=collapsible-chevron]]:size-3.5";

/**
 * Plan 161: What matters' numbers in words, under its title. Pass 3: one sentence, never a second total to read against
 * the Inbox's. Plan 204: the feed holds all of it (no cap), so the sentence is the count; after it, Coming up's quiet
 * toggle ("4 coming up"), which opens its lines under the rest. Plan 210: the feed's own, since the feed is the only view;
 * iteration 3: its numbers by when and who ("1 missed · 3 today · 5 waiting"), the backend's projection's; Coming up the
 * catalog's disclosure (its words the same open or shut, its chevron turning), open until closed (remembered on this
 * machine), its rows drawn in the feed under their days and weeks.
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
        <Collapsible open={open} onOpenChange={setComingUpOpen} render={<span />}>
          <CollapsibleTrigger data-testid="today-coming-up" aria-controls={FEED_ROWS_ID} className={DISCLOSURE}>
            {t("today.line.comingUp", { count: comingUp })}
          </CollapsibleTrigger>
        </Collapsible>
      )}
    </p>
  );
}

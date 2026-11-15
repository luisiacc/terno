import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useApp } from "~/state/app";
import { setComingUpOpen, useToday } from "~/state/today";

/** the count's quiet link, as the list header's (its size and line the sentence's) */
const COUNT_LINK = "no-drag align-baseline text-[length:inherit] leading-[inherit] font-normal text-muted-foreground hover:text-foreground aria-pressed:text-foreground aria-pressed:underline";

/**
 * Plan 161: What matters' numbers in words, under its title. Pass 3: one sentence, never a second total to read against
 * the Inbox's. Plan 204: the feed holds all of it (no cap), so the sentence is the count; after it, Coming up's quiet
 * toggle ("4 coming up"), which opens its lines under the rest. Plan 210: the feed's own, since the feed is the only view.
 */
export function TodayLine() {
  const needs = useApp((s) => s.counts.today ?? null);
  const counted = useToday((s) => s.counted);
  const comingUp = useToday((s) => s.comingUp);
  const open = useToday((s) => s.comingUpOpen);
  const count = needs ?? counted;
  return (
    <p data-testid="today-line" className="type-list-subtitle flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground tabular">
      {count > 0 && <span data-testid="today-needs" className="text-foreground">{t("today.line.needs", { count })}</span>}
      {comingUp > 0 && (
        <Button variant="link-secondary" data-testid="today-coming-up" aria-expanded={open} className={COUNT_LINK} onClick={() => setComingUpOpen(!open)}>
          {open ? t("today.line.hideComingUp") : t("today.line.comingUp", { count: comingUp })}
        </Button>
      )}
    </p>
  );
}

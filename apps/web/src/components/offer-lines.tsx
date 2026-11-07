/**
 * Plan 91: the lines every follow-up offer is drawn with, in the category
 * snackbar and the similar one alike: `what it will do, as a sentence … + new mail [n]`,
 * then, when a default ran, `No, only … [0]`. Plan 158: the digit is the line's
 * shortcut, at its end as everywhere else; the sentence says what it does.
 */
import { formatNumber, t } from "@terno/i18n";
import { Kbd } from "@terno/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { useId } from "react";
import { COUNT_SLOT } from "~/lib/similar";

export type Count = { count: number; capped: boolean } | null;

/** "1,000+" at the cap; a scope read only in part (plan 63) says "at least" the same way */
export const formatCount = (c: { count: number; capped: boolean }) => (c.capped ? `${formatNumber(c.count)}+` : formatNumber(c.count));

export const lineKey = "h-4 min-w-4 shrink-0 rounded-full bg-tint text-2xs shadow-none";
export const line = "flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-fast hover:bg-muted";

/** An offer's count: right-aligned so the column lines up, saying what it counts (a keycap's "1" sits at the line's start); a pulse while counting. */
export function OfferCount({ count, testId }: { count: Count | "loading" | undefined; testId: string }) {
  if (count === undefined) return null;
  if (count === "loading") return <span data-testid="snackbar-count-loading" className="h-3 w-5 shrink-0 animate-pulse rounded bg-muted" />;
  return (
    <span className="shrink-0 text-2xs whitespace-nowrap text-muted-foreground tabular">
      <span data-testid={testId}>{count ? formatCount(count) : formatNumber(0)}</span> {t("offers.more")}
    </span>
  );
}

/**
 * One offer per line, a sentence (a long name truncates; `label` holds COUNT_SLOT where
 * its count goes). A quiet "+ new mail" says it also catches future mail; the tooltip (and
 * the description) says what it does in full.
 */
export function OfferLine({
  n,
  label,
  future,
  count,
  onClick,
  testId,
  help,
  disabled,
}: {
  n: number;
  label: string;
  future?: boolean;
  count?: Count;
  onClick: () => void;
  testId: string;
  help: string;
  disabled?: boolean;
}) {
  const helpId = useId();
  if (count === null) return null;
  const [before, after] = label.split(COUNT_SLOT);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" data-testid={testId} onClick={onClick} aria-disabled={disabled || undefined} aria-describedby={helpId} aria-keyshortcuts={String(n)} className={cn(line, "w-full text-left aria-disabled:opacity-60 aria-disabled:hover:bg-transparent")} />}
        >
          <span className="min-w-0 flex-1 truncate">
            {before}
            {after !== undefined && count && (
              <>
                <span data-testid={`${testId}-count`} className="tabular">{formatCount(count)}</span>
                {after}
              </>
            )}
          </span>
          {future && (
            <span data-testid={`${testId}-future`} className="shrink-0 text-2xs whitespace-nowrap text-muted-foreground">
              {t("category.newMailToo")}
            </span>
          )}
          <Kbd className={lineKey}>{n}</Kbd>
        </TooltipTrigger>
        <TooltipContent align="start" data-testid={`${testId}-help`}>
          {help}
        </TooltipContent>
      </Tooltip>
      <span id={helpId} hidden>
        {help}
      </span>
    </>
  );
}

/** "No, only move this email": after a default, the plain choice, last; 0 runs it. */
export function OnlyLine({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" data-testid="snackbar-only" onClick={onClick} aria-disabled={disabled || undefined} aria-keyshortcuts="0" className={cn(line, "w-full text-left aria-disabled:opacity-60")}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Kbd className={lineKey}>0</Kbd>
    </button>
  );
}

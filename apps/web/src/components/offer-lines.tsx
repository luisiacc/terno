/**
 * Plan 86: the lines every follow-up offer is drawn with, in the category
 * snackbar and the similar one alike: `[n] label · detail …… + new mail  count`,
 * then, when a default ran, `[0] No, only …`.
 */
import { formatNumber, t } from "@terno/i18n";
import { Kbd } from "@terno/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { useId } from "react";

export type Count = { count: number; capped: boolean } | null;

/** "1,000+" at the cap; a scope read only in part (plan 63) says "at least" the same way */
export const formatCount = (c: { count: number; capped: boolean }) => (c.capped ? `${formatNumber(c.count)}+` : formatNumber(c.count));

export const lineKey = "h-4 min-w-4 shrink-0 rounded-full bg-tint text-2xs shadow-none";
export const line = "flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-fast hover:bg-muted";

/** An offer's count: right-aligned so the column lines up; a pulse while counting. */
export function OfferCount({ count, testId }: { count: Count | "loading" | undefined; testId: string }) {
  if (count === undefined) return null;
  if (count === "loading") return <span data-testid="snackbar-count-loading" className="h-3 w-5 shrink-0 animate-pulse rounded bg-muted" />;
  return (
    <span data-testid={testId} className="shrink-0 font-mono text-2xs text-muted-foreground tabular">
      {count ? formatCount(count) : formatNumber(0)}
    </span>
  );
}

/**
 * One offer per line, so its whole label shows (a long name truncates). A
 * quiet "+ new mail" says it also catches future mail; the tooltip (and the
 * description) says what it does in full.
 */
export function OfferLine({
  n,
  label,
  detail,
  future,
  count,
  onClick,
  testId,
  help,
  disabled,
}: {
  n: number;
  label: string;
  /** the subject's template ("Tu pedido # está en camino"), muted after the label */
  detail?: string;
  future?: boolean;
  count?: Count | "loading";
  onClick: () => void;
  testId: string;
  help: string;
  disabled?: boolean;
}) {
  const helpId = useId();
  if (count === null) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" data-testid={testId} onClick={onClick} aria-disabled={disabled || undefined} aria-describedby={helpId} className={cn(line, "w-full text-left aria-disabled:opacity-60 aria-disabled:hover:bg-transparent")} />}
        >
          <Kbd className={lineKey}>{n}</Kbd>
          <span className="min-w-0 truncate">
            {label}
            {detail && (
              <span data-testid={`${testId}-detail`} className="text-muted-foreground">
                {" · "}
                {detail}
              </span>
            )}
          </span>
          <span data-testid={`${testId}-future`} className="flex-1 shrink-0 text-2xs whitespace-nowrap text-muted-foreground">
            {future ? t("category.newMailToo") : ""}
          </span>
          <OfferCount count={count} testId={`${testId}-count`} />
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
      <Kbd className={lineKey}>0</Kbd>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * Plan 223: the frame both follow-up snackbars are drawn in (a category's, plan 91; a similar action's, plan 63).
 * What happened is the title, short; why and what follows (the scope, new mail) is one muted line under it, on the
 * title's column. Undo and close sit at the right, centred on that block. Under a hairline, everything that could
 * still change it: the offers (on asking), then the foot — the plain choice when a default did more than was asked
 * ("No, only move this email 0") and, across from it, "Move similar…". Every line below starts on the title's column.
 */
import { Kbd } from "@terno/ui/components/kbd";
import { cn } from "@terno/ui/lib/utils";
import type { ReactNode } from "react";
import { line, lineKey } from "./offer-lines";
import { SnackClose } from "./snack-dock";

/** a line's text sits 6 px into it (`line`'s px-1.5): the column under the title, with a lead (a category's dot) and without */
const COLUMN = { lead: "ps-5.5", bare: "ps-1.5" };

export function OfferSnack({
  testId,
  data,
  lead,
  title,
  titleTestId,
  strong = true,
  failed,
  note,
  noteTestId,
  more,
  undo,
  onClose,
  offersId,
  offersTestId,
  offers,
  only,
}: {
  testId: string;
  /** `data-*` the tests read (the default's status, a failure) */
  data?: { [key: `data-${string}`]: string | undefined };
  /** a mark before the title (a category's dot), on its first line */
  lead?: ReactNode;
  title: string;
  titleTestId: string;
  /** the title in medium weight: what was done is the point (a plain "Archived" stays regular) */
  strong?: boolean;
  failed?: boolean;
  /** the scope and what happens to new mail, muted, under the title */
  note?: string | null;
  noteTestId: string;
  /** "Move similar…": beside Undo while the snackbar is one block, in the foot once it has one */
  more?: ReactNode;
  undo?: ReactNode;
  onClose: () => void;
  offersId: string;
  offersTestId: string;
  /** the offer lines, when open */
  offers?: ReactNode;
  /** "No, only …": after a default, never behind a fold */
  only?: { label: string; onClick: () => void; disabled?: boolean } | null;
}) {
  const column = lead ? COLUMN.lead : COLUMN.bare;
  const below = !!offers || !!only;
  return (
    <div data-testid={testId} {...data}>
      <div className="flex min-h-9 items-center gap-2 py-1.5 pr-1.5 pl-3">
        <div className="flex min-w-0 flex-1 items-start gap-2 text-sm">
          {lead && <span className="flex h-lh shrink-0 items-center">{lead}</span>}
          <div className="min-w-0 flex-1">
            {/* a sentence read whole: two lines rather than cut */}
            <p className={cn("line-clamp-2", failed ? "text-destructive-ink" : strong && "font-medium")} data-testid={titleTestId} title={title}>
              {title}
            </p>
            {note && (
              <p data-testid={noteTestId} className="line-clamp-2 text-xs text-muted-foreground" title={note}>
                {note}
              </p>
            )}
          </div>
        </div>
        {!only && more}
        {undo}
        <SnackClose onClick={onClose} />
      </div>
      {below && (
        <div className={cn("flex flex-col border-t border-hairline pt-0.5 pr-1.5 pb-1.5", column)}>
          {offers && (
            <div id={offersId} data-testid={offersTestId} className="flex flex-col">
              {offers}
            </div>
          )}
          {only && (
            <div className="flex min-h-7 items-center justify-between gap-2">
              <button type="button" data-testid="snackbar-only" onClick={only.onClick} aria-disabled={only.disabled || undefined} aria-keyshortcuts="0" className={cn(line, "min-w-0 aria-disabled:opacity-60 aria-disabled:hover:bg-transparent")}>
                <span className="min-w-0 truncate">{only.label}</span>
                <Kbd className={lineKey}>0</Kbd>
              </button>
              {more}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

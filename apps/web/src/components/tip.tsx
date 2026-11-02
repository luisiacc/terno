import { Button } from "@terno/ui/components/button";
import { useModalHost } from "@terno/ui/components/modal-host";
import { Popover, PopoverArrow, PopoverContent, PopoverDescription, PopoverTitle } from "@terno/ui/components/popover";
import { t } from "@terno/i18n";
import { useEffect, useState, type ReactNode } from "react";
import { dismissTip, markTipShown, tipShown, type TipId } from "~/lib/tips";
import { useApp } from "~/state/app";

/**
 * Plan 113: an education tip, shown once beside what it teaches: a picture of the gesture (tip-picture.tsx), a title, a
 * line or two, and Got it. Rendered lazily by its host while `usePendingTip(id)` has a target.
 *
 * It waits for a clear stage (no dialog, menu or modal) and for its anchor to be in the page, scrolls it into view and
 * only then counts as shown. It never takes focus, on open or close, so it interrupts nothing; a polite live region reads
 * it. Got it, Escape (the tip's alone while it's up), a click anywhere, anything modal opening, its anchor leaving or
 * `ended` close it.
 */
export function Tip({
  id,
  anchor,
  ended = false,
  title,
  body,
  picture,
  side = "right",
}: {
  id: TipId;
  /** a selector for what it points at */
  anchor: string;
  /** what it teaches was done another way (another window included) */
  ended?: boolean;
  title: string;
  body: ReactNode;
  picture?: ReactNode;
  side?: "right" | "left" | "bottom" | "top";
}) {
  const modal = useModalHost();
  const busy = useApp((s) => s.dialog !== null || s.menuOpen) || modal !== null;
  const [target, setTarget] = useState<HTMLElement | null>(null);

  // its anchor may come after the moment (a creation lands you on a category before the category's own event)
  useEffect(() => {
    if (target) {
      if (busy || ended || !target.isConnected) dismissTip(id);
      return;
    }
    if (busy || ended) return;
    // another window showed it meanwhile
    if (tipShown(id)) return dismissTip(id);
    const el = document.querySelector<HTMLElement>(anchor);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    markTipShown(id);
    setTarget(el);
  }, [target, busy, ended, anchor, id]);

  // Escape is the tip's alone while it's up: before the app's keys and the focused control's own (a search would clear)
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      dismissTip(id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, id]);

  const open = target !== null;
  return (
    <>
      {/* read once when it opens: the popup itself is never focused */}
      <span aria-live="polite" className="sr-only">
        {open && (
          <>
            {title}. {body}
          </>
        )}
      </span>
      <Popover open={open} onOpenChange={(next) => !next && dismissTip(id)}>
        <PopoverContent
          anchor={target}
          side={side}
          align="start"
          alignOffset={-10}
          sideOffset={10}
          initialFocus={false}
          finalFocus={false}
          data-testid={`tip-${id}`}
          className="w-72 gap-3 in-data-anchor-hidden:invisible"
        >
          <PopoverArrow />
          {picture}
          <div className="flex flex-col gap-1 px-0.5">
            <PopoverTitle className="text-sm">{title}</PopoverTitle>
            <PopoverDescription className="text-xs leading-relaxed">{body}</PopoverDescription>
          </div>
          <div className="flex justify-end">
            <Button size="sm" data-testid="tip-done" onClick={() => dismissTip(id)}>
              {t("tip.gotIt")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** The words of the gesture's target in a tip's body ("choose <b>Show in Inbox</b>"): full contrast, a step heavier. */
export const strong = (text: ReactNode): ReactNode => <span className="font-medium text-foreground">{text}</span>;

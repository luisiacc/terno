import { t } from "@terno/i18n";
import { cn } from "@terno/ui/lib/utils";
import type { HTMLAttributes, Ref } from "react";

/**
 * Plan 286: Automated mail with nothing left to review: a kite over plan 222's horizon, "Clear skies." and a line. Centred
 * in a pane that scrolls when it's too short to hold it, never clipped. Static: it stands in for a page, not a list's row.
 * The title is the pane's heading, where the keys land when the pane is reached (F6).
 */
export function AutomatedClear({ heading, className, children, ...rest }: { heading?: Ref<HTMLHeadingElement> } & HTMLAttributes<HTMLDivElement>) {
  return (
    // the pane's controls (its ×) stay on the pane's bar, over the scroller
    <div {...rest} className={cn("relative h-full min-h-0", className)}>
      <div className="h-full overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center gap-1 px-8 py-12 text-center">
          <Kite />
          <h1 ref={heading} tabIndex={-1} className="mt-3 text-lg font-semibold tracking-tight outline-none" data-testid="digest-clear-title">
            {t("today.digest.clear.title")}
          </h1>
          <p className="max-w-64 text-xs text-muted-foreground">{t("today.digest.clear.body")}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * The scene: plan 222's hairline horizon, a kite in the palette's `star` (its spars shown by two shades of the one colour, so
 * it needs no background colour: the page and the column differ), its dotted string down to the line, one cloud.
 * Decorative: the words under it say everything.
 */
function Kite() {
  return (
    <svg viewBox="0 0 200 112" className="w-full max-w-[200px]" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden data-testid="digest-clear-kite">
      <path d="M12 104H188" stroke="currentColor" strokeOpacity={0.18} />
      <path d="M44 34a7 7 0 0 1 13-3a6 6 0 0 1 10 5H44Z" stroke="currentColor" strokeOpacity={0.28} />
      <path d="M124 52Q100 76 74 104" stroke="currentColor" strokeOpacity={0.35} strokeDasharray="1 3" />
      <g className="text-star" fill="currentColor">
        <path d="M124 12L109 34H124Z" />
        <path d="M124 12L139 34H124Z" fillOpacity={0.78} />
        <path d="M109 34L124 58V34Z" fillOpacity={0.78} />
        <path d="M139 34L124 58V34Z" />
        <path d="M124 58q-7 8 0 14q7 7 0 14" stroke="currentColor" strokeWidth={1.4} fill="none" />
        <path d="M120 66l4 2l-4 2ZM128 80l-4 2l4 2Z" />
      </g>
    </svg>
  );
}

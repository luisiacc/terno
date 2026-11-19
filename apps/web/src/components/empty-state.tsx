import { cn } from "@terno/ui/lib/utils";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { arrive } from "~/lib/flash";
import { takeEmptied, useList } from "~/state/list";

/**
 * A list with nothing in it: its glyph, what it means, maybe a hint and a way on. Plan 198: one the list on screen just
 * went to (its last rows left) settles in, the spring's small settle (a rare win), without a fade: it takes the rows'
 * place at once (their fading copies leave with the list), so a transparent first frame would show nothing there.
 * One navigated to is simply there. Plan 222: one that draws its own words (What matters' horizon) has no title.
 */
export function EmptyState({ icon, title, hint, children, className }: { icon?: ReactNode; title?: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // before paint: never shown settled, then hidden
  useLayoutEffect(() => {
    if (takeEmptied(useList.getState().itemsKey)) arrive(ref.current, { spring: true, inPlace: true });
  }, []);
  return (
    <div ref={ref} className={cn("flex h-full flex-col items-center justify-center gap-1 px-8 text-center", className)} data-testid="list-empty">
      {icon}
      {title !== undefined && <p className="text-lg font-semibold tracking-tight">{title}</p>}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

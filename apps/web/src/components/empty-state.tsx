import { useLayoutEffect, useRef, type ReactNode } from "react";
import { arrive } from "~/lib/flash";
import { takeEmptied, useList } from "~/state/list";

/**
 * A list with nothing in it: its glyph, what it means, maybe a hint and a way on. Plan 198: one the list on screen just
 * went to (its last rows left) arrives, the spring's small settle (a rare win); one navigated to is simply there.
 */
export function EmptyState({ icon, title, hint, children }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // before paint: never shown settled, then hidden
  useLayoutEffect(() => {
    if (takeEmptied(useList.getState().itemsKey)) arrive(ref.current, { spring: true });
  }, []);
  return (
    <div ref={ref} className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
      {icon}
      <p className="text-lg font-semibold tracking-tight">{title}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

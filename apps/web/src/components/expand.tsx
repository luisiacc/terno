import { cn } from "@unica/ui/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppearance } from "~/lib/appearance";

const motionOff = () => {
  const { motionMs, reducedMotion } = useAppearance.getState();
  return motionMs === 0 || reducedMotion;
};

/**
 * Content that opens and closes in place: mounted only while open (and while
 * closing), never kept hidden. Opening animates a 0fr → 1fr grid row plus
 * opacity (slow, drawer curve); closing runs fast, then unmounts. Something
 * already open on first render doesn't animate (a reader swap never does);
 * with motion off it opens and closes at once. The closing part is inert.
 */
export function Expand({ open, id, className, children, onOpening }: { open: boolean; id?: string; className?: string; children: React.ReactNode; onOpening?: (el: HTMLDivElement) => void }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(open);
  /** opened by a toggle (not already open on first render): only then does onOpening run */
  const toggled = useRef(false);

  useLayoutEffect(() => {
    if (prev.current === open) return;
    prev.current = open;
    if (open) {
      toggled.current = true;
      setMounted(true);
      if (motionOff()) return void setShown(true);
      // one frame at 0fr, then the transition to 1fr
      const f = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(f);
    }
    setShown(false);
    if (motionOff()) setMounted(false);
  }, [open]);

  useEffect(() => {
    if (shown && open && toggled.current && ref.current) onOpening?.(ref.current);
  }, [shown]);

  useEffect(() => {
    if (open || shown || !mounted) return;
    const el = ref.current;
    const done = () => setMounted(false);
    const onEnd = (e: TransitionEvent) => e.target === el && e.propertyName === "grid-template-rows" && done();
    el?.addEventListener("transitionend", onEnd);
    // a transition that never runs (display changes, tab hidden) still ends
    const t = setTimeout(done, 150);
    return () => {
      el?.removeEventListener("transitionend", onEnd);
      clearTimeout(t);
    };
  }, [open, shown, mounted]);

  if (!mounted) return null;
  return (
    <div
      ref={ref}
      id={id}
      inert={!shown}
      data-state={shown ? "open" : "closed"}
      className={cn(
        "grid transition-[grid-template-rows]",
        shown ? "grid-rows-[1fr] duration-slow ease-drawer" : "grid-rows-[0fr] duration-fast ease-exit",
        className,
      )}
    >
      <div className={cn("min-h-0 overflow-hidden transition-opacity", shown ? "opacity-100 duration-slow" : "opacity-0 duration-fast")}>{children}</div>
    </div>
  );
}

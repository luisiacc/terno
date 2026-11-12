import { useEffect, useState, type RefObject } from "react";

/** Is the element out of the user's reach: under an `inert` or `aria-hidden` ancestor (a page over List's rows, a modal's sweep, the web's blocking screen)? */
export function unreachable(el: Element): boolean {
  return el.closest("[inert], [aria-hidden=true]") !== null;
}

/**
 * Plan 192: whether nobody can see or reach the element now: the window hidden, or it's under a page, a modal or a
 * blocking screen. Event-driven (no polling): visibility, and the `inert` / `aria-hidden` marks of its own ancestors only.
 */
export function useCovered(ref: RefObject<Element | null>): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setCovered(document.visibilityState === "hidden" || unreachable(el));
    read();
    document.addEventListener("visibilitychange", read);
    const mo = new MutationObserver(read);
    for (let a: Element | null = el; a; a = a.parentElement) mo.observe(a, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
    return () => {
      document.removeEventListener("visibilitychange", read);
      mo.disconnect();
    };
  }, [ref]);
  return covered;
}

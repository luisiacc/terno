/**
 * Toolbars show their bottom hairline only once content has scrolled under
 * them: `target` gets `data-scrolled` while `sentinel` (a 1 px element at the
 * top of the scroller's content) is out of `root`'s view. One
 * IntersectionObserver, no scroll handler, nothing re-renders.
 */
export function installScrollHairline(root: HTMLElement, sentinel: HTMLElement, target: HTMLElement): () => void {
  const io = new IntersectionObserver(
    (entries) => {
      const e = entries[entries.length - 1];
      if (e) target.toggleAttribute("data-scrolled", !e.isIntersecting);
    },
    { root },
  );
  io.observe(sentinel);
  return () => io.disconnect();
}

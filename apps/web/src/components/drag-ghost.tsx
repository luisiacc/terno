import { registerGhost } from "~/lib/drag-install";

/**
 * The drag ghost: rendered once and never re-rendered. The controller fills
 * in the subject and count and moves it with translate3d in rAF; the outer
 * layer positions, the inner one runs the enter/leave animations.
 */
export function DragGhost() {
  return (
    <div ref={registerGhost} data-testid="drag-ghost" hidden className="pointer-events-none fixed top-0 left-0 z-[70] will-change-transform">
      <div data-ghost-body className="relative data-shown:animate-in data-shown:fade-in-0 data-shown:zoom-in-95 data-shown:duration-fast data-leaving:animate-out data-leaving:fade-out-0 data-leaving:duration-fast data-leaving:fill-mode-forwards">
        {/* stacked layers behind the chip when several threads travel */}
        <span data-ghost-stack className="absolute inset-0 hidden translate-x-1.5 translate-y-1.5 rounded-lg border border-border bg-popover shadow-sm" />
        <span data-ghost-stack className="absolute inset-0 hidden translate-x-0.75 translate-y-0.75 rounded-lg border border-border bg-popover shadow-sm" />
        <div className="relative flex max-w-64 items-center gap-2 rounded-lg border border-border bg-popover py-1.5 pr-1.5 pl-2.5 text-sm text-popover-foreground shadow-lg">
          <span data-ghost-subject className="min-w-0 truncate" />
          <span data-ghost-count data-testid="drag-ghost-count" className="min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center font-mono text-2xs leading-5 text-primary-foreground tabular" />
        </div>
      </div>
    </div>
  );
}

import { cn } from "cn"
import { t } from "@terno/i18n"

// a ring a quarter of the radius thick, its edges a hair soft (closest-side: 100% is the radius)
const RING = "radial-gradient(closest-side, transparent 74%, black 76%, black 98%, transparent 100%)"

/**
 * BoardUI's spinner (plan 125): a faint ring with an arc turning on it, in the text's color. 1.15em beside text, 16 px
 * alone. Standalone it is a status with a name; inside a busy button (`aria-hidden`) the button says it. A loop, not a
 * transition: with motion reduced or off (globals.css) the arc stands still.
 */
function Spinner({
  className,
  label,
  "aria-hidden": hidden,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { label?: string }) {
  const quiet = hidden === true || hidden === "true"
  return (
    <span
      data-slot="spinner"
      role={quiet ? undefined : "status"}
      aria-label={quiet ? undefined : (label ?? t("ui.spinner.loading"))}
      aria-hidden={quiet || undefined}
      className={cn("relative inline-flex size-4 shrink-0 text-primary in-data-[slot=button]:size-[1.15em] in-data-[slot=button]:text-current", className)}
      {...props}
    >
      <span aria-hidden className="absolute inset-0 rounded-full bg-current/15" style={{ maskImage: RING, WebkitMaskImage: RING }} />
      <span aria-hidden className="absolute inset-0 animate-spin">
        <span className="absolute inset-0" style={{ background: "conic-gradient(transparent 70deg, currentColor 360deg)", maskImage: RING, WebkitMaskImage: RING }} />
        {/* the arc's rounded head, at its leading end */}
        <span className="absolute top-0 left-1/2 size-1/8 -translate-x-1/2 rounded-full bg-current" />
      </span>
    </span>
  )
}

export { Spinner }

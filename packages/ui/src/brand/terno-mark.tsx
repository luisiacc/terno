import { cn } from "../lib/utils";
import { MARK_SHAPES, MARK_VIEWBOX } from "./mark.generated";

/**
 * Terno's mark, the T over an envelope (plan 19), inline: no request, no
 * chunk. Every shape is currentColor, so the caller colors it with a text
 * token and it follows the design and palette; the envelope keeps the logo's
 * own translucency. Decorative (hidden from assistive tech) unless `label`
 * names it, because each place that shows it says "Terno" in text.
 */
export function TernoMark({ className, label, ...rest }: { className?: string; label?: string; "data-testid"?: string }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={cn("shrink-0", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      focusable="false"
      data-brand-mark=""
      {...rest}
    >
      {MARK_SHAPES.map((s, i) => (s.tag === "rect" ? <rect key={i} {...s.props} /> : <path key={i} {...s.props} />))}
    </svg>
  );
}

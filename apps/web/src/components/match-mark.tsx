import { matchParts, type MatchNeedle } from "@terno/core";
import { cn } from "@terno/ui/lib/utils";

/**
 * Plan 158: why a result is here. Weight as well as the tint (the tint alone would be color alone); on the cursor and
 * on a checked row, the row's own ink on a lighter tint (contrast.ts holds it).
 */
const MARK = "rounded-xs bg-star/25 px-px font-semibold text-foreground group-data-opened/row:bg-star/14 group-data-opened/row:text-row-selected-foreground group-data-checked/row:bg-star/14 group-data-checked/row:text-row-selected-foreground";

/** A text with its matches marked; `body` marks count as the reader's (its next and previous step through them). */
export function Marked({ text, needles, testId = "row-match", body = false }: { text: string; needles: readonly MatchNeedle[] | undefined; testId?: string; body?: boolean }) {
  const parts = needles ? matchParts(text, needles) : null;
  if (!parts) return text;
  return parts.map((p, i) => (p.hit ? <mark key={i} data-testid={testId} data-reader-match={body || undefined} className={cn(MARK, body && "data-reader-current:outline-[1.5px] data-reader-current:outline-star")}>{p.text}</mark> : p.text));
}

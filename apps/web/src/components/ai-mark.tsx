import { cn } from "@terno/ui/lib/utils";

/**
 * Plan 181 (the owner, 2026-11-10, after three rounds of icons): a model's words are marked by a glowing dot in the accent,
 * not a sparkle. It sits in the glyph's own 1.15em box, so the title starts where it always did (globals.css `ai-mark`).
 */
export function AiMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" data-slot="ai-mark" className={cn("inline-flex size-[1.15em] shrink-0 items-center justify-center", className)}>
      <span className="ai-mark" />
    </span>
  );
}

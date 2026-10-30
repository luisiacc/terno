import { cn } from "@terno/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { codeKey, copyCode, useCodeState } from "~/lib/codes";

/**
 * A row's verification code, one click from the clipboard (plan 69). A pointer target, not a control: a row is an
 * option of the list, which can't hold a button. Keyboards and screen readers get the code in the row's name and
 * copy it from the thread menu. Pressing it neither opens the thread nor starts a drag (`data-row-control`).
 */
export function CodeChip({ threadId, code, className }: { threadId: number; code: string; className?: string }) {
  const key = codeKey(threadId, code);
  const { copied, used } = useCodeState(key);
  return (
    <span
      aria-hidden
      data-testid="row-code"
      data-row-control
      data-copied={copied || undefined}
      data-used={used || undefined}
      onMouseDown={(e) => {
        // no row press, no focus move
        e.stopPropagation();
        e.preventDefault();
      }}
      onClick={(e) => {
        e.stopPropagation();
        void copyCode(key, code);
      }}
      className={cn(
        "group/code -my-0.5 inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full border pr-1.5 pl-2 text-xs font-medium tracking-wide tabular",
        "transition-[background-color,border-color,color] duration-slow ease-motion",
        "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
        "data-used:border-border data-used:bg-transparent data-used:text-foreground data-used:hover:bg-tint",
        className,
      )}
    >
      {code}
      {/* the copy icon turns into a check: both stay mounted, one fades and grows as the other shrinks away */}
      <span className="relative size-3 shrink-0">
        <Copy className="absolute inset-0 size-3 transition-[opacity,scale] duration-base ease-spring group-data-copied/code:scale-50 group-data-copied/code:opacity-0" />
        <Check strokeWidth={3} className="absolute inset-0 size-3 scale-50 opacity-0 transition-[opacity,scale] duration-base ease-spring group-data-copied/code:scale-100 group-data-copied/code:opacity-100" />
      </span>
    </span>
  );
}

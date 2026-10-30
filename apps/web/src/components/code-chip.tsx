import { cn } from "@terno/ui/lib/utils";
import { Copy } from "lucide-react";
import { codeKey, copyCode, useCodeState } from "~/lib/codes";
import "./code-chip.css";

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
      data-code={code}
      className={cn(
        "code-chip -my-0.5 inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border pr-1.5 pl-2 text-xs font-medium tracking-wide text-foreground tabular",
        className,
      )}
    >
      {/* outlined underneath; the accent above it, which shrinks away into the icon once copied (code-chip.css) */}
      <Label code={code} />
      <span aria-hidden className="code-chip-fill">
        <Label code={code} />
      </span>
    </span>
  );
}

function Label({ code }: { code: string }) {
  return (
    <>
      {code}
      {/* the copy icon makes way and the check draws itself in */}
      <span className="relative size-3 shrink-0">
        <Copy className="code-chip-copy size-3" />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="code-chip-check size-3">
          <path d="M4 12.5 9 17.5 20 6.5" pathLength={1} />
        </svg>
      </span>
    </>
  );
}

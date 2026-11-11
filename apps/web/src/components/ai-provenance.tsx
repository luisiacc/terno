import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Check, ChevronDown, Copy } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { modelName } from "~/lib/ai";
import { provenanceDetail, provenanceLabel } from "~/lib/provenance";

/**
 * Plan 161, pass 3: who wrote an AI text, one control on every AI surface, at the end of its button row: "Written with AI ▾",
 * a real button (it took focus as a bare label and did nothing), opening what the AI used and the model and when.
 */
export function AiProvenance({
  model,
  at,
  label = provenanceLabel(),
  detail,
  lines = [],
  children,
  testId,
  labelTestId = `${testId}-label`,
  popoverTestId = `${testId}-popover`,
  className,
  onKeyDown,
}: {
  /** the model that wrote it and when; "" leaves the detail line out (nothing is known) */
  model: string;
  at: number;
  /** the surface's own words from the same set (Edited after AI, Stopped part-way, Found with AI) */
  label?: string;
  /** the last line, if not "Written by {model}, {date}. It can make mistakes." */
  detail?: string;
  /** what the AI used, said first: the voice, what it read */
  lines?: readonly string[];
  children?: React.ReactNode;
  testId: string;
  labelTestId?: string;
  popoverTestId?: string;
  className?: string;
  /** a surface inside a command list keeps its own Enter and Space out of the list's (Ask) */
  onKeyDown?: React.KeyboardEventHandler;
}) {
  // plan 162: only what's known: a model without a time is said without one (a zero time is no date)
  const last = detail ?? (model ? (at > 0 ? provenanceDetail(model, at) : t("ai.provenance.modelOnly", { model: modelName(model) })) : null);
  return (
    <Popover>
      {/* quiet at rest, a chevron since it opens: the label reads as a status, the row's buttons as commands */}
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="sm" className={cn("shrink-0 px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground data-popup-open:text-foreground", className)} data-testid={testId} onKeyDown={onKeyDown} />}
      >
        <span data-testid={labelTestId}>{label}</span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      {/* its keys are its own: the popup is portalled, but its keys still bubble through React to whatever holds it (Enter and
          the arrows chose Ask's sources behind it; a reply's composer would close on its Esc). Base UI's own handlers sit on
          the popup and the document, so it still moves focus and closes (Codex review) */}
      <PopoverContent align="end" className="w-72 gap-2 text-sm" data-testid={popoverTestId} aria-label={t("ai.provenance.details")} onKeyDown={(e) => e.stopPropagation()}>
        {lines.length > 0 && (
          <ul className="flex flex-col gap-1">
            {lines.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
        {children}
        {last && <p className="text-xs text-muted-foreground" data-testid={`${testId}-detail`}>{last}</p>}
      </PopoverContent>
    </Popover>
  );
}

const COPIED_MS = 1500;

/**
 * Plan 161, pass 3: Copy, one button on every AI surface, at the row's 28 px, its glyph and word (plan 162: quiet); done,
 * it says Copied in place for a moment (and to a screen reader), and a failure says what to do.
 */
export function AiCopyButton({ text, failed, testId, className, onKeyDown, iconOnly = false }: { text: () => string; failed: string; testId: string; className?: string; onKeyDown?: React.KeyboardEventHandler; /** exploration (ai-looks): its glyph alone, named for screen readers */ iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      snack.error(failed);
    }
  };
  const button = (
    <Button type="button" variant="ghost" size={iconOnly ? "icon-sm" : "sm"} aria-label={iconOnly ? t(copied ? "ai.copied" : "ai.copy") : undefined} className={cn(!iconOnly && "px-2", "text-muted-foreground hover:text-foreground data-copied:text-foreground", className)} data-testid={testId} data-copied={copied || undefined} onKeyDown={onKeyDown} onClick={() => void copy()}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {/* the wider word holds the width, so nothing after it moves when it changes */}
      {!iconOnly && (
        <span className="grid">
          <span className="col-start-1 row-start-1">{t(copied ? "ai.copied" : "ai.copy")}</span>
          <span aria-hidden className="invisible col-start-1 row-start-1">{t(copied ? "ai.copy" : "ai.copied")}</span>
        </span>
      )}
    </Button>
  );
  return (
    <>
      {/* plan 162: a quiet utility (tier 3), never heavier than what the surface suggests doing: the summary's Reply was
          drawn lighter than this */}
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent side="bottom">{t(copied ? "ai.copied" : "ai.copy")}</TooltipContent>
        </Tooltip>
      ) : button}
      <span role="status" className="sr-only" data-testid={`${testId}-status`}>{copied ? t("ai.copied") : ""}</span>
    </>
  );
}

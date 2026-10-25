import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { CaseSensitive, Link2 } from "lucide-react";
import { lazy, Suspense } from "react";
import { controllerFor, toggleFormatBar, useFormatBar } from "./controller";

/**
 * The rich composer's entry points (plan 16): the editor and its format bar
 * live in a lazy chunk, loaded on intent (a conversation opened, the compose
 * button hovered or focused, a draft opened) and then kept.
 */

let loading: Promise<typeof import("./rich")> | null = null;
export const loadComposer = () => (loading ??= import("./rich"));
/** Starts loading the editor (idempotent). */
export function preloadComposer(): void {
  void loadComposer();
}

const LazyBody = lazy(() => loadComposer().then((m) => ({ default: m.RichBody })));
const LazyBar = lazy(() => loadComposer().then((m) => ({ default: m.FormatBar })));

/** The draft's body: the editor once loaded; until then a quiet placeholder of the same place (focus waits for the editor). */
export function ComposerBody({ draftKey, placeholder, className }: { draftKey: string; placeholder: string; className?: string }) {
  return (
    <Suspense fallback={<div className={cn("type-body text-muted-foreground", className)} aria-hidden data-testid="compose-body-loading">{placeholder}</div>}>
      <LazyBody draftKey={draftKey} placeholder={placeholder} className={className} />
    </Suspense>
  );
}

/** The format bar, when shown (Aa). */
export function ComposerFormatBar({ draftKey, id, className }: { draftKey: string; id: string; className?: string }) {
  const shown = useFormatBar((s) => s.shown);
  if (!shown) return null;
  return (
    <div id={id} className={className}>
      <Suspense fallback={<div className="h-9" aria-hidden />}>
        <LazyBar draftKey={draftKey} />
      </Suspense>
    </div>
  );
}

const quiet = "text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground [&_svg]:[stroke-width:var(--icon-stroke-toolbar)]";
// a click here mustn't take the selection away from the text it formats
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

/** "Aa": shows or hides the format bar (remembered on this device). */
export function FormatToggle({ controls }: { controls: string }) {
  const shown = useFormatBar((s) => s.shown);
  const label = t("compose.format.toggle");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-expanded={shown} aria-controls={controls} onMouseDown={keepSelection} onClick={toggleFormatBar} data-testid="format-toggle" className={quiet}>
            <CaseSensitive className="size-[18px]!" />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Insert link (⌘K): the editor's link popover for the selection. */
export function LinkButton({ draftKey, disabled }: { draftKey: string; disabled?: boolean }) {
  const label = t("compose.link.button");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onMouseDown={keepSelection} onClick={() => controllerFor(draftKey)?.openLink()} data-testid="compose-link" className={quiet}>
            <Link2 />
          </Button>
        }
      />
      <TooltipContent>
        {label}
        <Shortcut keys="mod+k" />
      </TooltipContent>
    </Tooltip>
  );
}

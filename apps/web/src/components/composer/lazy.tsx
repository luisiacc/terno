import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { CaseSensitive, Link2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { controllerFor, toggleFormatBar, useFormatBar } from "./controller";

/**
 * The rich composer's entry points (plan 16): the editor and its format bar
 * live in a lazy chunk, loaded on intent (a conversation opened, the compose
 * button hovered or focused, a draft opened) and then kept.
 */

type Rich = typeof import("./rich");
let loading: Promise<Rich> | null = null;
let loaded: Rich | null = null;
const listeners = new Set<() => void>();
export const loadComposer = (): Promise<Rich> =>
  (loading ??= import("./rich").then((m) => {
    loaded = m;
    for (const l of listeners) l();
    return m;
  }));
/** Starts loading the editor (idempotent). */
export function preloadComposer(): void {
  void loadComposer();
}
/** The editor module once loaded: rendered in the same commit as its draft (no suspense gap for a fast "r"). */
function useRich(): Rich | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void loadComposer();
      return () => listeners.delete(l);
    },
    () => loaded,
  );
}

/** What was typed into a body before its editor loaded, by draft: the editor takes it when it mounts. */
export const typedEarly = new Map<string, { text: string; focused: boolean }>();

/**
 * The draft's body: the editor once loaded. Until then (a first open on a slow
 * disk) a plain editable stand-in in the same place, so keys typed at once are
 * kept and handed to the editor.
 */
export function ComposerBody({ draftKey, placeholder, className }: { draftKey: string; placeholder: string; className?: string }) {
  const rich = useRich();
  if (rich) return <rich.RichBody draftKey={draftKey} placeholder={placeholder} className={className} />;
  return (
    <div
      role="textbox"
      aria-multiline="true"
      aria-label={t("compose.body")}
      aria-placeholder={placeholder}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      tabIndex={0}
      data-testid="compose-body-loading"
      onInput={(e) => typedEarly.set(draftKey, { text: e.currentTarget.innerText, focused: true })}
      onBlur={(e) => typedEarly.has(draftKey) && typedEarly.set(draftKey, { text: e.currentTarget.innerText, focused: false })}
      className={cn("type-body outline-none whitespace-pre-wrap empty:before:text-muted-foreground empty:before:content-[attr(aria-placeholder)]", className)}
    />
  );
}

/** The format bar, when shown (Aa). */
export function ComposerFormatBar({ draftKey, id, className }: { draftKey: string; id: string; className?: string }) {
  const shown = useFormatBar((s) => s.shown);
  const rich = useRich();
  if (!shown) return null;
  return (
    <div id={id} className={className}>
      {rich ? <rich.FormatBar draftKey={draftKey} /> : <div className="h-9" aria-hidden />}
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

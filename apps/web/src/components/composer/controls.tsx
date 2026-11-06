import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { CaseSensitive, Link2 } from "@terno/ui/icons";
import { controllerFor, toggleFormatBar, useFormatBar } from "./controller";
import { FormatBar } from "./rich";

/** The format bar, when shown (Aa). */
export function ComposerFormatBar({ draftKey, id, className }: { draftKey: string; id: string; className?: string }) {
  const shown = useFormatBar((s) => s.shown);
  if (!shown) return null;
  return (
    <div id={id} className={className}>
      <FormatBar draftKey={draftKey} />
    </div>
  );
}

const quiet = "text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground [&_svg]:[--icon-line:var(--icon-line-toolbar)]";
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

/** Insert link (⌘L): the editor's link popover for the selection. */
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
        <Shortcut keys="mod+l" />
      </TooltipContent>
    </Tooltip>
  );
}

import type { DatedMute } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { useId, useRef } from "react";
import { mute, muteAddress, muteName, unmute, wholeKindsLeft, type useDatedMutes } from "~/lib/dated-mutes";

/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"): what's muted in What matters, each with Unmute ("Show
 * again"), where What matters' settings are (its gear and Settings → What matters). A kind says it's from any
 * sender; a sender, their address beside their name; a pair (iteration 5) both ("Deliveries from Parcelo", the address). Unmute takes it off at once (with Undo in the snack) and keeps the
 * keys in the list: the next row's button, else the previous, else `fallback`.
 */
export function MutedList({ mutes, setMutes, testId, labelledBy, describedBy, fallback, empty }: { mutes: DatedMute[] | null; setMutes: ReturnType<typeof useDatedMutes>[1]; testId: string; labelledBy?: string; describedBy?: string; fallback?: () => HTMLElement | null; empty?: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  const baseId = useId();
  if (mutes === null) return null;
  if (!mutes.length) return empty ? <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>{t("dated.mute.empty")}</p> : null;
  const keyOf = (m: DatedMute) => `${m.on}:${m.key}`;
  const show = async (m: DatedMute, at: number) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>(`[data-testid=${testId}-unmute]`) ?? [])];
    const next = buttons[at + 1] ?? buttons[at - 1] ?? fallback?.() ?? null;
    setMutes((held) => held && held.filter((x) => keyOf(x) !== keyOf(m)));
    next?.focus({ preventScroll: true });
    // failed: back where it was
    if (!(await unmute(m))) setMutes((held) => held && [...held.filter((x) => keyOf(x) !== keyOf(m)), m].sort((a, b) => b.at - a.at));
  };
  return (
    <ul ref={list} aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col" data-testid={testId}>
      {mutes.map((m, i) => {
        const name = muteName(m);
        // a kind: from any sender; a sender or a pair: the address beside the name, never twice
        const detail = m.on === "kind" ? t("dated.mute.anySender") : muteAddress(m);
        const nameId = `${baseId}-${i}`;
        return (
          <li key={keyOf(m)} className="flex min-h-9 items-center gap-3 border-b border-hairline py-1 last:border-b-0" data-testid={`${testId}-item`}>
            <span className="min-w-0 flex-1 truncate text-sm">
              <span id={nameId} className="font-medium">{name}</span>
              {detail && <span className="ml-2 text-xs text-muted-foreground">{detail}</span>}
            </span>
            <Button variant="link-secondary" size="xs" className="shrink-0" aria-describedby={nameId} data-testid={`${testId}-unmute`} onClick={() => void show(m, i)}>
              {t("dated.mute.unmute")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Plan 210 (iteration 5): a whole kind is hidden only here, in Settings (Remove offers a kind from one sender): the kinds
 * not hidden yet, none of a person's requests. Choosing one hides it with Undo in the snack, and the list shows it.
 */
export function HideWholeKind({ mutes }: { mutes: DatedMute[] | null }) {
  const left = wholeKindsLeft(mutes);
  if (mutes === null || !left.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="link-secondary" size="xs" className="self-start" data-testid="today-hide-kind" />}>{t("dated.mute.hideWhole")}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max" data-testid="today-hide-kind-menu">
        {left.map((kind) => (
          <DropdownMenuItem key={kind} data-testid={`today-hide-kind-${kind}`} onClick={() => void mute({ on: "kind", key: kind })}>
            <span className="whitespace-nowrap">{muteName({ on: "kind", key: kind, name: "" })}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

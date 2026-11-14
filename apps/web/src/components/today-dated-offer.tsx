import { aiCanRun } from "@terno/core";
import type { SettingsPatch } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CloseButton } from "@terno/ui/components/close-button";
import { cn } from "@terno/ui/lib/utils";
import { reconcileSettings } from "~/lib/appearance";
import { scanOfferText, useDatedScanOffer } from "~/lib/dated";
import { focusQuietly } from "~/lib/quiet-focus";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";

/** The settings it writes, from where the offer is: the answer is the app's at once. */
async function saveDated(dated: NonNullable<SettingsPatch["dated"]>): Promise<void> {
  try {
    setApp({ settings: reconcileSettings(await client.call("settings.update", { dated })) });
  } catch (error) {
    snack.error(error instanceof Error ? error.message : String(error));
  }
}

/** The line went: focus that was on it goes to the list, without a ring (it wasn't the user's Tab). */
function handBack(): void {
  if (document.activeElement === document.body || !document.activeElement?.isConnected) focusQuietly(document.querySelector<HTMLElement>("[data-testid=thread-list] [data-keep-scroll=list]"));
}

/**
 * Plan 204 §6: the way in is where its result will be. While dates aren't read and AI can read them, Today's header offers
 * it in one quiet line, "Show bills, renewals and trips here. Turn on", dismissible for good. Once it's on, the same place
 * asks once about the last 14 days, with the count and the cost.
 */
export function TodayDatedOffer({ className }: { className?: string }) {
  const dated = useApp((s) => s.settings?.dated);
  const can = useApp((s) => aiCanRun("dated", s.settings?.ai));
  const scan = useDatedScanOffer(can && dated?.enabled === true && !dated.scanAnswered, (patch) => saveDated(patch));
  if (!dated || !can) return null;
  const line = cn("type-list-subtitle mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground", className);
  if (!dated.enabled) {
    if (dated.offerDismissed) return null;
    return (
      <p data-testid="today-dated-offer" className={line}>
        <span>{t("today.dated.offer")}</span>
        <span className="inline-flex items-center gap-x-2">
          <Button variant="link" data-testid="today-dated-on" onClick={() => void saveDated({ enabled: true }).then(handBack)}>{t("today.dated.turnOn")}</Button>
          <CloseButton label={t("today.dated.dismiss")} data-testid="today-dated-dismiss" onClick={() => void saveDated({ offerDismissed: true }).then(handBack)} />
        </span>
      </p>
    );
  }
  if (!scan.offer || scan.offer.count === 0) return null;
  return (
    <p data-testid="today-dated-scan" className={line}>
      <span>{scanOfferText(scan.offer)}</span>
      {/* the two answers wrap together, never one left alone on a line */}
      <span className="inline-flex items-center gap-x-2">
        <Button variant="link" data-testid="today-dated-check" onClick={() => void scan.answer(true).then(handBack)}>{t("today.dated.check")}</Button>
        <Button variant="link-secondary" data-testid="today-dated-notnow" onClick={() => void scan.answer(false).then(handBack)}>{t("today.dated.notNow")}</Button>
      </span>
    </p>
  );
}

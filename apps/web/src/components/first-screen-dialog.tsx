import { useEffect, useState } from "react";
import type { FirstScreen } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { useModalHost } from "@terno/ui/components/modal-host";
import { CalendarClock, CircleCheck, ListChecks, Settings2, Sun } from "@terno/ui/icons";
import { todayOffered } from "~/lib/ai";
import { client } from "~/rpc/connection";
import { reconcileSettings } from "~/lib/appearance";
import { getApp, navigate, setApp, useApp, type AppState } from "~/state/app";
import { TipPicture } from "./tip-picture";

/** Plan 207: not answered yet, What matters offered, a mailbox to show, and nothing else on the stage (no dialog or menu). */
const due = (s: AppState): boolean => s.ready && s.accounts.length > 0 && s.settings?.firstScreen === null && todayOffered(s) && s.dialog === null && !s.menuOpen;

/**
 * Plan 207: asks once, when What matters is first offered (AI turned on: a provider, Dev mode's switch, later Pro), which
 * screen the app opens on, and so which one number the sidebar and the Dock show. Waits for a clear stage (after Settings
 * closes, where AI is usually turned on); always mounted, it only watches.
 */
export function FirstScreenAsk() {
  const ready = useApp(due);
  const modal = useModalHost();
  useEffect(() => {
    if (ready && modal === null) setApp({ dialog: "firstScreen" });
  }, [ready, modal]);
  return null;
}

/** The question: a picture of the feed, three reasons, two answers. Esc keeps the Inbox. */
export function FirstScreenDialog() {
  const offered = useApp(todayOffered);
  const [saving, setSaving] = useState<FirstScreen | null>(null);
  const [failed, setFailed] = useState(false);
  // the gate went (AI turned off in another window): nothing to choose between any more, asked again when it's back
  useEffect(() => {
    if (!offered) setApp({ dialog: null });
  }, [offered]);

  const answer = async (choice: FirstScreen) => {
    if (saving) return;
    setSaving(choice);
    setFailed(false);
    try {
      const settings = reconcileSettings(await client.call("settings.update", { firstScreen: choice }));
      // (Codex code review #3) another dialog opened while it saved (⌘, works over dialogs): the setting lands, and
      // that dialog and where you are stay
      const ours = getApp().dialog === "firstScreen";
      setApp(ours ? { settings, dialog: null } : { settings });
      // what they chose, at once (only while it can still show)
      if (ours && choice === "whatMatters" && todayOffered(getApp())) navigate({ today: true });
    } catch {
      // stays open and says so: never closed as if it were saved, never asked again behind their back
      setFailed(true);
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && void answer("inbox")}>
      {/* no ×: the two answers say it, and Esc is Keep the Inbox (a × over the picture's corner said nothing more) */}
      <DialogContent showCloseButton={false} className="gap-5 sm:max-w-[27rem]" data-testid="first-screen-question">
        <FeedPicture />
        <DialogHeader>
          <DialogTitle>{t("firstScreen.ask.title")}</DialogTitle>
          <DialogDescription>{t("firstScreen.ask.body")}</DialogDescription>
        </DialogHeader>
        {/* the owner (2026-11-19): plain words a ten-year-old reads, each reason named first, then said */}
        <ul className="flex flex-col gap-3 text-sm" data-testid="first-screen-benefits">
          <Benefit icon={<ListChecks />} title={t("firstScreen.ask.first")} text={t("firstScreen.ask.firstText")} />
          <Benefit icon={<CalendarClock />} title={t("firstScreen.ask.dates")} text={t("firstScreen.ask.datesText")} />
          <Benefit icon={<CircleCheck />} title={t("firstScreen.ask.done")} text={t("firstScreen.ask.doneText")} />
          <Benefit icon={<Settings2 />} title={t("firstScreen.ask.yours")} text={t("firstScreen.ask.yoursText")} />
        </ul>
        <p className="text-xs text-muted-foreground">{t("firstScreen.ask.change")}</p>
        {failed && (
          <p role="alert" className="text-xs text-destructive-ink" data-testid="first-screen-error">
            {t("firstScreen.ask.failed")}
          </p>
        )}
        <DialogFooter className="mt-0">
          <Button variant="outline" disabled={saving !== null} onClick={() => void answer("inbox")} data-testid="first-screen-keep-inbox">
            {t("firstScreen.ask.keepInbox")}
          </Button>
          <Button autoFocus disabled={saving !== null} onClick={() => void answer("whatMatters")} data-testid="first-screen-choose-what-matters">
            {t("firstScreen.ask.whatMatters")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Benefit({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span aria-hidden className="mt-[0.15em] flex shrink-0 text-muted-foreground [&_svg]:size-[1.15em]">
        {icon}
      </span>
      <span>
        <span className="font-medium">{title}</span> <span className="text-muted-foreground">{text}</span>
      </span>
    </li>
  );
}

/** The feed in miniature (plan 113's picture style): a day's heading and three lines, each with its "when". Decorative. */
function FeedPicture() {
  const rows = [
    [t("firstScreen.picture.reply"), t("firstScreen.picture.replyWhen")],
    [t("firstScreen.picture.bill"), t("firstScreen.picture.billWhen")],
    [t("firstScreen.picture.promise"), t("firstScreen.picture.promiseWhen")],
  ] as const;
  return (
    <TipPicture className="px-3 pt-2.5 pb-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Sun className="size-3.5 text-sidebar-glyph" />
        <span>{t("today.title")}</span>
        <span className="ms-auto text-2xs font-normal text-muted-foreground">{t("sidebar.count.needYou", { count: 3 })}</span>
      </div>
      <div className="mt-2 text-2xs text-muted-foreground">{t("today.today")}</div>
      <div className="mt-0.5 divide-y divide-border">
        {rows.map(([line, when]) => (
          <div key={line} className="flex items-baseline gap-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate">{line}</span>
            <span className="shrink-0 text-2xs text-muted-foreground tabular">{when}</span>
          </div>
        ))}
      </div>
    </TipPicture>
  );
}

import type { AppSettings } from "@terno/core/rpc";
import { getLocale, localeTag, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { Time, TimeField } from "@terno/ui/components/time-field";
import { aiAllowed, datedReaderLine } from "~/lib/ai";
import { useDatedMutes } from "~/lib/dated-mutes";
import { useApp } from "~/state/app";
import { MutedList } from "../what-matters/muted-list";
import { openSettingsTab, SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

/** Plan 145 §5: Settings → General → Today. */
export default function TodaySettings({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const today = settings.today;
  // a local build with Dev mode's Pro AI off: the rows save, but Today stays out of the sidebar, so say why
  const proOff = !useApp(aiAllowed);
  const [h = 8, m = 0] = (today?.prepareAt ?? "08:00").split(":").map(Number);
  // plan 210 (iteration 1): who reads the mail for it, by where the dated reader's job goes
  const reader = datedReaderLine(settings.ai, "settings");
  const [mutes, setMutes] = useDatedMutes();
  return (
    <SettingsGroup title={t("today.title")} testId="today-settings" footer={reader && <span data-testid="today-privacy">{reader}</span>}>
      {proOff && (
        <SettingsRow find={false} label={t("today.settings.pro")} hint={t("today.settings.proHint")} testId="today-pro-note">
          {() => (
            <Button variant="outline" size="sm" data-testid="today-dev-open" onClick={() => openSettingsTab("dev")}>
              {t("settings.dev.open")}
            </Button>
          )}
        </SettingsRow>
      )}
      <SettingsRow find="general.today" label={t("today.settings.show")}>
        {(a) => <Switch {...a} checked={today?.show !== false} data-testid="today-show" onCheckedChange={(show) => void update({ today: { show } })} />}
      </SettingsRow>
      <SettingsRow find="general.todayFinished" label={t("today.settings.finished")} hint={t("today.settings.finishedHint")}>
        {(a) => <Switch {...a} checked={today?.finished !== false} data-testid="today-finished" onCheckedChange={(finished) => void update({ today: { finished } })} />}
      </SettingsRow>
      {/* plan 210 (iteration 4): what's muted, with Unmute; empty, how muting comes about */}
      <SettingsRow find="general.todayMuted" label={t("dated.mute.title")} hint={t("dated.mute.hint")} stacked testId="today-muted">
        {(a) => <MutedList mutes={mutes} setMutes={setMutes} testId="today-muted-list" labelledBy={a["aria-labelledby"]} describedBy={a["aria-describedby"]} fallback={() => document.querySelector<HTMLElement>("[data-testid=today-finished]")} empty />}
      </SettingsRow>
      <SettingsRow find="general.todayAt" label={t("today.settings.prepareAt")} hint={t("today.settings.prepareAtHint")}>
        {(a) => (
          <TimeField
            aria-labelledby={a["aria-labelledby"]}
            data-testid="today-prepare-at"
            locale={localeTag()}
            hourCycle={getLocale() === "en" ? 12 : 24}
            value={new Time(h, m)}
            onChange={(v) => {
              if (v) void update({ today: { prepareAt: `${String(v.hour).padStart(2, "0")}:${String(v.minute).padStart(2, "0")}` } });
            }}
            className="w-30 shrink-0"
          />
        )}
      </SettingsRow>
      <SettingsRow find="general.todayNotify" label={t("today.settings.notify")} hint={t("today.settings.notifyHint")}>
        {(a) => <Switch {...a} checked={today?.notify === true} data-testid="today-notify" onCheckedChange={(notify) => void update({ today: { notify } })} />}
      </SettingsRow>
    </SettingsGroup>
  );
}

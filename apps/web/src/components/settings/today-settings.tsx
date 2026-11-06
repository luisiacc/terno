import type { AppSettings } from "@terno/core/rpc";
import { getLocale, localeTag, t } from "@terno/i18n";
import { Switch } from "@terno/ui/components/switch";
import { Time, TimeField } from "@terno/ui/components/time-field";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

/** Plan 145 §5: Settings → General → Today, with its Time Field kept out of the settings chunk. */
export default function TodaySettings({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const today = settings.today;
  const [h = 8, m = 0] = (today?.prepareAt ?? "08:00").split(":").map(Number);
  return (
    <SettingsGroup title={t("today.title")} testId="today-settings">
      <SettingsRow label={t("today.settings.show")}>
        {(a) => <Switch {...a} checked={today?.show !== false} data-testid="today-show" onCheckedChange={(show) => void update({ today: { show } })} />}
      </SettingsRow>
      <SettingsRow label={t("today.settings.prepareAt")} hint={t("today.settings.prepareAtHint")}>
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
      <SettingsRow label={t("today.settings.notify")} hint={t("today.settings.notifyHint")}>
        {(a) => <Switch {...a} checked={today?.notify === true} data-testid="today-notify" onCheckedChange={(notify) => void update({ today: { notify } })} />}
      </SettingsRow>
    </SettingsGroup>
  );
}

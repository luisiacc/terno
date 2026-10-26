import type { UpdateChannel, UpdateState } from "@terno/core/updates";
import { localeTag, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { checkForUpdates, errorText, setUpdatePrefs, unsupportedText, useUpdates } from "~/lib/updates";
import { SettingsGroup, SettingsRow } from "./parts";

const CHANNELS = [
  { value: "stable", label: "updates.settings.stable" },
  { value: "nightly", label: "updates.settings.nightly" },
] as const;

/** "5 minutes ago", "yesterday": when the last check answered. */
function ago(at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: "auto" });
  const s = Math.round((at - now) / 1000);
  if (Math.abs(s) < 60) return t("updates.settings.justNow");
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, "hour");
  return rtf.format(Math.round(h / 24), "day");
}

function statusLine(state: UpdateState): string {
  if (state.status === "unsupported" && state.unsupported) return unsupportedText(state.unsupported);
  if (state.ready) return t("updates.settings.ready", { version: state.ready.version });
  if (state.status === "downloading") return t("updates.settings.downloading", { version: state.available?.version ?? "", percent: state.percent ?? 0 });
  if (state.status === "verifying") return t("updates.verifying");
  if (state.status === "available" && state.available) return t("updates.settings.available", { version: state.available.version });
  if (state.error) return errorText(state.error.kind);
  const checked = state.checkedAt ? t("updates.settings.lastChecked", { time: ago(state.checkedAt) }) : t("updates.settings.notChecked");
  return state.status === "up-to-date" ? t("updates.settings.upToDate", { checked }) : checked;
}

function channelHint(state: UpdateState): string {
  // Squirrel can't unstage an update: it installs first, on the channel it came from
  if (state.ready) return t("updates.settings.readyChannel", { version: state.ready.version });
  return t(state.channel === "nightly" ? "updates.settings.nightlyHint" : "updates.settings.stableHint");
}

/** Settings → General → Updates (desktop): how updates come, from which channel, and a check now. */
export function UpdatesSection() {
  const state = useUpdates((s) => s.state);
  const [checking, setChecking] = useState(false);
  if (!state) return null;
  const unsupported = state.status === "unsupported";
  const mode = state.localMode ? "updates.settings.localMode" : state.mode === "auto" ? "updates.settings.autoHint" : "updates.settings.manualHint";
  const modeHint = `${t(mode)} ${t("updates.settings.where")}`;
  return (
    <SettingsGroup
      title={t("updates.settings.title")}
      testId="updates-section"
      footer={
        <span data-testid="updates-version" className="inline-flex items-center gap-1.5 tabular-nums select-text">
          <TernoMark className="size-3.5" data-testid="updates-mark" />
          Terno {state.current}
        </span>
      }
    >
      <SettingsRow label={t("updates.settings.auto")} hint={modeHint} testId="updates-mode-row">
        {(a) => (
          <Switch
            {...a}
            data-testid="updates-auto-switch"
            disabled={unsupported}
            checked={state.mode === "auto"}
            onCheckedChange={(on) => void setUpdatePrefs({ mode: on ? "auto" : "manual", channel: state.channel })}
          />
        )}
      </SettingsRow>
      <SettingsRow label={t("updates.settings.channel")} hint={<span data-testid="updates-channel-hint">{channelHint(state)}</span>}>
        {({ id: _id, ...a }) => (
          <Select value={state.channel} disabled={unsupported || state.ready !== null} onValueChange={(v) => void setUpdatePrefs({ mode: state.mode, channel: v as UpdateChannel })} items={CHANNELS.map((c) => ({ value: c.value, label: t(c.label) }))}>
            <SelectTrigger {...a} size="sm" className="w-32" data-testid="updates-channel-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNELS.map((c) => (
                <SelectItem key={c.value} value={c.value} data-testid={`updates-channel-${c.value}`}>
                  {t(c.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
      <SettingsRow label={t("updates.settings.check")} hint={<span data-testid="updates-status">{statusLine(state)}</span>}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <Button
            {...a}
            variant="outline"
            size="sm"
            data-testid="updates-check"
            disabled={unsupported || checking || state.status === "checking" || state.status === "downloading" || state.status === "installing"}
            onClick={() => {
              setChecking(true);
              void checkForUpdates().finally(() => setChecking(false));
            }}
          >
            {(checking || state.status === "checking") && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t("updates.settings.checkNow")}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

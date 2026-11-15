import { DEV_AI_ENV, DEV_AI_PROVIDERS, type DevAiProvider } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { CircleAlert, CircleCheck } from "@terno/ui/icons";
import { useApp } from "~/state/app";
import { providerLabel, namesList } from "~/lib/ai";
import { setWmLook, useWmLook, WM_LOOKS, type WmLook } from "~/lib/what-matters-look";
import { PrivacyNote, SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

const RUNS: Record<DevAiProvider, () => string> = {
  anthropic: () => t("settings.dev.env.anthropic"),
  openai: () => t("settings.dev.env.openai"),
  jev: () => t("settings.dev.env.jev"),
};

/** Plan 146: only a local build gets here (`Bootstrap.devAi`). The renderer learns which variables are set, never a value. */
export function DevTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const set = useApp((s) => s.devAi);
  if (!set) return null;
  // plan 131: where Pro AI sends mail, said before it's turned on: the providers whose keys are set
  const names = DEV_AI_PROVIDERS.filter((p) => set[p]).map((p) => providerLabel(p));
  return (
    <div data-testid="dev-tab">
      <SettingsGroup footer={names.length > 0 && <PrivacyNote testId="dev-ai-privacy" title={t("ai.privacy")}>{t("settings.dev.proAi.disclosure", { count: names.length, providers: namesList(names) })}</PrivacyNote>}>
        <SettingsRow find="dev.proAi" label={t("settings.dev.proAi")} hint={t("settings.dev.proAi.hint")}>
          {(a) => <Switch {...a} data-testid="dev-ai-switch" checked={settings.devAi} disabled={!settings.devAi && !DEV_AI_PROVIDERS.some((p) => set[p])} onCheckedChange={(on) => void update({ devAi: on })} />}
        </SettingsRow>
        {settings.devAi && <SettingsNote testId="dev-ai-on">{t("settings.dev.proAi.on")}</SettingsNote>}
      </SettingsGroup>
      <WmLookGroup />
      <SettingsGroup find="dev.env" title={t("settings.dev.env")} footer={t("settings.dev.env.footer")}>
        {DEV_AI_PROVIDERS.map((provider) => (
          <SettingsRow find={false} key={provider} label={<span className="font-mono text-xs">{DEV_AI_ENV[provider]}</span>} hint={RUNS[provider]()} testId={`dev-env-${provider}`}>
            {() => (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {set[provider] ? <CircleCheck className="size-[1.15em]" aria-hidden /> : <CircleAlert className="size-[1.15em] text-destructive-ink" aria-hidden />}
                {set[provider] ? t("settings.dev.env.set") : t("settings.dev.env.missing")}
              </span>
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
    </div>
  );
}

/** Plan 204, the UI experiment: Today drawn as a list, a chat-like feed or a briefing, on this machine (`?wm=` overrides it for one load). */
function WmLookGroup() {
  const look = useWmLook((s) => s.look);
  const items = WM_LOOKS.map((value) => ({ value, label: t(`whatMatters.look.${value}`) }));
  return (
    <SettingsGroup>
      <SettingsRow find={false} label={t("whatMatters.look.setting")} hint={t("whatMatters.look.hint")}>
        {({ id: _id, ...a }) => (
          <Select value={look} onValueChange={(v) => setWmLook(v as WmLook)} items={items}>
            <SelectTrigger {...a} size="sm" className="w-auto min-w-32" data-testid="dev-wm-look">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((l) => (
                <SelectItem key={l.value} value={l.value} data-testid={`dev-wm-look-${l.value}`}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

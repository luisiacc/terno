import type { AppSettings } from "@terno/core/rpc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { Columns2, Rows3 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { updateAppearance } from "~/lib/appearance";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const density = () =>
  [
    { value: "comfortable", label: t("settings.appearance.density.comfortable") },
    { value: "compact", label: t("settings.appearance.density.compact") },
  ] as const;

/** How the mail list sits and reads: Appearance's first group. */
export function ListSettings({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  return (
    <SettingsGroup title={t("settings.appearance.list")}>
      {/* plan 24: the conversation beside the list, or in its place (applied at once, like the style) */}
      <SettingsRow label={t("settings.appearance.layout")} hint={t("settings.appearance.layout.hint")} testId="layout-row">
        {(a) => (
          <ToggleGroup
            aria-labelledby={a["aria-labelledby"]}
            aria-describedby={a["aria-describedby"]}
            variant="segmented"
            value={[settings.layout]}
            onValueChange={(v: string[]) => v[0] && void updateAppearance({ layout: v[0] as AppSettings["layout"] })}
            data-testid="layout-toggle"
          >
            <ToggleGroupItem value="split" data-testid="layout-split" className="gap-1.5">
              <Columns2 aria-hidden />
              {t("settings.appearance.layout.split")}
            </ToggleGroupItem>
            <ToggleGroupItem value="list" data-testid="layout-list" className="gap-1.5">
              <Rows3 aria-hidden />
              {t("settings.appearance.layout.list")}
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </SettingsRow>
      <SettingsRow label={t("settings.appearance.density")} hint={t("settings.appearance.density.hint")}>
        {({ id: _id, ...a }) => (
          <Select value={settings.density} onValueChange={(v) => void update({ density: v as AppSettings["density"] })} items={density().map((d) => ({ ...d }))}>
            <SelectTrigger {...a} size="sm" className="w-32" data-testid="density-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {density().map((d) => (
                <SelectItem key={d.value} value={d.value} data-testid={`density-${d.value}`}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

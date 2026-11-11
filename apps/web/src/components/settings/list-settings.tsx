import type { AppSettings, PreviewLines } from "@terno/core/rpc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { Columns2, Rows3 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { updateAppearance } from "~/lib/appearance";
import { SettingsGroup, SettingsRow } from "./parts";

const density = () =>
  [
    { value: "comfortable", label: t("settings.appearance.density.comfortable") },
    { value: "compact", label: t("settings.appearance.density.compact") },
  ] as const;

/** Plan 187: the preview's lines under a row's subject (Settings and first run offer the same three). */
export const previewChoices = (): { value: PreviewLines; label: string }[] => [
  { value: 0, label: t("settings.appearance.preview.none") },
  { value: 1, label: t("settings.appearance.preview.one") },
  { value: 2, label: t("settings.appearance.preview.two") },
];

/**
 * How the mail list sits and reads: Appearance's first group. Layout, density and the preview change the rows' shape:
 * through updateAppearance, at once, keeping the first row on screen and the open one where they were (plan 187).
 */
export function ListSettings({ settings }: { settings: AppSettings }) {
  const compact = settings.density === "compact";
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
          <Select value={settings.density} onValueChange={(v) => void updateAppearance({ density: v as AppSettings["density"] })} items={density().map((d) => ({ ...d }))}>
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
      {/* plan 187: Split's three-line rows; with Compact they are one line, so the row stays, off, and says why */}
      {settings.layout === "split" && (
        <SettingsRow label={t("settings.appearance.preview")} hint={t(compact ? "settings.appearance.preview.compactHint" : "settings.appearance.preview.hint")} testId="preview-row">
          {({ id: _id, ...a }) => (
            <Select value={settings.previewLines} disabled={compact} onValueChange={(v) => void updateAppearance({ previewLines: v as PreviewLines })} items={previewChoices()}>
              <SelectTrigger {...a} size="sm" className="w-32" data-testid="preview-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {previewChoices().map((d) => (
                  <SelectItem key={d.value} value={d.value} data-testid={`preview-${d.value}`}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

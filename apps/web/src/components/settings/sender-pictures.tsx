import type { AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { findAttrs, SettingsRow, type SettingsUpdate } from "./parts";

/**
 * Plan 22, Settings → Appearance: website icons (on by default in either mode, one tap to turn
 * off) and forgetting what’s saved. Plan 258 removed each Gmail account’s photos from Google.
 * Plan 294: rows of the Messages group, whose footer says where the icons are kept.
 */
export function SiteIconRows({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const canFetch = useApp((s) => s.host?.capabilities.siteIcons === true);
  const hint = !canFetch ? t("settings.appearance.siteIcons.hintWeb") : t("settings.appearance.siteIcons.hint");
  return (
    <>
      <SettingsRow find="appearance.siteIcons" testId="site-icons-row" label={t("settings.appearance.siteIcons")} hint={hint}>
        {(a) => <Switch {...a} data-testid="site-icons-switch" disabled={!canFetch} checked={canFetch && settings.senderIcons} onCheckedChange={(on) => void update({ senderIcons: on })} />}
      </SettingsRow>
      <div className="py-2.5">
        <Button
          variant="outline"
          size="sm"
          data-testid="forget-icons"
          {...findAttrs("appearance.forgetIcons")}
          onClick={() =>
            void client.call("icons.forget", {}).then(
              () => snack.success(t("settings.appearance.forgetIcons.done")),
              (error: unknown) => snack.error(error instanceof Error ? error.message : String(error)),
            )
          }
        >
          {t("settings.appearance.forgetIcons")}
        </Button>
      </div>
    </>
  );
}

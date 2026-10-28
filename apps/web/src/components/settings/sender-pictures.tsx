import type { Account } from "@terno/core";
import type { AppSettings, GooglePhotoState } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const WEB = import.meta.env.VITE_TARGET === "web";

/** What a Gmail account's photos state says, in a sentence. */
function photoHint(account: Account, state: GooglePhotoState | undefined, busy: boolean): string {
  if (busy) return t("settings.appearance.googlePhotos.waiting");
  if (!state) return t("settings.appearance.googlePhotos.hint", { email: account.email });
  if (state.apiDisabled) return t("settings.appearance.googlePhotos.apiDisabled");
  if (state.connections && state.otherContacts) return t("settings.appearance.googlePhotos.on", { email: account.email });
  if (state.connections) return t("settings.appearance.googlePhotos.onContacts", { email: account.email });
  if (state.otherContacts) return t("settings.appearance.googlePhotos.onOther", { email: account.email });
  return t("settings.appearance.googlePhotos.onOwn", { email: account.email });
}

function GooglePhotosRow({ account, state }: { account: Account; state: GooglePhotoState | undefined }) {
  const [busy, setBusy] = useState(false);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on && WEB) await (await import("~/web/google")).authorizeGooglePhotosWeb(account);
      else setApp({ settings: await client.call("icons.googlePhotos", { accountId: account.id, on }) });
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow testId={`google-photos-${account.id}`} label={t("settings.appearance.googlePhotos")} hint={photoHint(account, state, busy)}>
      {(a) => <Switch {...a} data-testid={`google-photos-switch-${account.id}`} disabled={busy} checked={!!state} onCheckedChange={(on) => void toggle(on)} />}
    </SettingsRow>
  );
}

/**
 * Plan 22, Settings → Appearance: website icons (on by default in either mode, one tap to turn
 * off), each Gmail account’s photos from Google, and forgetting what’s saved.
 */
export function SenderPictures({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const canFetch = useApp((s) => s.host?.capabilities.siteIcons === true);
  const accounts = useApp((s) => s.accounts);
  const gmail = accounts.filter((a) => a.kind === "gmail");
  const hint = !canFetch ? t("settings.appearance.siteIcons.hintWeb") : settings.localMode ? t("settings.appearance.siteIcons.hintLocal") : t("settings.appearance.siteIcons.hint");
  return (
    <SettingsGroup title={t("settings.appearance.senderPictures")} testId="sender-pictures" footer={t("settings.appearance.senderPictures.footer")}>
      <SettingsRow testId="site-icons-row" label={t("settings.appearance.siteIcons")} hint={hint}>
        {(a) => <Switch {...a} data-testid="site-icons-switch" disabled={!canFetch} checked={canFetch && settings.senderIcons} onCheckedChange={(on) => void update({ senderIcons: on })} />}
      </SettingsRow>
      {gmail.map((account) => (
        <GooglePhotosRow key={account.id} account={account} state={settings.googlePhotos[String(account.id)]} />
      ))}
      <div className="py-2.5">
        <Button
          variant="outline"
          size="sm"
          data-testid="forget-icons"
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
    </SettingsGroup>
  );
}

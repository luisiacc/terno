import type { Account } from "@terno/core";
import { t } from "@terno/i18n";
import { openLink } from "~/lib/open-link";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, useApp } from "~/state/app";
import { ConfirmDialog } from "./settings/parts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

/** plan 125: a Gmail account's grant is withdrawn on desktop; the web can't, so it says where to do it */
function description(account: Account, isOwner: boolean): string {
  if (account.kind !== "gmail") return isOwner ? t("account.remove.descriptionOwner") : t("account.remove.description");
  const text = window.ternoDesktop ? t("account.remove.descriptionGoogle") : t("account.remove.descriptionGoogleWeb");
  return isOwner ? `${text} ${t("account.remove.stays")}` : text;
}

/**
 * Remove Account…'s confirmation, the same from the sidebar's menu (plan 106) and Settings → Accounts. Lazy:
 * out of the entry chunk. From the sidebar, the removed row's focus goes to the row now in its place (or Add
 * account), but only when nothing else took it meanwhile (Codex R9).
 */
export function AccountRemoveDialog({ account, open, onOpenChange, from }: { account: Account; open: boolean; onOpenChange: (open: boolean) => void; from: "sidebar" | "settings" }) {
  const isOwner = useApp((s) => s.owner?.accountId === account.id);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      testId="account-remove-dialog"
      title={t("account.remove.title", { email: account.email })}
      description={description(account, isOwner)}
      confirm={t("account.remove.confirm")}
      // from the sidebar's menu, its row (Codex code review round 2 #4: the menu handed focus to the dialog, so
      // Cancel or a failure would leave it on whatever had it before); removed, the hand-off below moves it on
      finalFocus={from === "sidebar" ? () => document.querySelector<HTMLElement>(`[data-testid="nav-account-${account.id}"]`) ?? true : undefined}
      onConfirm={async () => {
        const ids = getApp().accounts.map((a) => a.id);
        const at = ids.indexOf(account.id);
        const next = ids[at + 1] ?? ids[at - 1];
        try {
          const removed = await client.call("accounts.remove", { id: account.id });
          // plan 125: removed here either way; if Google couldn't be told, the user withdraws the access there
          if (removed.google === "failed")
            snack.warning(t("account.removed"), { description: t("account.removed.googleFailedHint"), duration: 15_000, action: { label: t("account.removed.googleOpen"), onClick: () => openLink(GOOGLE_PERMISSIONS) } });
          else snack.success(t("account.removed"));
        } catch (e) {
          snack.error(errorText(e));
          return;
        }
        if (from !== "sidebar") return;
        // the row the dialog gave focus back to is gone (now or on the accounts event): the next one takes it
        const handOff = () => {
          const active = document.activeElement;
          const row = document.querySelector(`[data-testid="nav-account-${account.id}"]`);
          if (active && active !== document.body && active.isConnected && active !== row) return false;
          const target = next === undefined ? null : document.querySelector<HTMLElement>(`[data-testid="nav-account-${next}"]`);
          (target ?? document.querySelector<HTMLElement>("[data-testid=sidebar-add-account]"))?.focus();
          return true;
        };
        requestAnimationFrame(() => {
          if (!document.querySelector(`[data-testid="nav-account-${account.id}"]`)) handOff();
          else {
            // the accounts event hasn't come yet: wait for the row to go
            const stop = useApp.subscribe((s) => {
              if (s.accounts.some((a) => a.id === account.id)) return;
              stop();
              requestAnimationFrame(handOff);
            });
          }
        });
      }}
    />
  );
}

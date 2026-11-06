import { SentCopies } from "./sent-copies";
import { RecipientReceipts } from "./recipient-receipts";
import { localized } from "~/lib/i18n";
import { separatesTabs, type Account, type CategoryColor } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@terno/ui/components/accordion";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Input } from "@terno/ui/components/input";
import { Switch } from "@terno/ui/components/switch";
import { cn } from "@terno/ui/lib/utils";
import { Plus, RefreshCw, Trash2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useEffect, useId, useState } from "react";
import { snack } from "~/lib/snack";
import { setSeparateTabs } from "~/lib/gmail-tabs";
import { client } from "~/rpc/connection";
import { canStart, clearAttemptError, needsSignIn, prepareGoogle, signInAgain, useSignIn } from "~/lib/sign-in";
import { retryIn } from "../connection-pill";
import { getApp, setApp, useApp } from "~/state/app";
import { patchAccount, type AccountEdit } from "~/lib/accounts";
import { DaysField } from "./general-tab";
import { AccountWriting } from "./ai-drafting";
import { OwnerCard } from "./owner-card";
import { AccountRemoveDialog } from "../account-remove-dialog";
import { ColorPicker, CommitInput, SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";
import CaptureRecovery from "./capture-recovery";


const WEB = import.meta.env.VITE_TARGET === "web";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function status(a: Account): string {
  // plan 25: an expired or refused sign-in isn't an error the user made: it asks, calmly
  if (needsSignIn(a)) return t("account.status.signIn");
  const error = localized(a.syncState.lastError, a.syncState.lastErrorI18n);
  if (a.syncState.status === "error") return error ? t("account.status.error", { error }) : t("account.status.errorUnknown");
  // plan 20: can't reach its server; when it tries again (the sidebar's pill counts down, this is a snapshot)
  const connection = a.syncState.connection;
  if (connection?.state === "reconnecting") return t("account.status.reconnecting");
  if (connection?.retryAt) {
    const time = retryIn(connection.retryAt - Date.now());
    return error ? t("account.status.offlineRetryError", { time, error }) : t("account.status.offlineRetry", { time });
  }
  if (a.syncState.status === "offline") return error ? t("account.status.offlineError", { error }) : t("account.status.offline");
  if (a.syncState.status === "syncing") return t("account.status.syncing");
  return t("account.status.upToDate");
}

/**
 * Gmail signs in again with Google (in the browser, Google's own window); IMAP with the password, checked by a live
 * login. The same attempt as the sidebar's sign-in panel (plan 25): its error shows here, under the button.
 */
function Reconnect({ account }: { account: Account }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const attempt = useSignIn((s) => s.attempts.get(account.id) ?? null);
  const google = useSignIn((s) => s.google);
  const busy = Boolean(attempt?.busy);
  const passwordId = useId();
  // the web's Google popup needs its script before the click (Codex review #9)
  useEffect(() => {
    if (WEB && account.kind === "gmail") prepareGoogle();
  }, [account.kind]);
  const run = async () => {
    if (await signInAgain(account, account.kind === "imap" ? password : undefined)) {
      setAsking(false);
      setPassword("");
    }
  };
  const error = attempt?.error ? (
    <div role="alert" className="text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="account-reconnect-error">
      <p className="text-destructive-ink">{attempt.error.message}</p>
      {attempt.error.detail && <p className="text-muted-foreground">{attempt.error.detail}</p>}
    </div>
  ) : null;
  if (account.kind === "imap" && asking) {
    return (
      <div className="flex w-full flex-col gap-1.5">
        <form
          className="flex w-full items-center gap-2"
          data-testid="account-reconnect-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy) void run();
          }}
        >
        <label htmlFor={passwordId} className="sr-only">
          {t("account.passwordFor", { email: account.email })}
        </label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="off"
            autoFocus
            required
            readOnly={busy}
            aria-invalid={attempt?.error ? true : undefined}
            className="h-7 flex-1 bg-background dark:bg-input/30"
            placeholder={t("account.password")}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearAttemptError(account.id);
            }}
            data-testid="account-reconnect-password"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAsking(false);
              clearAttemptError(account.id);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" focusableWhenDisabled disabled={!password} loading={busy} data-testid="account-reconnect-submit">
            {t("account.verifySave")}
          </Button>
        </form>
        {error}
      </div>
    );
  }
  const ready = canStart(account, google);
  const failed = !ready && google === "failed";
  const label = needsSignIn(account) ? t("account.signInAgain") : account.kind === "gmail" ? t("account.connectGoogle") : t("account.changePassword");
  return (
    <div className="flex w-full min-w-0 flex-col items-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        focusableWhenDisabled
        disabled={busy}
        aria-disabled={busy || (!ready && !failed) || undefined}
        loading={busy || (google === "loading" && !ready)}
        data-testid="account-reconnect"
        onClick={() => {
          if (account.kind === "imap") setAsking(true);
          // Google's script didn't load (offline?): this click tries again (Codex code review #4)
          else if (failed) prepareGoogle();
          else if (ready) void run();
        }}
      >
        <RefreshCw /> {label}
      </Button>
      {error}
      {failed && (
        <p role="alert" className="text-xs text-destructive-ink" data-testid="account-reconnect-google-failed">
          {t("web.google.loadFailed")}
        </p>
      )}
    </div>
  );
}

function AccountEditor({ account, generalWindow, isOwner }: { account: Account; generalWindow: number; isOwner: boolean }) {
  const [removing, setRemoving] = useState(false);
  // the text fields keep what was typed and say a failure under it: the account changes once the backend has it
  const save = (patch: AccountEdit) => patchAccount(account.id, patch, { optimistic: "color" in patch });
  return (
    <div className="hairline-divide pb-1 pl-5" data-testid="account-editor">
      <SettingsRow labelFor label={t("account.name")} hint={t("account.name.hint")}>
        {(a) => <CommitInput a11y={a} className="w-56" data-testid="account-name" value={account.displayName} validate={(v) => (v.trim() ? null : t("settings.nameEmpty"))} onCommit={(v) => save({ displayName: v.trim() })} />}
      </SettingsRow>
      <SettingsRow labelFor label={t("account.sender")} hint={t("account.sender.hint")}>
        {(a) => <CommitInput a11y={a} className="w-56" data-testid="account-sender" value={account.senderName} onCommit={(v) => save({ senderName: v.trim() })} />}
      </SettingsRow>
      <SettingsRow label={t("settings.color")}>
        {(a) => <ColorPicker a11y={a} name={`account-color-${account.id}`} testId="account-color" value={account.color} onChange={(color) => save({ color }).catch((e: unknown) => { snack.error(errorText(e)); throw e; })} />}
      </SettingsRow>
      <SettingsRow stacked labelFor label={t("account.signature")} hint={t("account.signature.hint")}>
        {(a) => <CommitInput multiline a11y={a} data-testid="account-signature" value={account.signature} placeholder={t("account.signature.placeholder")} maxLength={10_000} onCommit={(v) => save({ signature: v })} />}
      </SettingsRow>
      <AccountWriting accountId={account.id} />
      <SettingsRow labelFor label={t("settings.general.syncWindow")} hint={t("account.syncWindow.hint", { days: generalWindow })}>
        {(a) => (
          <DaysField
            a11y={a}
            testId="account-window"
            value={account.syncWindowDays}
            placeholder={String(generalWindow)}
            allowEmpty
            onSave={(days) => save({ syncWindowDays: days })}
          />
        )}
      </SettingsRow>
      {/* plan 86: Gmail's Promotions and Social, under the account and out of the Inbox */}
      {account.kind === "gmail" && (
        <SettingsRow label={t("account.separateTabs")} hint={t("account.separateTabs.hint")}>
          {(a) => <Switch {...a} data-testid="account-separate-tabs" checked={separatesTabs(account)} onCheckedChange={(on) => void setSeparateTabs(account.id, on)} />}
        </SettingsRow>
      )}
      {/* plan 142 */}
      <SettingsRow label={t("account.followups")} hint={t("account.followups.hint")}>
        {(a) => <Switch {...a} data-testid="account-followups" checked={account.followups !== false} onCheckedChange={(on) => void client.call("accounts.update", { id: account.id, followups: on })} />}
      </SettingsRow>
      <SettingsRow stacked label={t("account.connection")} hint={<span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{status(account)}</span>}>
        {() => <Reconnect account={account} />}
      </SettingsRow>
      <CaptureRecovery key={`capture:${account.id}`} accountId={account.id} />
      {account.kind === "imap" && <><SentCopies key={`copy:${account.id}`} accountId={account.id} /><RecipientReceipts key={`recipients:${account.id}`} accountId={account.id} /></>}
      <SettingsRow label={t("account.remove")} hint={isOwner ? t("account.remove.hintOwner") : t("account.remove.hint")}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <>
            <Button {...a} variant="ghost" size="sm" className="text-destructive-ink" data-testid="account-remove" onClick={() => setRemoving(true)}>
              <Trash2 /> {t("account.remove.button")}
            </Button>
            <AccountRemoveDialog account={account} open={removing} onOpenChange={setRemoving} from="settings" />
          </>
        )}
      </SettingsRow>
    </div>
  );
}

/** One account in the list: its row opens its settings in place (an accordion section, several may be open). */
function AccountItem({ account, generalWindow, isOwner }: { account: Account; generalWindow: number; isOwner: boolean }) {
  // a sign-in to redo reads calmly (plan 25); a real error or an outage in the error ink
  const attention = !needsSignIn(account) && (account.syncState.status === "error" || account.syncState.status === "offline");
  return (
    <AccordionItem value={account.id} data-testid="settings-account" data-account-id={account.id}>
      <AccordionTrigger level={4} className="-mx-2 w-[calc(100%+1rem)] rounded-md px-2 py-2.5 [contain:inline-size]" data-testid="account-toggle">
        <CategoryDot color={account.color as CategoryColor} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{account.displayName}</span>
          <span className={cn("block truncate text-xs", attention ? "text-destructive-ink" : "text-muted-foreground")}>
            {account.email} · {account.kind === "gmail" ? "Gmail" : "IMAP/SMTP"} · {status(account)}
          </span>
        </span>
      </AccordionTrigger>
      <AccordionPanel>
        <AccountEditor account={account} generalWindow={generalWindow} isOwner={isOwner} />
      </AccordionPanel>
    </AccordionItem>
  );
}

export function AccountsTab({ settings }: { settings: AppSettings; update: SettingsUpdate }) {
  const accounts = useApp((s) => s.accounts);
  const owner = useApp((s) => s.owner);
  const demo = useApp((s) => s.demo);
  return (
    <div data-testid="accounts-tab">
      <OwnerCard owner={owner} demo={demo} accounts={accounts} />
      <SettingsGroup title={t("account.list")} testId="accounts-group">
        {/* plan 106: Settings opened on an account (the sidebar's Account Settings…) opens it; later events leave it be */}
        <Accordion multiple defaultValue={accounts.filter((a) => a.id === getApp().settingsAccount).map((a) => a.id)} className="hairline-divide">
          {accounts.map((a) => (
            <AccountItem key={a.id} account={a} generalWindow={settings.syncWindowDays} isOwner={owner?.accountId === a.id} />
          ))}
        </Accordion>
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2" data-testid="settings-add-account" onClick={() => setApp({ dialog: "addAccount" })}>
            <Plus /> {t("account.add")}
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}

import { SentCopies } from "./sent-copies";
import { localized } from "~/lib/i18n";
import type { Account, AccountPatch, CategoryColor } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Input } from "@terno/ui/components/input";
import { cn } from "@terno/ui/lib/utils";
import { ChevronRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { t } from "@terno/i18n";
import { useEffect, useId, useState } from "react";
import { snack } from "~/lib/snack";
import { canStart, clearAttemptError, needsSignIn, prepareGoogle, signInAgain, useSignIn } from "~/lib/sign-in";
import { retryIn } from "../connection-pill";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { DaysField } from "./general-tab";
import { OwnerCard } from "./owner-card";
import { ColorPicker, CommitInput, ConfirmDialog, SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

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

async function updateAccount(id: number, patch: AccountPatch): Promise<void> {
  const next = await client.call("accounts.update", { id, ...patch });
  setApp((s) => ({ accounts: s.accounts.map((a) => (a.id === next.id ? next : a)) }));
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
    <div role="alert" className="text-xs leading-relaxed" data-testid="account-reconnect-error">
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
            disabled={busy}
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
          <Button type="submit" size="sm" disabled={busy || !password} data-testid="account-reconnect-submit">
            {busy && <Loader2 className="animate-spin" />} {t("account.verifySave")}
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
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-disabled={(!ready && !failed) || undefined}
        data-testid="account-reconnect"
        onClick={() => {
          if (account.kind === "imap") setAsking(true);
          // Google's script didn't load (offline?): this click tries again (Codex code review #4)
          else if (failed) prepareGoogle();
          else if (ready) void run();
        }}
      >
        {busy || (google === "loading" && !ready) ? <Loader2 className="animate-spin" /> : <RefreshCw />} {label}
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
  const save = (patch: AccountPatch) => updateAccount(account.id, patch);
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
      <SettingsRow label={t("account.connection")} hint={status(account)}>
        {() => <Reconnect account={account} />}
      </SettingsRow>
      {account.kind === "imap" && <SentCopies key={account.id} accountId={account.id} />}
      <SettingsRow label={t("account.remove")} hint={isOwner ? t("account.remove.hintOwner") : t("account.remove.hint")}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <>
            <Button {...a} variant="ghost" size="sm" className="text-destructive-ink" data-testid="account-remove" onClick={() => setRemoving(true)}>
              <Trash2 /> {t("account.remove.button")}
            </Button>
            <ConfirmDialog
              open={removing}
              onOpenChange={setRemoving}
              testId="account-remove-dialog"
              title={t("account.remove.title", { email: account.email })}
              description={isOwner ? t("account.remove.descriptionOwner") : t("account.remove.description")}
              confirm={t("account.remove.confirm")}
              onConfirm={async () => {
                try {
                  await client.call("accounts.remove", { id: account.id });
                  snack.success(t("account.removed"));
                } catch (e) {
                  snack.error(errorText(e));
                }
              }}
            />
          </>
        )}
      </SettingsRow>
    </div>
  );
}

function AccountItem({ account, generalWindow, isOwner }: { account: Account; generalWindow: number; isOwner: boolean }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  // a sign-in to redo reads calmly (plan 25); a real error or an outage in the error ink
  const attention = !needsSignIn(account) && (account.syncState.status === "error" || account.syncState.status === "offline");
  return (
    <div data-testid="settings-account" data-account-id={account.id}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="account-toggle"
      >
        <CategoryDot color={account.color as CategoryColor} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{account.displayName}</span>
          <span className={cn("block truncate text-xs", attention ? "text-destructive-ink" : "text-muted-foreground")}>
            {account.email} · {account.kind === "gmail" ? "Gmail" : "IMAP/SMTP"} · {status(account)}
          </span>
        </span>
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-fast", open && "rotate-90")} />
      </button>
      <div id={panel} hidden={!open}>
        {open && <AccountEditor account={account} generalWindow={generalWindow} isOwner={isOwner} />}
      </div>
    </div>
  );
}

function GoogleClient({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const [secret, setSecret] = useState("");
  const saveSecret = async (value: string) => {
    try {
      await client.call("settings.setSecret", { name: "gmailClientSecret", value });
      setApp((s) => (s.settings ? { settings: { ...s.settings, gmailClientSecretSet: value !== "", gmailClientSecretUnreadable: false } } : {}));
      setSecret("");
      snack.success(value ? t("account.google.secretSaved") : t("account.google.secretRemoved"));
    } catch (e) {
      snack.error(errorText(e));
    }
  };
  return (
    <SettingsGroup
      title="Google (Gmail)"
      footer={
        WEB ? t("account.google.footerWeb", { origin: location.origin }) : t("account.google.footer")
      }
    >
      {/* i18n-ignore: Google Cloud Console's name for the field, kept so it matches what people copy it from */}
      <SettingsRow stacked labelFor label="Google OAuth Client ID">
        {(a) => <CommitInput a11y={a} data-testid="gmail-client-id" value={settings.gmailClientId} placeholder="xxxxx.apps.googleusercontent.com" onCommit={(v) => update({ gmailClientId: v.trim() }, { quiet: true })} />}
      </SettingsRow>
      {!WEB && (
        <SettingsRow stacked labelFor label={t("account.google.secret")} hint={t("account.google.secret.hint")}>
          {(a) =>
            settings.gmailClientSecretSet && !settings.gmailClientSecretUnreadable ? (
              <div className="flex items-center gap-2 text-sm" data-testid="gmail-secret-saved">
                <span className="text-success-ink">{t("account.google.saved")}</span>
                <Button variant="ghost" size="xs" onClick={() => void saveSecret("")}>
                  {t("common.remove")}
                </Button>
              </div>
            ) : (
              <>
                {settings.gmailClientSecretUnreadable && (
                  <p role="alert" className="mb-1.5 text-xs text-destructive-ink" data-testid="gmail-secret-unreadable">
                    {t("account.google.secretUnreadable")}
                  </p>
                )}
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (secret.trim()) void saveSecret(secret.trim());
                  }}
                >
                  <Input {...a} type="password" autoComplete="off" className="h-7 bg-background dark:bg-input/30" data-testid="gmail-secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
                  <Button type="submit" size="sm" disabled={!secret.trim()}>
                    {t("common.save")}
                  </Button>
                </form>
              </>
            )
          }
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

export function AccountsTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const accounts = useApp((s) => s.accounts);
  const owner = useApp((s) => s.owner);
  const demo = useApp((s) => s.demo);
  return (
    <div data-testid="accounts-tab">
      <OwnerCard owner={owner} demo={demo} accounts={accounts} />
      <SettingsGroup title={t("account.list")} testId="accounts-group">
        {accounts.map((a) => (
          <AccountItem key={a.id} account={a} generalWindow={settings.syncWindowDays} isOwner={owner?.accountId === a.id} />
        ))}
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2" data-testid="settings-add-account" onClick={() => setApp({ dialog: "addAccount" })}>
            <Plus /> {t("account.add")}
          </Button>
        </div>
      </SettingsGroup>
      <GoogleClient settings={settings} update={update} />
    </div>
  );
}

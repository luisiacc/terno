import { SentCopies } from "./sent-copies";
import { RecipientReceipts } from "./recipient-receipts";
import { localized } from "~/lib/i18n";
import { allInboxOffered, inAllInbox, separatesTabs, signInMethod, unhandled, type Account, type AccountKind, type SignInMethod } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@terno/ui/components/accordion";
import { Button, GHOST_DANGER_PRESS } from "@terno/ui/components/button";
import { AccountMark } from "@terno/ui/components/category-dot";
import { Input } from "@terno/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Switch } from "@terno/ui/components/switch";
import { cn } from "@terno/ui/lib/utils";
import { KeyRound, Plus, RefreshCw, Trash2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useEffect, useId, useState } from "react";
import { snack } from "~/lib/snack";
import { setSeparateTabs } from "~/lib/gmail-tabs";
import { setInAllInbox } from "~/lib/account-inbox";
import { client } from "~/rpc/connection";
import { canStart, clearAttemptError, needsGoogleScript, needsSignIn, prepareGoogle, signInAgain, useSignIn } from "~/lib/sign-in";
import SignInPanel from "../sign-in-panel";
import { retryIn } from "../connection-pill";
import { getApp, setApp, useApp } from "~/state/app";
import { reopenedRows } from "~/lib/settings-place";
import { patchAccount, setAccountFeed, type AccountEdit } from "~/lib/accounts";
import { aiFeaturesOffered } from "~/lib/ai";
import { DaysField } from "./days-field";
import { AccountWriting } from "./ai-drafting";
import { OwnerCard } from "./owner-card";
import { AccountRemoveDialog } from "../account-remove-dialog";
import { ColorPicker, CommitInput, findAttrs, SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";
import CaptureRecovery from "./capture-recovery";


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

/** What the button says for an account that works: the way it would sign in again (plan 184: every method names one). */
function changeLabel(method: SignInMethod): string {
  switch (method) {
  case "password": return t("account.changePassword");
  case "google": return t("account.connectGoogle");
  case "microsoft": return t("account.connectMicrosoft");
  default: return unhandled(method);
  }
}

/** The account's service on its row, by name (brands, not translated). */
export function serviceLabel(kind: AccountKind): string {
  switch (kind) {
  case "gmail": return "Gmail";
  case "outlook": return "Outlook";
  case "imap": return "IMAP/SMTP";
  default: return unhandled(kind);
  }
}

/**
 * Gmail signs in again with Google and Outlook with Microsoft (in the browser, their own window); IMAP with the
 * password, checked by a live login. The same attempt as the sidebar's sign-in panel (plan 25): its error shows here,
 * under the button.
 */
function Reconnect({ account }: { account: Account }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const attempt = useSignIn((s) => s.attempts.get(account.id) ?? null);
  const script = useSignIn((s) => s.google);
  const busy = Boolean(attempt?.busy);
  const passwordId = useId();
  const method = signInMethod(account.kind);
  const google = needsGoogleScript(account);
  // the web's Google popup needs its script before the click (Codex review #9)
  useEffect(() => {
    if (google) prepareGoogle();
  }, [google]);
  const run = async () => {
    if (await signInAgain(account, method === "password" ? password : undefined)) {
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
  if (method === "password" && asking) {
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
  const ready = canStart(account, script);
  const failed = !ready && script === "failed";
  const label = needsSignIn(account) ? t("account.signInAgain") : changeLabel(method);
  return (
    <div className="flex w-full min-w-0 flex-col items-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        focusableWhenDisabled
        disabled={busy}
        aria-disabled={busy || (!ready && !failed) || undefined}
        loading={busy || (script === "loading" && !ready)}
        data-testid="account-reconnect"
        onClick={() => {
          if (method === "password") setAsking(true);
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

function AccountEditor({ account, generalWindow, isOwner, nameId }: { account: Account; generalWindow: number; isOwner: boolean; /** the account's name in its row: each part is named by it too */ nameId: string }) {
  const [removing, setRemoving] = useState(false);
  // the text fields keep what was typed and say a failure under it: the account changes once the backend has it
  const save = (patch: AccountEdit) => patchAccount(account.id, patch, { optimistic: "color" in patch });
  // plan 211: the account's two switches show where AI features can run; with its AI off, what depends on it isn't here
  const aiOffered = useApp(aiFeaturesOffered);
  const aiOn = account.ai !== false;
  // plan 238: with several accounts (with one, the Inbox is that account's), or while it's out
  const allInbox = useApp((s) => allInboxOffered(account, s.accounts.length));
  return (
    <div className="hairline-divide pb-1 pl-5" data-testid="account-editor">
      <AccountPart title={t("account.part.identity")} nameId={nameId} testId="account-part-identity">
        <SettingsRow find="account.name" labelFor label={t("account.name")} hint={t("account.name.hint")}>
          {(a) => <CommitInput a11y={a} className="w-56" data-testid="account-name" value={account.displayName} validate={(v) => (v.trim() ? null : t("settings.nameEmpty"))} onCommit={(v) => save({ displayName: v.trim() })} />}
        </SettingsRow>
        <SettingsRow find="account.sender" labelFor label={t("account.sender")} hint={t("account.sender.hint")}>
          {(a) => <CommitInput a11y={a} className="w-56" data-testid="account-sender" value={account.senderName} onCommit={(v) => save({ senderName: v.trim() })} />}
        </SettingsRow>
        <SettingsRow find="account.color" label={t("settings.color")}>
          {(a) => <ColorPicker a11y={a} name={`account-color-${account.id}`} testId="account-color" value={account.color} onChange={(color) => save({ color }).catch((e: unknown) => { snack.error(errorText(e)); throw e; })} />}
        </SettingsRow>
        <SettingsRow find="account.signature" stacked labelFor label={t("account.signature")} hint={t("account.signature.hint")}>
          {(a) => <CommitInput multiline a11y={a} data-testid="account-signature" value={account.signature} placeholder={t("account.signature.placeholder")} maxLength={10_000} onCommit={(v) => save({ signature: v })} />}
        </SettingsRow>
      </AccountPart>
      <AccountPart title={t("account.part.mailbox")} nameId={nameId} testId="account-part-mailbox">
        <SettingsRow find="account.syncWindow" labelFor label={t("account.syncWindow")} hint={t("account.syncWindow.hint", { days: generalWindow })}>
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
        {/* plan 238: in the all-accounts Inbox, or only under its row */}
        {allInbox && (
          <SettingsRow find="account.allInbox" label={t("account.allInbox")} hint={t("account.allInbox.hint")}>
            {(a) => <Switch {...a} data-testid="account-all-inbox" checked={inAllInbox(account)} onCheckedChange={(on) => void setInAllInbox(account.id, on)} />}
          </SettingsRow>
        )}
        {/* plan 86: Gmail's Promotions and Social, under the account and out of the Inbox */}
        {account.kind === "gmail" && (
          <SettingsRow find="account.separateTabs" label={t("account.separateTabs")} hint={t("account.separateTabs.hint")}>
            {(a) => <Switch {...a} data-testid="account-separate-tabs" checked={separatesTabs(account)} onCheckedChange={(on) => void setSeparateTabs(account.id, on)} />}
          </SettingsRow>
        )}
        {/* plan 275: Outlook's Focused Inbox Other, the same preference */}
        {account.kind === "outlook" && (
          <SettingsRow find="account.separateOther" label={t("account.separateOther")} hint={t("account.separateOther.hint")}>
            {(a) => <Switch {...a} data-testid="account-separate-other" checked={separatesTabs(account)} onCheckedChange={(on) => void setSeparateTabs(account.id, on)} />}
          </SettingsRow>
        )}
      </AccountPart>
      {(aiOffered || aiOn) && (
        <AccountPart title={t("account.part.ai")} nameId={nameId} testId="account-part-ai">
          {aiOffered && (
            <>
              <SettingsRow find="account.ai" label={t("account.ai")} hint={t("account.ai.hint")}>
                {(a) => <Switch {...a} data-testid="account-ai" checked={aiOn} onCheckedChange={(on) => void client.call("accounts.update", { id: account.id, ai: on })} />}
              </SettingsRow>
              <SettingsRow find="account.feed" label={t("account.feed")} hint={t("account.feed.hint")}>
                {(a) => <Switch {...a} data-testid="account-feed" checked={account.feed !== false} onCheckedChange={(on) => void setAccountFeed(account.id, on)} />}
              </SettingsRow>
            </>
          )}
          {/* plan 142 */}
          {aiOn && (
            <SettingsRow find="account.followups" label={t("account.followups")} hint={t("account.followups.hint")}>
              {(a) => <Switch {...a} data-testid="account-followups" checked={account.followups !== false} onCheckedChange={(on) => void client.call("accounts.update", { id: account.id, followups: on })} />}
            </SettingsRow>
          )}
          {aiOn && <AccountWriting accountId={account.id} />}
        </AccountPart>
      )}
      <AccountPart title={t("account.part.connection")} nameId={nameId} testId="account-part-connection">
        <SettingsRow find="account.connection" stacked label={t("account.status")} hint={<span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{status(account)}</span>}>
          {() => <Reconnect account={account} />}
        </SettingsRow>
        <CaptureRecovery key={`capture:${account.id}`} accountId={account.id} />
        {account.kind === "imap" && <><SentCopies key={`copy:${account.id}`} accountId={account.id} /><RecipientReceipts key={`recipients:${account.id}`} accountId={account.id} /></>}
        <SettingsRow find="account.remove" label={t("account.remove")} hint={isOwner ? t("account.remove.hintOwner") : t("account.remove.hint")}>
          {({ id: _id, "aria-labelledby": _l, ...a }) => (
            <>
              <Button {...a} variant="ghost" size="sm" className={cn("text-destructive-ink", GHOST_DANGER_PRESS)} data-testid="account-remove" onClick={() => setRemoving(true)}>
                <Trash2 /> {t("account.remove.button")}
              </Button>
              <AccountRemoveDialog account={account} open={removing} onOpenChange={setRemoving} from="settings" />
            </>
          )}
        </SettingsRow>
      </AccountPart>
    </div>
  );
}

/**
 * Plan 294: a part of an account's settings (name and signature, mailbox, AI, connection) under a small title, its
 * rows split by hairlines as before; the account's name above is the h4. Its region is named by both ("Mailbox
 * Personal"), so two accounts open never give a screen reader two "Mailbox" landmarks (Codex code review #3).
 */
function AccountPart({ title, nameId, testId, children }: { title: string; nameId: string; testId: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id} ${nameId}`} data-testid={testId}>
      <h5 id={id} className="pt-3.5 pb-0.5 text-xs font-semibold text-muted-foreground">
        {title}
      </h5>
      <div className="hairline-divide">{children}</div>
    </section>
  );
}

/** the account's row in Settings: where focus goes once its sign-in panel is gone */
const settingsRow = (accountId: number) => document.querySelector<HTMLElement>(`[data-testid="settings-account"][data-account-id="${accountId}"] [data-testid="account-toggle"]`);

/**
 * Plan 184: a collapsed account that needs a sign-in has its way to sign in on the row, under its text (the same
 * panel as the sidebar's key), so nothing has to be opened first. An open section shows it among its rows instead.
 */
function RowSignIn({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex pb-2.5 pl-5 group-data-open/account:hidden" data-sign-in-ui>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) clearAttemptError(account.id);
        }}
      >
        <PopoverTrigger
          onFocus={() => {
            if (needsGoogleScript(account)) prepareGoogle();
          }}
          render={<Button type="button" variant="outline" size="sm" aria-label={t("account.signInAgainFor", { email: account.email })} data-testid="account-row-sign-in" />}
        >
          <KeyRound /> {t("account.signInAgain")}
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="max-h-(--available-height) w-80 max-w-(--available-width) gap-3 overflow-y-auto"
          data-testid="sign-in-popover"
          data-sign-in-ui
        >
          <SignInPanel accounts={[account]} home={settingsRow} onLater={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One account in the list: its row opens its settings in place (an accordion section, several may be open). */
function AccountItem({ account, generalWindow, isOwner }: { account: Account; generalWindow: number; isOwner: boolean }) {
  // a sign-in to redo reads calmly (plan 25); a real error or an outage in the error ink
  const attention = !needsSignIn(account) && (account.syncState.status === "error" || account.syncState.status === "offline");
  const nameId = useId();
  return (
    <AccordionItem value={account.id} className="group/account" data-testid="settings-account" data-account-id={account.id} data-setting-scope={`account:${account.id}`}>
      <AccordionTrigger level={4} className="-mx-2 w-[calc(100%+1rem)] rounded-md px-2 py-2.5 [contain:inline-size]" data-testid="account-toggle" data-setting-open>
        <AccountMark color={account.color} />
        <span className="min-w-0 flex-1">
          <span id={nameId} className="block truncate text-sm font-medium">
            {account.displayName}
          </span>
          <span className={cn("block truncate text-xs", attention ? "text-destructive-ink" : "text-muted-foreground")}>
            {account.email} · {serviceLabel(account.kind)} · {status(account)}
          </span>
        </span>
      </AccordionTrigger>
      {needsSignIn(account) && <RowSignIn account={account} />}
      <AccordionPanel>
        <AccountEditor account={account} generalWindow={generalWindow} isOwner={isOwner} nameId={nameId} />
      </AccordionPanel>
    </AccordionItem>
  );
}

export function AccountsTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const accounts = useApp((s) => s.accounts);
  const owner = useApp((s) => s.owner);
  const demo = useApp((s) => s.demo);
  const [reopen] = useState(reopenedRows);
  return (
    <div data-testid="accounts-tab">
      <SettingsGroup title={t("account.list")} testId="accounts-group">
        {/* plan 106: Settings opened on an account (the sidebar's Account Settings…) opens it; later events leave it be.
            Plan 246: come back to, the ones open when Settings was left */}
        <Accordion multiple defaultValue={accounts.filter((a) => a.id === getApp().settingsAccount || reopen.has(`account:${a.id}`)).map((a) => a.id)} className="hairline-divide">
          {accounts.map((a) => (
            <AccountItem key={a.id} account={a} generalWindow={settings.syncWindowDays} isOwner={owner?.accountId === a.id} />
          ))}
        </Accordion>
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2" data-testid="settings-add-account" {...findAttrs("accounts.add")} onClick={() => setApp({ dialog: "addAccount" })}>
            <Plus /> {t("account.add")}
          </Button>
        </div>
      </SettingsGroup>
      {/* plan 294: what holds for every account, under them (the default sync window was General's; the counts row,
          plan 207's, was first) */}
      <SettingsGroup title={t("account.all")} testId="accounts-all-group">
        <SettingsRow find="accounts.syncWindow" labelFor label={t("account.defaultSyncWindow")} hint={t("settings.general.syncWindow.hint")}>
          {(a) => <DaysField a11y={a} testId="sync-window" value={settings.syncWindowDays} onSave={(days) => update({ syncWindowDays: days ?? settings.syncWindowDays }, { quiet: true })} />}
        </SettingsRow>
        <SettingsRow find="accounts.counts" label={t("account.counts")} hint={t("account.counts.hint")} testId="account-counts-row">
          {(a) => <Switch {...a} data-testid="account-counts" checked={settings.accountCounts} onCheckedChange={(on) => void update({ accountCounts: on })} />}
        </SettingsRow>
      </SettingsGroup>
      <OwnerCard owner={owner} demo={demo} accounts={accounts} />
    </div>
  );
}

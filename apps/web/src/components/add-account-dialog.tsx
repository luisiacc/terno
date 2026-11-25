import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { Input } from "@terno/ui/components/input";
import { Label } from "@terno/ui/components/label";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Google, Microsoft } from "@terno/ui/icons";
import { unhandled, type SignInMethod } from "@terno/core";
import { t } from "@terno/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { DesktopOnly } from "~/lib/web-parts";
import { attemptError, type Attempt } from "~/lib/sign-in";
import { windowChoices, windowLabel } from "~/lib/settings-values";

const WEB = import.meta.env.VITE_TARGET === "web";

/** a port fits five digits: it never shrinks beside its host, and has no spinner to cover them */
/** a port: five digits beside the host, no steppers (nobody steps to a port); the arrow keys still do */
const PORT = { className: "w-16 shrink-0", inputClassName: "px-1.5 text-center", steppers: false, min: 1, max: 65535, format: { useGrouping: false } } as const;

/**
 * Known IMAP/SMTP settings so most people only type email + password. Outlook.com's addresses have none (plan 259):
 * its IMAP no longer takes a password, so the form points them to Continue with Microsoft instead.
 */
const PRESETS: Record<string, { imap: string; smtp: string; smtpPort: number }> = {
  "icloud.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587 },
  "me.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587 },
  "fastmail.com": { imap: "imap.fastmail.com", smtp: "smtp.fastmail.com", smtpPort: 465 },
  "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", smtpPort: 465 },
  "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com", smtpPort: 465 },
  "proton.me": { imap: "127.0.0.1", smtp: "127.0.0.1", smtpPort: 1025 },
};

/**
 * Outlook.com's own domains and their best-known country versions, listed (a pattern like `live.xx` would claim
 * unrelated domains such as live.fm, Codex review of plan 259 stage 3 #5). One missing only loses the hint.
 */
const MICROSOFT_DOMAINS = new Set([
  "outlook.com", "outlook.es", "outlook.fr", "outlook.de", "outlook.it", "outlook.jp", "outlook.com.ar", "outlook.com.au", "outlook.com.br",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "hotmail.com.ar", "hotmail.com.br",
  "live.com", "live.co.uk", "live.fr", "live.de", "live.it", "live.nl", "live.ca", "live.com.mx", "live.com.ar", "live.com.au",
  "msn.com", "windowslive.com",
]);

/** plan 259: an address that connects with Microsoft, not IMAP: its domain, else null */
export function microsoftDomain(email: string): string | null {
  const domain = email.trim().split("@")[1]?.toLowerCase() ?? "";
  return MICROSOFT_DOMAINS.has(domain) ? domain : null;
}

/** the ways in that sign in in the browser: Google, and on the desktop Microsoft (plan 259: the web's waits for its stage 4) */
type BrowserMethod = Exclude<SignInMethod, "password">;
const BROWSER_METHODS: readonly BrowserMethod[] = WEB ? ["google"] : ["google", "microsoft"];

function browserButton(method: BrowserMethod) {
  switch (method) {
  case "google": return { icon: <Google />, label: t("account.continueGoogle"), testId: "connect-gmail" };
  case "microsoft": return { icon: <Microsoft />, label: t("account.continueMicrosoft"), testId: "connect-microsoft" };
  default: return unhandled(method);
  }
}

/** What the add-account form holds: kept by its host, so the first-run setup keeps it across Back (memory only, never stored). */
export interface AccountDraft {
  /** null: not chosen yet, the General setting (read when the host has it) */
  picked: number | null;
  form: { email: string; name: string; password: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; user: string };
}

export const EMPTY_ACCOUNT_DRAFT: AccountDraft = { picked: null, form: { email: "", name: "", password: "", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465, user: "" } };

export function AddAccountDialog() {
  const open = useApp((s) => s.dialog === "addAccount");
  const [draft, setDraft] = useState(EMPTY_ACCOUNT_DRAFT);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent movable="add-account" className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" data-testid="add-account-dialog">
        <DialogHeader>
          <DialogTitle>{t("account.addTitle")}</DialogTitle>
          <DialogDescription>{t("account.addDescription")}</DialogDescription>
        </DialogHeader>
        <AddAccountForm draft={draft} onDraft={setDraft} onDone={() => setApp({ dialog: null })} />
      </DialogContent>
    </Dialog>
  );
}

interface FormProps {
  draft: AccountDraft;
  onDraft: (update: (d: AccountDraft) => AccountDraft) => void;
  /** connected: the host closes */
  onDone: () => void;
  /** a connection is in flight (the setup holds Back and Skip meanwhile) */
  onBusy?: (busy: boolean) => void;
}

/** The sync window, Google and Microsoft, then IMAP: the add-account dialog's body, and the first-run setup's last step (plan 98). */
export function AddAccountForm({ draft, onDraft, onDone, onBusy }: FormProps) {
  const imapHere = useApp((s) => s.host?.capabilities.imap ?? true);
  const generalWindow = useApp((s) => s.settings?.syncWindowDays ?? 180);
  const syncWindowDays = draft.picked ?? generalWindow;
  const form = draft.form;
  // one connection at a time, whichever way; its progress and failure show where it was started (Microsoft also from the
  // IMAP form's hint, Codex review of plan 259 stage 3 #3)
  const [busy, setBusyState] = useState<SignInMethod | null>(null);
  const [from, setFrom] = useState<"buttons" | "hint">("buttons");
  const [error, setError] = useState<{ method: SignInMethod; text: NonNullable<Attempt["error"]> } | null>(null);
  const hintId = useId();
  // a sign-in finishing after its form went (the dialog closed, another opened) says it connected and closes nothing
  // (Codex review of plan 259 stage 3 #1)
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = (patch: Partial<AccountDraft["form"]>) => onDraft((d) => ({ ...d, form: { ...d.form, ...patch } }));
  const setPicked = (picked: number) => onDraft((d) => ({ ...d, picked }));
  const setBusy = (b: SignInMethod | null) => {
    setBusyState(b);
    onBusy?.(b !== null);
  };

  const onEmail = (email: string) => {
    const preset = PRESETS[email.split("@")[1]?.toLowerCase() ?? ""];
    const domain = email.split("@")[1] ?? "";
    set({ email, user: email, imapHost: preset?.imap ?? (domain ? `imap.${domain}` : ""), smtpHost: preset?.smtp ?? (domain ? `smtp.${domain}` : ""), smtpPort: preset?.smtpPort ?? 465 });
  };

  // the web signs in with Google's popup, which needs the click's activation: have the script ready before it
  useEffect(() => {
    if (WEB) void import("~/web/google").then((g) => g.preloadGoogle()).catch(() => {});
  }, []);

  const connect = async (method: BrowserMethod) => {
    switch (method) {
    case "google": return WEB ? (await import("~/web/google")).connectGmailWeb(undefined, undefined, { syncWindowDays }) : client.call("accounts.connectGmail", { syncWindowDays });
    case "microsoft": return client.call("accounts.connectMicrosoft", { syncWindowDays });
    default: return unhandled(method);
    }
  };

  const connectWith = async (method: BrowserMethod, place: "buttons" | "hint" = "buttons") => {
    setBusy(method);
    setFrom(place);
    setError(null);
    try {
      const a = await connect(method);
      snack.success(t("account.connected", { email: a.email }));
      if (alive.current) onDone();
    } catch (error) {
      if (alive.current) setError({ method, text: attemptError(error)! });
    } finally {
      if (alive.current) setBusy(null);
      else onBusy?.(false);
    }
  };

  // plan 259: an Outlook.com address typed here connects with Microsoft (where this build has it)
  const outlook = BROWSER_METHODS.includes("microsoft") ? microsoftDomain(form.email) : null;

  const addImap = async () => {
    setBusy("password");
    setError(null);
    try {
      const a = await client.call("accounts.addImap", {
        email: form.email.trim(),
        displayName: form.name.trim() || form.email.trim(),
        password: form.password,
        imap: { host: form.imapHost.trim(), port: form.imapPort, secure: form.imapPort === 993, user: form.user.trim() },
        smtp: { host: form.smtpHost.trim(), port: form.smtpPort, secure: form.smtpPort === 465, user: form.user.trim() },
        syncWindowDays,
      });
      snack.success(t("account.connectedSyncing", { email: a.email }));
      if (alive.current) onDone();
    } catch (error) {
      if (alive.current) setError({ method: "password", text: attemptError(error)! });
    } finally {
      if (alive.current) setBusy(null);
      else onBusy?.(false);
    }
  };

  const failure = error && (
    <div role="alert" className="text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="add-account-error">
      <p className="text-destructive-ink">{error.text.message}</p>
      {error.text.detail && <p className="text-muted-foreground">{error.text.detail}</p>}
    </div>
  );

  return (
    <>
      {/* asked once, for whichever way the account connects */}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="acc-window">{t("account.window.label")}</Label>
        <Select value={String(syncWindowDays)} onValueChange={(v) => setPicked(Number(v))} items={windowChoices(generalWindow).map((d) => ({ value: String(d), label: windowLabel(d) }))} disabled={busy !== null}>
          <SelectTrigger id="acc-window" size="sm" className="min-w-40" data-testid="sync-window-choice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {windowChoices(generalWindow).map((d) => (
              <SelectItem key={d} value={String(d)} data-testid={`sync-window-${d}`}>
                {windowLabel(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* stacked: side by side, "Continue with Microsoft" overflows the first-run's column and longer translations */}
      <div className="flex flex-col gap-2">
        {BROWSER_METHODS.map((method) => {
          const b = browserButton(method);
          return (
            <Button key={method} variant="outline" className="h-10 justify-center gap-2" onClick={() => void connectWith(method)} focusableWhenDisabled disabled={busy !== null} loading={busy === method && from === "buttons"} data-testid={b.testId}>
              {b.icon} {b.label}
            </Button>
          );
        })}
      </div>
      {error && error.method !== "password" && from === "buttons" && failure}
      {!imapHere && DesktopOnly ? (
        <DesktopOnly feature="imap" />
      ) : (
        <>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> {t("account.orImap")} <span className="h-px flex-1 bg-border" />
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy === null) void addImap();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label htmlFor="acc-email">{t("account.email")}</Label>
              <Input id="acc-email" data-testid="imap-email" type="email" required value={form.email} onChange={(e) => onEmail(e.target.value)} placeholder={t("account.email.placeholder")} aria-describedby={outlook ? hintId : undefined} />
              {outlook && (
                <p id={hintId} className="text-xs leading-relaxed text-muted-foreground" data-testid="imap-microsoft-hint">
                  {t("account.imapMicrosoft", { domain: outlook })}{" "}
                  <Button variant="link" className="text-xs" focusableWhenDisabled disabled={busy !== null} loading={busy === "microsoft" && from === "hint"} onClick={() => void connectWith("microsoft", "hint")} data-testid="imap-microsoft-connect">
                    {t("account.continueMicrosoft")}
                  </Button>
                </p>
              )}
              {outlook && error?.method === "microsoft" && from === "hint" && failure}
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-name">{t("account.yourName")}</Label>
              <Input id="acc-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-pass">{t("account.appPassword")}</Label>
              <Input id="acc-pass" data-testid="imap-password" type="password" required value={form.password} onChange={(e) => set({ password: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="acc-imap">{t("account.imapServer")}</Label>
              <div className="flex gap-1.5">
                <Input id="acc-imap" data-testid="imap-host" required value={form.imapHost} onChange={(e) => set({ imapHost: e.target.value })} />
                <NumberField aria-label={t("account.imapPort")} {...PORT} value={form.imapPort} onValueChange={(port) => set({ imapPort: port ?? 0 })} />
              </div>
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="acc-smtp">{t("account.smtpServer")}</Label>
              <div className="flex gap-1.5">
                <Input id="acc-smtp" data-testid="smtp-host" required value={form.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} />
                <NumberField aria-label={t("account.smtpPort")} {...PORT} value={form.smtpPort} onValueChange={(port) => set({ smtpPort: port ?? 0 })} />
              </div>
            </div>
          </div>
          <Button type="submit" className="w-full" focusableWhenDisabled disabled={busy !== null} loading={busy === "password"} data-testid="imap-submit">
            {t("account.connectAccount")}
          </Button>
          {error?.method === "password" && failure}
        </form>
        </>
      )}
    </>
  );
}

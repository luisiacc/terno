import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { Input } from "@terno/ui/components/input";
import { Label } from "@terno/ui/components/label";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Mail } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { Suspense, useEffect, useState } from "react";
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

/** Known IMAP/SMTP settings so most people only type email + password. */
const PRESETS: Record<string, { imap: string; smtp: string; smtpPort: number }> = {
  "icloud.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587 },
  "me.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587 },
  "fastmail.com": { imap: "imap.fastmail.com", smtp: "smtp.fastmail.com", smtpPort: 465 },
  "outlook.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com", smtpPort: 587 },
  "hotmail.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com", smtpPort: 587 },
  "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", smtpPort: 465 },
  "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com", smtpPort: 465 },
  "proton.me": { imap: "127.0.0.1", smtp: "127.0.0.1", smtpPort: 1025 },
};

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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" data-testid="add-account-dialog">
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

/** The sync window, Google, then IMAP: the add-account dialog's body, and the first-run setup's last step (plan 98). */
export function AddAccountForm({ draft, onDraft, onDone, onBusy }: FormProps) {
  const imapHere = useApp((s) => s.host?.capabilities.imap ?? true);
  const generalWindow = useApp((s) => s.settings?.syncWindowDays ?? 180);
  const syncWindowDays = draft.picked ?? generalWindow;
  const form = draft.form;
  const [busy, setBusyState] = useState<"gmail" | "imap" | null>(null);
  const [error, setError] = useState<{ kind: "gmail" | "imap"; text: NonNullable<Attempt["error"]> } | null>(null);
  const set = (patch: Partial<AccountDraft["form"]>) => onDraft((d) => ({ ...d, form: { ...d.form, ...patch } }));
  const setPicked = (picked: number) => onDraft((d) => ({ ...d, picked }));
  const setBusy = (b: "gmail" | "imap" | null) => {
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

  const connectGmail = async () => {
    setBusy("gmail");
    setError(null);
    try {
      const a = WEB ? await (await import("~/web/google")).connectGmailWeb(undefined, undefined, { syncWindowDays }) : await client.call("accounts.connectGmail", { syncWindowDays });
      // plan 22: photos from Google came on with the account
      if (!WEB) void client.call("app.bootstrap", {}).then((b) => setApp({ settings: b.settings }), () => {});
      snack.success(t("account.connected", { email: a.email }));
      onDone();
    } catch (error) {
      setError({ kind: "gmail", text: attemptError(error)! });
    } finally {
      setBusy(null);
    }
  };

  const addImap = async () => {
    setBusy("imap");
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
      onDone();
    } catch (error) {
      setError({ kind: "imap", text: attemptError(error)! });
    } finally {
      setBusy(null);
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
      <Button variant="outline" className="h-10 justify-center gap-2" onClick={connectGmail} focusableWhenDisabled disabled={busy !== null} loading={busy === "gmail"} data-testid="connect-gmail">
        <Mail /> {t("account.continueGoogle")}
      </Button>
      {error?.kind === "gmail" && failure}
      {!imapHere && DesktopOnly ? (
        <Suspense>
          <DesktopOnly feature="imap" />
        </Suspense>
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
              <Input id="acc-email" data-testid="imap-email" type="email" required value={form.email} onChange={(e) => onEmail(e.target.value)} placeholder={t("account.email.placeholder")} />
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
          <Button type="submit" className="w-full" focusableWhenDisabled disabled={busy !== null} loading={busy === "imap"} data-testid="imap-submit">
            {t("account.connectAccount")}
          </Button>
          {error?.kind === "imap" && failure}
        </form>
        </>
      )}
    </>
  );
}

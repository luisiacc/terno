import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { Input } from "@terno/ui/components/input";
import { Label } from "@terno/ui/components/label";
import { Loader2, Mail } from "lucide-react";
import { t } from "@terno/i18n";
import { Suspense, useEffect, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { DesktopOnly } from "~/lib/web-parts";

const WEB = import.meta.env.VITE_TARGET === "web";

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

export function AddAccountDialog() {
  const open = useApp((s) => s.dialog === "addAccount");
  const firstOwner = useApp((s) => !s.owner && !s.demo);
  const imapHere = useApp((s) => s.host?.capabilities.imap ?? true);
  const [form, setForm] = useState({ email: "", name: "", password: "", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465, user: "" });
  const [busy, setBusy] = useState<"gmail" | "imap" | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const onEmail = (email: string) => {
    const preset = PRESETS[email.split("@")[1]?.toLowerCase() ?? ""];
    const domain = email.split("@")[1] ?? "";
    set({ email, user: email, imapHost: preset?.imap ?? (domain ? `imap.${domain}` : ""), smtpHost: preset?.smtp ?? (domain ? `smtp.${domain}` : ""), smtpPort: preset?.smtpPort ?? 465 });
  };

  // the web signs in with Google's popup, which needs the click's activation: have the script ready before it
  useEffect(() => {
    if (WEB && open) void import("~/web/google").then((g) => g.preloadGoogle()).catch(() => {});
  }, [open]);

  const connectGmail = async () => {
    setBusy("gmail");
    try {
      const a = WEB ? await (await import("~/web/google")).connectGmailWeb() : await client.call("accounts.connectGmail", {});
      // plan 22: photos from Google came on with the account
      if (!WEB) void client.call("app.bootstrap", {}).then((b) => setApp({ settings: b.settings }), () => {});
      snack.success(t("account.connected", { email: a.email }));
      setApp({ dialog: null });
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
      // no client ID yet: Settings → Accounts is where it goes
      if ((error as { i18n?: { key?: string } } | null)?.i18n?.key === "errors.gmailClientIdMissing") setApp({ dialog: "settings", settingsTab: "accounts" });
    } finally {
      setBusy(null);
    }
  };

  const addImap = async () => {
    setBusy("imap");
    try {
      const a = await client.call("accounts.addImap", {
        email: form.email.trim(),
        displayName: form.name.trim() || form.email.trim(),
        password: form.password,
        imap: { host: form.imapHost.trim(), port: form.imapPort, secure: form.imapPort === 993, user: form.user.trim() },
        smtp: { host: form.smtpHost.trim(), port: form.smtpPort, secure: form.smtpPort === 465, user: form.user.trim() },
      });
      snack.success(t("account.connectedSyncing", { email: a.email }));
      setApp({ dialog: null });
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="sm:max-w-md" data-testid="add-account-dialog">
        <DialogHeader>
          <DialogTitle>{t("account.addTitle")}</DialogTitle>
          <DialogDescription>{t("account.addDescription")}</DialogDescription>
        </DialogHeader>
        {firstOwner && (
          <p className="rounded-lg border border-primary/25 bg-accent/50 px-3 py-2 text-xs text-accent-foreground" data-testid="owner-first-copy">
            {t("account.ownerFirst")}
          </p>
        )}
        <Button variant="outline" className="h-10 justify-center gap-2" onClick={connectGmail} disabled={busy !== null} data-testid="connect-gmail">
          {busy === "gmail" ? <Loader2 className="animate-spin" /> : <Mail />} {t("account.continueGoogle")}
        </Button>
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
              void addImap();
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
              <div className="space-y-1">
                <Label htmlFor="acc-imap">{t("account.imapServer")}</Label>
                <div className="flex gap-1.5">
                  <Input id="acc-imap" data-testid="imap-host" required value={form.imapHost} onChange={(e) => set({ imapHost: e.target.value })} />
                  <Input aria-label={t("account.imapPort")} className="w-16" type="number" value={form.imapPort} onChange={(e) => set({ imapPort: Number(e.target.value) })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="acc-smtp">{t("account.smtpServer")}</Label>
                <div className="flex gap-1.5">
                  <Input id="acc-smtp" data-testid="smtp-host" required value={form.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} />
                  <Input aria-label={t("account.smtpPort")} className="w-16" type="number" value={form.smtpPort} onChange={(e) => set({ smtpPort: Number(e.target.value) })} />
                </div>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={busy !== null} data-testid="imap-submit">
              {busy === "imap" && <Loader2 className="animate-spin" />} {t("account.connectAccount")}
            </Button>
          </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { Button } from "@unica/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@unica/ui/components/dialog";
import { Input } from "@unica/ui/components/input";
import { Label } from "@unica/ui/components/label";
import { Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";

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
  const [form, setForm] = useState({ email: "", name: "", password: "", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465, user: "" });
  const [busy, setBusy] = useState<"gmail" | "imap" | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const onEmail = (email: string) => {
    const preset = PRESETS[email.split("@")[1]?.toLowerCase() ?? ""];
    const domain = email.split("@")[1] ?? "";
    set({ email, user: email, imapHost: preset?.imap ?? (domain ? `imap.${domain}` : ""), smtpHost: preset?.smtp ?? (domain ? `smtp.${domain}` : ""), smtpPort: preset?.smtpPort ?? 465 });
  };

  const connectGmail = async () => {
    setBusy("gmail");
    try {
      const a = await client.call("accounts.connectGmail", {});
      toast.success(`${a.email} conectada`);
      setApp({ dialog: null });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      if (String(error).includes("client ID")) setApp({ dialog: "settings", settingsTab: "accounts" });
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
      toast.success(`${a.email} conectada. Sincronizando…`);
      setApp({ dialog: null });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="sm:max-w-md" data-testid="add-account-dialog">
        <DialogHeader>
          <DialogTitle>Añadir cuenta</DialogTitle>
          <DialogDescription>Conecta todas las cuentas que quieras. Todo se guarda localmente.</DialogDescription>
        </DialogHeader>
        {firstOwner && (
          <p className="rounded-lg border border-primary/25 bg-accent/50 px-3 py-2 text-xs text-accent-foreground" data-testid="owner-first-copy">
            El primer correo que conectes será tu cuenta Única: con él iniciarás sesión y te facturaremos.
          </p>
        )}
        <Button variant="outline" className="h-10 justify-center gap-2" onClick={connectGmail} disabled={busy !== null} data-testid="connect-gmail">
          {busy === "gmail" ? <Loader2 className="animate-spin" /> : <Mail />} Continuar con Google
        </Button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> o con IMAP/SMTP <span className="h-px flex-1 bg-border" />
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
              <Label htmlFor="acc-email">Correo</Label>
              <Input id="acc-email" data-testid="imap-email" type="email" required value={form.email} onChange={(e) => onEmail(e.target.value)} placeholder="tu@dominio.com" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-name">Tu nombre</Label>
              <Input id="acc-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-pass">Contraseña de app</Label>
              <Input id="acc-pass" data-testid="imap-password" type="password" required value={form.password} onChange={(e) => set({ password: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-imap">Servidor IMAP</Label>
              <div className="flex gap-1.5">
                <Input id="acc-imap" data-testid="imap-host" required value={form.imapHost} onChange={(e) => set({ imapHost: e.target.value })} />
                <Input aria-label="Puerto IMAP" className="w-16" type="number" value={form.imapPort} onChange={(e) => set({ imapPort: Number(e.target.value) })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="acc-smtp">Servidor SMTP</Label>
              <div className="flex gap-1.5">
                <Input id="acc-smtp" data-testid="smtp-host" required value={form.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} />
                <Input aria-label="Puerto SMTP" className="w-16" type="number" value={form.smtpPort} onChange={(e) => set({ smtpPort: Number(e.target.value) })} />
              </div>
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={busy !== null} data-testid="imap-submit">
            {busy === "imap" && <Loader2 className="animate-spin" />} Conectar cuenta
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

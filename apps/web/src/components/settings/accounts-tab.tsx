import type { Account, AccountPatch, CategoryColor } from "@unica/core";
import type { AppSettings } from "@unica/core/rpc";
import { Button } from "@unica/ui/components/button";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Input } from "@unica/ui/components/input";
import { cn } from "@unica/ui/lib/utils";
import { ChevronRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { DaysField } from "./general-tab";
import { OwnerCard } from "./owner-card";
import { ColorPicker, CommitInput, ConfirmDialog, SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const WEB = import.meta.env.VITE_TARGET === "web";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function status(a: Account): string {
  if (a.syncState.status === "error") return `Error: ${a.syncState.lastError ?? "desconocido"}`;
  if (a.syncState.status === "offline") return a.syncState.lastError ? `Sin conexión: ${a.syncState.lastError}` : "Sin conexión";
  if (a.syncState.status === "syncing") return "Sincronizando…";
  return "Al día";
}

async function updateAccount(id: number, patch: AccountPatch): Promise<void> {
  const next = await client.call("accounts.update", { id, ...patch });
  setApp((s) => ({ accounts: s.accounts.map((a) => (a.id === next.id ? next : a)) }));
}

/** Gmail signs in again with Google (in the browser, Google's own window); IMAP with the password, checked by a live login. */
function Reconnect({ account }: { account: Account }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const passwordId = useId();
  const run = async () => {
    setBusy(true);
    try {
      if (account.kind === "gmail" && WEB) {
        const { connectGmailWeb } = await import("~/web/google");
        await connectGmailWeb(account.email);
      } else {
        await client.call("accounts.reconnect", { id: account.id, password: account.kind === "imap" ? password : undefined });
      }
      toast.success(`${account.email} vuelve a estar conectada`);
      setAsking(false);
      setPassword("");
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (account.kind === "imap" && asking) {
    return (
      <form
        className="flex w-full items-center gap-2"
        data-testid="account-reconnect-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void run();
        }}
      >
        <label htmlFor={passwordId} className="sr-only">
          Contraseña de {account.email}
        </label>
        <Input id={passwordId} type="password" autoComplete="off" autoFocus required disabled={busy} className="h-7 flex-1 bg-background dark:bg-input/30" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="account-reconnect-password" />
        <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" disabled={busy || !password} data-testid="account-reconnect-submit">
          {busy && <Loader2 className="animate-spin" />} Verificar y guardar
        </Button>
      </form>
    );
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} data-testid="account-reconnect" onClick={() => (account.kind === "imap" ? setAsking(true) : void run())}>
      {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} {account.kind === "gmail" ? "Conectar con Google" : "Cambiar contraseña…"}
    </Button>
  );
}

function AccountEditor({ account, generalWindow, isOwner }: { account: Account; generalWindow: number; isOwner: boolean }) {
  const [removing, setRemoving] = useState(false);
  const save = (patch: AccountPatch) => updateAccount(account.id, patch);
  return (
    <div className="hairline-divide pb-1 pl-5" data-testid="account-editor">
      <SettingsRow labelFor label="Nombre" hint="Cómo aparece en la barra lateral y en las listas.">
        {(a) => <CommitInput key={account.displayName} a11y={a} className="w-56" data-testid="account-name" value={account.displayName} validate={(v) => (v.trim() ? null : "Escribe un nombre.")} onCommit={(v) => save({ displayName: v.trim() })} />}
      </SettingsRow>
      <SettingsRow labelFor label="Nombre del remitente" hint="El nombre que ven quienes reciben tus correos.">
        {(a) => <CommitInput key={account.senderName} a11y={a} className="w-56" data-testid="account-sender" value={account.senderName} onCommit={(v) => save({ senderName: v.trim() })} />}
      </SettingsRow>
      <SettingsRow label="Color">
        {(a) => <ColorPicker a11y={a} name={`account-color-${account.id}`} testId="account-color" value={account.color} onChange={(color) => void save({ color }).catch((e) => toast.error(errorText(e)))} />}
      </SettingsRow>
      <SettingsRow stacked labelFor label="Firma" hint="Se añade debajo de lo que escribes al enviar desde esta cuenta, tras una línea «-- ».">
        {(a) => <CommitInput key={account.signature} multiline a11y={a} data-testid="account-signature" value={account.signature} placeholder="Luis Cordero · Acme Studio" maxLength={10_000} onCommit={(v) => save({ signature: v })} />}
      </SettingsRow>
      <SettingsRow labelFor label="Ventana de sincronización" hint={`Días de correo que descarga la primera vez. Vacío: los de General (${generalWindow}).`}>
        {(a) => (
          <DaysField
            key={account.syncWindowDays ?? "general"}
            a11y={a}
            testId="account-window"
            value={account.syncWindowDays}
            placeholder={String(generalWindow)}
            allowEmpty
            onSave={(days) => save({ syncWindowDays: days })}
          />
        )}
      </SettingsRow>
      <SettingsRow label="Conexión" hint={status(account)}>
        {() => <Reconnect account={account} />}
      </SettingsRow>
      <SettingsRow label="Quitar la cuenta" hint={isOwner ? "Seguirá siendo tu cuenta Única; cámbiala arriba." : "Borra sus correos de este equipo; en el servidor no cambia nada."}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <>
            <Button {...a} variant="ghost" size="sm" className="text-destructive" data-testid="account-remove" onClick={() => setRemoving(true)}>
              <Trash2 /> Quitar…
            </Button>
            <ConfirmDialog
              open={removing}
              onOpenChange={setRemoving}
              testId="account-remove-dialog"
              title={`¿Quitar ${account.email}?`}
              description={`Se borran de este equipo sus correos, borradores y acciones pendientes. En el servidor no cambia nada: puedes volver a añadirla.${isOwner ? " Seguirá siendo tu cuenta Única." : ""}`}
              confirm="Quitar cuenta"
              onConfirm={async () => {
                try {
                  await client.call("accounts.remove", { id: account.id });
                  toast.success("Cuenta quitada");
                } catch (e) {
                  toast.error(errorText(e));
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
  const attention = account.syncState.status === "error" || account.syncState.status === "offline";
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
          <span className={cn("block truncate text-xs", attention ? "text-destructive" : "text-muted-foreground")}>
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
      setApp((s) => (s.settings ? { settings: { ...s.settings, gmailClientSecretSet: value !== "" } } : {}));
      setSecret("");
      toast.success(value ? "Client secret guardado" : "Client secret quitado");
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <SettingsGroup
      title="Google (Gmail)"
      footer={
        WEB
          ? `Crea un cliente OAuth de tipo «Aplicación web» en Google Cloud con la API de Gmail habilitada y ${location.origin} como origen de JavaScript autorizado.`
          : "Crea un cliente OAuth de tipo «App de escritorio» en Google Cloud con la API de Gmail habilitada."
      }
    >
      <SettingsRow stacked labelFor label="Google OAuth Client ID">
        {(a) => <CommitInput key={settings.gmailClientId} a11y={a} data-testid="gmail-client-id" value={settings.gmailClientId} placeholder="xxxxx.apps.googleusercontent.com" onCommit={(v) => update({ gmailClientId: v.trim() }, { quiet: true })} />}
      </SettingsRow>
      {!WEB && (
        <SettingsRow stacked labelFor label="Client secret (opcional)" hint="Se cifra con el llavero de macOS; nunca se muestra.">
          {(a) =>
            settings.gmailClientSecretSet ? (
              <div className="flex items-center gap-2 text-sm" data-testid="gmail-secret-saved">
                <span className="text-success">Guardado</span>
                <Button variant="ghost" size="xs" onClick={() => void saveSecret("")}>
                  Quitar
                </Button>
              </div>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (secret.trim()) void saveSecret(secret.trim());
                }}
              >
                <Input {...a} type="password" autoComplete="off" className="h-7 bg-background dark:bg-input/30" data-testid="gmail-secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
                <Button type="submit" size="sm" disabled={!secret.trim()}>
                  Guardar
                </Button>
              </form>
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
      <SettingsGroup title="Cuentas de correo" testId="accounts-group">
        {accounts.map((a) => (
          <AccountItem key={a.id} account={a} generalWindow={settings.syncWindowDays} isOwner={owner?.accountId === a.id} />
        ))}
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2 text-primary" data-testid="settings-add-account" onClick={() => setApp({ dialog: "addAccount" })}>
            <Plus /> Añadir cuenta…
          </Button>
        </div>
      </SettingsGroup>
      <GoogleClient settings={settings} update={update} />
    </div>
  );
}

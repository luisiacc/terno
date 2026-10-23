import type { CategoryColor } from "@unica/core";
import type { AppSettings, SettingsPatch } from "@unica/core/rpc";
import { Button } from "@unica/ui/components/button";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Dialog, DialogContent, DialogTitle } from "@unica/ui/components/dialog";
import { Input } from "@unica/ui/components/input";
import { Label } from "@unica/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { Switch } from "@unica/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unica/ui/components/tabs";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@unica/ui/components/alert-dialog";
import { Check, Copy, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { updateAppearance } from "~/lib/appearance";
import { client } from "~/rpc/connection";
import { setApp, useApp, type SettingsTab } from "~/state/app";
import { AiTab } from "./settings/ai-tab";
import { CategoriesTab } from "./settings/categories-tab";
import { OwnerCard } from "./settings/owner-card";

function Row({ label, hint, children, testId, labelId, hintId }: { label: string; hint?: string; children: React.ReactNode; testId?: string; labelId?: string; hintId?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border py-3 last:border-0" data-testid={testId}>
      <div>
        <p id={labelId} className="text-sm font-medium">
          {label}
        </p>
        {hint && (
          <p id={hintId} className="mt-0.5 text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function CopyBlock({ text, testId }: { text: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative" data-testid={testId}>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text}</pre>
      <button
        type="button"
        aria-label="Copiar"
        className="absolute top-2 right-2 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export function SettingsDialog() {
  const open = useApp((s) => s.dialog === "settings");
  const tab = useApp((s) => s.settingsTab);
  const settings = useApp((s) => s.settings);
  const accounts = useApp((s) => s.accounts);
  const owner = useApp((s) => s.owner);
  const demo = useApp((s) => s.demo);
  const [confirmLocalOff, setConfirmLocalOff] = useState(false);
  const [agent, setAgent] = useState<{ mcpCommand: string; socketPath: string; skillPath: string } | null>(null);

  useEffect(() => {
    if (open && window.unicaDesktop) void window.unicaDesktop.agentInfo().then(setAgent).catch(() => {});
  }, [open]);

  const update = useCallback(async (patch: SettingsPatch) => {
    if (patch.theme) return void (await updateAppearance(patch));
    const next = await client.call("settings.update", patch);
    setApp({ settings: next });
  }, []);
  if (!settings) return null;
  const mcp = agent?.mcpCommand ?? "/Applications/Unica.app/Contents/Resources/bin/unica-mcp";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="h-[min(640px,85vh)] max-w-[min(720px,92vw)] gap-0 overflow-hidden p-0 sm:max-w-[min(720px,92vw)]" data-testid="settings-dialog">
        <DialogTitle className="sr-only">Ajustes</DialogTitle>
        <Tabs value={tab} onValueChange={(v) => setApp({ settingsTab: v as SettingsTab })} className="flex h-full flex-col gap-0">
          <div className="border-b border-border px-5 pt-4 pb-3">
            <h2 className="mb-3 text-base font-semibold">Ajustes</h2>
            <TabsList>
              <TabsTrigger value="general" data-testid="tab-general">General</TabsTrigger>
              <TabsTrigger value="accounts" data-testid="tab-accounts">Cuentas</TabsTrigger>
              <TabsTrigger value="categories" data-testid="tab-categories">Categorías</TabsTrigger>
              <TabsTrigger value="ai" data-testid="tab-ai">IA</TabsTrigger>
              <TabsTrigger value="agents" data-testid="tab-agents">Agentes</TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
            <TabsContent value="general">
              <Row label="Modo local" hint="Nada sale de este Mac salvo el correo con tus servidores. La IA solo puede usar modelos de este Mac." testId="local-mode-row" labelId="local-mode-label" hintId="local-mode-hint">
                <Switch
                  data-testid="local-mode-switch"
                  aria-labelledby="local-mode-label"
                  aria-describedby="local-mode-hint"
                  checked={settings.localMode}
                  onCheckedChange={(on) => (on ? void update({ localMode: true }) : setConfirmLocalOff(true))}
                />
              </Row>
              <Row label="Tema">
                <Select value={settings.theme} onValueChange={(v) => update({ theme: v as AppSettings["theme"] })} items={[{ value: "system", label: "Sistema" }, { value: "light", label: "Claro" }, { value: "dark", label: "Oscuro" }]}>
                  <SelectTrigger size="sm" className="w-32" data-testid="theme-select"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">Sistema</SelectItem>
                    <SelectItem value="light">Claro</SelectItem>
                    <SelectItem value="dark">Oscuro</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Densidad" hint="Compacta muestra una línea por conversación.">
                <Select value={settings.density} onValueChange={(v) => update({ density: v as AppSettings["density"] })} items={[{ value: "comfortable", label: "Cómoda" }, { value: "compact", label: "Compacta" }]}>
                  <SelectTrigger size="sm" className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="comfortable">Cómoda</SelectItem>
                    <SelectItem value="compact">Compacta</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="Cargar imágenes remotas siempre" hint={settings.localMode ? "El modo local las bloquea siempre." : "Por defecto se bloquean para evitar rastreo."}>
                <Switch disabled={settings.localMode} checked={settings.remoteImages === "always" && !settings.localMode} onCheckedChange={(on) => update({ remoteImages: on ? "always" : "ask" })} />
              </Row>
              <Row label="Ventana de sincronización" hint="Días de correo a descargar al conectar una cuenta.">
                <Input type="number" className="h-8 w-24" defaultValue={settings.syncWindowDays} onBlur={(e) => update({ syncWindowDays: Math.max(7, Number(e.target.value) || 90) })} />
              </Row>
            </TabsContent>

            <TabsContent value="accounts">
              <div className="pt-2">
                <OwnerCard owner={owner} demo={demo} accounts={accounts} />
              </div>
              <div className="space-y-1 py-2">
                {accounts.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5" data-testid="settings-account">
                    <CategoryDot color={a.color as CategoryColor} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.email} · {a.kind === "gmail" ? "Gmail" : "IMAP/SMTP"} · {a.syncState.status === "error" ? `Error: ${a.syncState.lastError}` : a.syncState.status === "syncing" ? "Sincronizando…" : "Al día"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Quitar ${a.email}`}
                      onClick={async () => {
                        const keepsOwner = owner?.accountId === a.id ? " Seguirá siendo tu cuenta Única; cámbiala en Cambiar…." : "";
                        if (!confirm(`¿Quitar ${a.email}? Se borrarán sus correos locales.${keepsOwner}`)) return;
                        await client.call("accounts.remove", { id: a.id });
                        toast.success("Cuenta eliminada");
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" className="mt-2 w-full" onClick={() => setApp({ dialog: "addAccount" })}>
                  Añadir cuenta
                </Button>
              </div>
              <div className="mt-4 space-y-2 border-t border-border pt-4">
                <Label htmlFor="gmail-client-id">Google OAuth Client ID</Label>
                <p className="text-xs text-muted-foreground">Crea un cliente OAuth de tipo «App de escritorio» en Google Cloud con la API de Gmail habilitada.</p>
                <Input id="gmail-client-id" defaultValue={settings.gmailClientId} placeholder="xxxxx.apps.googleusercontent.com" onBlur={(e) => update({ gmailClientId: e.target.value.trim() })} />
                <Input
                  type="password"
                  placeholder="Client secret (opcional)"
                  onBlur={async (e) => {
                    if (e.target.value) await client.call("settings.setSecret", { name: "gmailClientSecret", value: e.target.value.trim() });
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="categories">
              <CategoriesTab settings={settings} />
            </TabsContent>

            <TabsContent value="ai">
              <AiTab settings={settings} update={update} />
            </TabsContent>

            <TabsContent value="agents" className="space-y-4 py-3">
              <p className="text-sm text-muted-foreground">
                Conecta <span className="font-medium text-foreground">Claude Code</span> o <span className="font-medium text-foreground">Codex</span> a todas tus cuentas mediante MCP. Única debe estar abierta.
              </p>
              <div className="space-y-1.5">
                <p className="text-xs font-medium">Claude Code</p>
                <CopyBlock testId="mcp-claude" text={`claude mcp add unica -- "${mcp}"`} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium">Codex (~/.codex/config.toml)</p>
                <CopyBlock text={`[mcp_servers.unica]\ncommand = "${mcp}"`} />
              </div>
              {agent && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Skill para Claude Code</p>
                  <CopyBlock text={`mkdir -p ~/.claude/skills/unica && cp "${agent.skillPath}" ~/.claude/skills/unica/SKILL.md`} />
                </div>
              )}
              <Row label="Permitir que los agentes envíen correos" hint="Si está desactivado, los agentes solo pueden leer, organizar y crear borradores.">
                <Switch data-testid="allow-agent-send" checked={settings.allowAgentSend} onCheckedChange={(on) => update({ allowAgentSend: on })} />
              </Row>
            </TabsContent>
          </div>
        </Tabs>
        <AlertDialog open={confirmLocalOff} onOpenChange={setConfirmLocalOff}>
          <AlertDialogContent data-testid="local-mode-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>¿Desactivar el modo local?</AlertDialogTitle>
              <AlertDialogDescription render={<div />}>
                <p>Al desactivarlo, Única podrá:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-left">
                  <li>usar IA en la nube (Claude, OpenAI y compatibles) con tu propia API key;</li>
                  <li>cargar imágenes remotas de un correo cuando lo pidas.</li>
                </ul>
                <p className="mt-2">El correo con tus servidores funciona igual en los dos modos.</p>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Mantener activado</AlertDialogCancel>
              <Button
                variant="destructive"
                data-testid="local-mode-confirm-off"
                onClick={() => {
                  setConfirmLocalOff(false);
                  void update({ localMode: false });
                }}
              >
                Desactivar
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

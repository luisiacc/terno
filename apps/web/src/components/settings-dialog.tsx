import type { CategoryColor } from "@unica/core";
import type { AppSettings } from "@unica/core/rpc";
import { Button } from "@unica/ui/components/button";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Dialog, DialogContent, DialogTitle } from "@unica/ui/components/dialog";
import { Input } from "@unica/ui/components/input";
import { Label } from "@unica/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { Switch } from "@unica/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unica/ui/components/tabs";
import { Check, Copy, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { applyTheme } from "~/lib/boot";
import { client } from "~/rpc/connection";
import { setApp, useApp, type SettingsTab } from "~/state/app";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border py-3 last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
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
  const [apiKey, setApiKey] = useState("");
  const [agent, setAgent] = useState<{ mcpCommand: string; socketPath: string; skillPath: string } | null>(null);

  useEffect(() => {
    if (open && window.unicaDesktop) void window.unicaDesktop.agentInfo().then(setAgent).catch(() => {});
  }, [open]);

  if (!settings) return null;
  const update = async (patch: Partial<Omit<AppSettings, "hasAiKey">>) => {
    const next = await client.call("settings.update", patch);
    setApp({ settings: next });
    if (patch.theme) applyTheme(patch.theme);
  };
  const mcp = agent?.mcpCommand ?? "/Applications/Unica.app/Contents/Resources/bin/unica-mcp";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="h-[min(640px,85vh)] max-w-[min(720px,92vw)] gap-0 overflow-hidden p-0 sm:max-w-[min(720px,92vw)]" data-testid="settings-dialog">
        <DialogTitle className="sr-only">Ajustes</DialogTitle>
        <Tabs value={tab} onValueChange={(v) => setApp({ settingsTab: v as SettingsTab })} className="flex h-full flex-col gap-0">
          <div className="border-b border-border px-5 pt-4 pb-3">
            <h2 className="mb-3 text-base font-semibold">Ajustes</h2>
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="accounts" data-testid="tab-accounts">Cuentas</TabsTrigger>
              <TabsTrigger value="ai" data-testid="tab-ai">IA</TabsTrigger>
              <TabsTrigger value="agents" data-testid="tab-agents">Agentes</TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
            <TabsContent value="general">
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
              <Row label="Cargar imágenes remotas siempre" hint="Por defecto se bloquean para evitar rastreo.">
                <Switch checked={settings.remoteImages === "always"} onCheckedChange={(on) => update({ remoteImages: on ? "always" : "ask" })} />
              </Row>
              <Row label="Ventana de sincronización" hint="Días de correo a descargar al conectar una cuenta.">
                <Input type="number" className="h-8 w-24" defaultValue={settings.syncWindowDays} onBlur={(e) => update({ syncWindowDays: Math.max(7, Number(e.target.value) || 90) })} />
              </Row>
            </TabsContent>

            <TabsContent value="accounts">
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
                        if (!confirm(`¿Quitar ${a.email}? Se borrarán sus correos locales.`)) return;
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

            <TabsContent value="ai">
              <Row label="Proveedor" hint="La IA crea filtros a partir de tu descripción.">
                <Select value={settings.aiProvider} onValueChange={(v) => update({ aiProvider: v as AppSettings["aiProvider"] })} items={[{ value: "anthropic", label: "Claude (Anthropic)" }, { value: "fake", label: "Demo sin conexión" }, { value: "none", label: "Desactivada" }]}>
                  <SelectTrigger size="sm" className="w-48" data-testid="ai-provider"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic">Claude (Anthropic)</SelectItem>
                    <SelectItem value="fake">Demo sin conexión</SelectItem>
                    <SelectItem value="none">Desactivada</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              {settings.aiProvider === "anthropic" && (
                <>
                  <Row label="Modelo">
                    <Input className="h-8 w-48 font-mono text-xs" defaultValue={settings.aiModel} onBlur={(e) => update({ aiModel: e.target.value.trim() })} />
                  </Row>
                  <div className="space-y-2 py-3">
                    <Label htmlFor="ai-key">API key de Anthropic {settings.hasAiKey && <span className="text-success">· guardada</span>}</Label>
                    <div className="flex gap-2">
                      <Input id="ai-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" />
                      <Button
                        disabled={!apiKey}
                        onClick={async () => {
                          await client.call("settings.setSecret", { name: "anthropicApiKey", value: apiKey.trim() });
                          setApiKey("");
                          setApp({ settings: { ...settings, hasAiKey: true } });
                          toast.success("API key guardada en el llavero");
                        }}
                      >
                        Guardar
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Se cifra con el llavero de macOS. Nunca sale de tu Mac salvo hacia Anthropic.</p>
                  </div>
                </>
              )}
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
      </DialogContent>
    </Dialog>
  );
}

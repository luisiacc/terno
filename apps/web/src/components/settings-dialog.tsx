import { Button } from "@unica/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@unica/ui/components/dialog";
import { Switch } from "@unica/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unica/ui/components/tabs";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@unica/ui/components/alert-dialog";
import { Check, Copy } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { setApp, useApp, type SettingsTab } from "~/state/app";
import { AiTab } from "./settings/ai-tab";
import { AppearanceTab } from "./settings/appearance-tab";
import { CategoriesTab } from "./settings/categories-tab";
import { AccountsTab } from "./settings/accounts-tab";
import { GeneralTab } from "./settings/general-tab";
import { SETTINGS_TABS } from "./settings/tabs";
import { reconcileSettings } from "~/lib/appearance";
import { DesktopOnly } from "~/lib/web-parts";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./settings/parts";

function CopyBlock({ text, testId }: { text: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative" data-testid={testId}>
      <pre className="overflow-x-auto rounded-lg bg-tint p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text}</pre>
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
  const agentsHere = useApp((s) => s.host?.capabilities.agents ?? true);
  const [confirmLocalOff, setConfirmLocalOff] = useState(false);
  const [agent, setAgent] = useState<{ mcpCommand: string; socketPath: string; skillPath: string } | null>(null);

  useEffect(() => {
    if (open && window.unicaDesktop) void window.unicaDesktop.agentInfo().then(setAgent).catch(() => {});
  }, [open]);

  const update = useCallback<SettingsUpdate>(async (patch, options) => {
    try {
      setApp({ settings: reconcileSettings(await client.call("settings.update", patch)) });
    } catch (error) {
      // a field that shows its own error asks to hear about it; anything else says so in a toast
      if (options?.quiet) throw error;
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);
  if (!settings) return null;
  const mcp = agent?.mcpCommand ?? "/Applications/Unica.app/Contents/Resources/bin/unica-mcp";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="h-[min(640px,85vh)] max-w-[min(820px,94vw)] gap-0 overflow-hidden p-0 sm:max-w-[min(820px,94vw)]" data-testid="settings-dialog">
        <DialogTitle className="sr-only">Ajustes</DialogTitle>
        <Tabs value={tab} onValueChange={(v) => setApp({ settingsTab: v as SettingsTab })} orientation="vertical" className="flex h-full flex-row gap-0">
          {/* macOS System Settings: a sidebar of sections with accent glyphs */}
          <nav className="hairline-r hairline-strong flex w-[180px] shrink-0 flex-col bg-sidebar px-2 pt-5 pb-3">
            <h2 className="mb-3 px-2 text-md font-semibold tracking-tight">Ajustes</h2>
            <TabsList activateOnFocus className="w-full items-stretch bg-transparent p-0">
              {SETTINGS_TABS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-testid={`tab-${value}`}
                  className="h-7 justify-start gap-2.5 rounded-md px-2 font-normal text-sidebar-foreground after:hidden data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-sidebar-accent"
                >
                  <Icon className="size-4 text-sidebar-glyph" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-4">
            <h2 className="mb-4 text-lg font-semibold tracking-tight">{SETTINGS_TABS.find((t) => t.value === tab)?.label}</h2>
            <TabsContent value="general">
              <GeneralTab settings={settings} update={update} onLocalOff={() => setConfirmLocalOff(true)} />
            </TabsContent>

            <TabsContent value="appearance">
              <AppearanceTab settings={settings} />
            </TabsContent>

            <TabsContent value="accounts">
              <AccountsTab settings={settings} update={update} />
            </TabsContent>

            <TabsContent value="categories">
              <CategoriesTab settings={settings} />
            </TabsContent>

            <TabsContent value="ai">
              <AiTab settings={settings} update={update} />
            </TabsContent>

            <TabsContent value="agents" className="space-y-4 py-3">
              {!agentsHere && DesktopOnly ? (
                <Suspense>
                  <DesktopOnly feature="agents" />
                </Suspense>
              ) : (
                <>
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
                  <SettingsGroup>
                    <SettingsRow label="Permitir que los agentes envíen correos" hint="Si está desactivado, los agentes solo pueden leer, organizar y crear borradores.">
                      {(a) => <Switch {...a} data-testid="allow-agent-send" checked={settings.allowAgentSend} onCheckedChange={(on) => void update({ allowAgentSend: on })} />}
                    </SettingsRow>
                  </SettingsGroup>
                </>
              )}
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

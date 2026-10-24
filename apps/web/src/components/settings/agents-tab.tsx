import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { Check, Copy, KeyRound } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { DesktopOnly } from "~/lib/web-parts";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const time = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });

function CopyBlock({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative" data-testid={testId}>
      <pre className="overflow-x-auto rounded-lg bg-background p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap dark:bg-input/30">{text}</pre>
      <button
        type="button"
        aria-label={`Copiar: ${label}`}
        className="absolute top-2 right-2 rounded p-1 text-muted-foreground hover:bg-tint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => toast.error("No se pudo copiar"),
          );
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <span role="status" className="sr-only">
        {copied ? "Copiado" : ""}
      </span>
    </div>
  );
}

type Status = { available: boolean; connected: number; tokenSince: number | null };

/** The MCP token: who is connected, since when it is valid, and a new one on demand. */
function TokenRow() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void client.call("agents.status", {}).then(setStatus, () => setStatus(null));
  useEffect(refresh, []);
  if (!status?.available) return null;
  const rotate = async () => {
    setBusy(true);
    try {
      const r = await client.call("agents.rotateToken", {});
      toast.success(r.disconnected ? `Token cambiado: ${r.disconnected} ${r.disconnected === 1 ? "agente desconectado" : "agentes desconectados"}` : "Token cambiado");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      testId="agents-token-row"
      label="Token de acceso"
      hint={`${status.connected === 1 ? "1 agente conectado" : `${status.connected} agentes conectados`}${status.tokenSince ? ` · válido desde ${time.format(status.tokenSince)}` : ""}. Cambiarlo desconecta a los agentes; vuelven al abrir una sesión nueva.`}
    >
      {({ id: _id, "aria-labelledby": _l, ...a }) => (
        <Button {...a} variant="outline" size="sm" disabled={busy} data-testid="agents-rotate" onClick={() => void rotate()}>
          <KeyRound /> Cambiar token
        </Button>
      )}
    </SettingsRow>
  );
}

export function AgentsTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const agentsHere = useApp((s) => s.host?.capabilities.agents ?? true);
  const [agent, setAgent] = useState<{ mcpCommand: string; socketPath: string; skillPath: string } | null>(null);
  useEffect(() => {
    if (window.unicaDesktop) void window.unicaDesktop.agentInfo().then(setAgent).catch(() => {});
  }, []);
  if (!agentsHere && DesktopOnly) {
    return (
      <Suspense>
        <DesktopOnly feature="agents" />
      </Suspense>
    );
  }
  const mcp = agent?.mcpCommand ?? "/Applications/Unica.app/Contents/Resources/bin/unica-mcp";
  return (
    <div data-testid="agents-tab">
      <SettingsGroup title="Conectar" footer="Claude Code o Codex llegan a todas tus cuentas por MCP mientras Única está abierta.">
        <SettingsRow stacked label="Claude Code">
          {() => <CopyBlock testId="mcp-claude" label="comando de Claude Code" text={`claude mcp add unica -- "${mcp}"`} />}
        </SettingsRow>
        <SettingsRow stacked label="Codex" hint="En ~/.codex/config.toml">
          {() => <CopyBlock testId="mcp-codex" label="configuración de Codex" text={`[mcp_servers.unica]\ncommand = "${mcp}"`} />}
        </SettingsRow>
        {agent && (
          <SettingsRow stacked label="Skill para Claude Code">
            {() => <CopyBlock label="instalación de la skill" text={`mkdir -p ~/.claude/skills/unica && cp "${agent.skillPath}" ~/.claude/skills/unica/SKILL.md`} />}
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup title="Permisos">
        <SettingsRow label="Permitir que los agentes envíen correos" hint="Si está desactivado, los agentes solo pueden leer, organizar y crear borradores.">
          {(a) => <Switch {...a} data-testid="allow-agent-send" checked={settings.allowAgentSend} onCheckedChange={(on) => void update({ allowAgentSend: on })} />}
        </SettingsRow>
        <TokenRow />
      </SettingsGroup>
    </div>
  );
}

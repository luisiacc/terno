import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { Check, Copy, KeyRound } from "lucide-react";
import { localeTag, t } from "@terno/i18n";
import { Suspense, useEffect, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { DesktopOnly } from "~/lib/web-parts";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const time = (ms: number) => new Intl.DateTimeFormat(localeTag(), { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(ms);

function CopyBlock({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative" data-testid={testId}>
      <pre className="overflow-x-auto rounded-lg bg-background p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap dark:bg-input/30">{text}</pre>
      <button
        type="button"
        aria-label={t("settings.agents.copy", { label })}
        className="absolute top-2 right-2 rounded p-1 text-muted-foreground hover:bg-tint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => snack.error(t("settings.copyFailed")),
          );
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <span role="status" className="sr-only">
        {copied ? t("common.copied") : ""}
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
      snack.success(r.disconnected ? t("settings.agents.tokenChangedDisconnected", { count: r.disconnected }) : t("settings.agents.tokenChanged"));
      refresh();
    } catch (e) {
      snack.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      testId="agents-token-row"
      label={t("settings.agents.token")}
      hint={status.tokenSince ? t("settings.agents.token.hintSince", { count: status.connected, since: time(status.tokenSince) }) : t("settings.agents.token.hint", { count: status.connected })}
    >
      {({ id: _id, "aria-labelledby": _l, ...a }) => (
        <Button {...a} variant="outline" size="sm" disabled={busy} data-testid="agents-rotate" onClick={() => void rotate()}>
          <KeyRound /> {t("settings.agents.rotate")}
        </Button>
      )}
    </SettingsRow>
  );
}

export function AgentsTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const agentsHere = useApp((s) => s.host?.capabilities.agents ?? true);
  const [agent, setAgent] = useState<{ mcpCommand: string; socketPath: string; skillPath: string } | null>(null);
  useEffect(() => {
    if (window.ternoDesktop) void window.ternoDesktop.agentInfo().then(setAgent).catch(() => {});
  }, []);
  if (!agentsHere && DesktopOnly) {
    return (
      <Suspense>
        <DesktopOnly feature="agents" />
      </Suspense>
    );
  }
  const mcp = agent?.mcpCommand ?? "/Applications/Terno.app/Contents/Resources/bin/terno-mcp";
  return (
    <div data-testid="agents-tab">
      <SettingsGroup title={t("common.connect")} footer={t("settings.agents.connect.footer")}>
        <SettingsRow stacked label="Claude Code">
          {() => <CopyBlock testId="mcp-claude" label={t("settings.agents.claudeCommand")} text={`claude mcp add terno -- "${mcp}"`} />}
        </SettingsRow>
        <SettingsRow stacked label="Codex" hint={t("settings.agents.codex.hint", { path: "~/.codex/config.toml" })}>
          {() => <CopyBlock testId="mcp-codex" label={t("settings.agents.codexConfig")} text={`[mcp_servers.terno]\ncommand = "${mcp}"`} />}
        </SettingsRow>
        {agent && (
          <SettingsRow stacked label={t("settings.agents.skill")}>
            {() => <CopyBlock label={t("settings.agents.skillInstall")} text={`mkdir -p ~/.claude/skills/terno && cp "${agent.skillPath}" ~/.claude/skills/terno/SKILL.md`} />}
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup title={t("settings.agents.permissions")}>
        <SettingsRow label={t("settings.agents.allowSend")} hint={t("settings.agents.allowSend.hint")}>
          {(a) => <Switch {...a} data-testid="allow-agent-send" checked={settings.allowAgentSend} onCheckedChange={(on) => void update({ allowAgentSend: on })} />}
        </SettingsRow>
        <TokenRow />
      </SettingsGroup>
    </div>
  );
}

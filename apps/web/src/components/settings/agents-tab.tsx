import { AGENT_ACCESS, type AgentAccess } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Check, Copy, KeyRound } from "@terno/ui/icons";
import { localeTag, t } from "@terno/i18n";
import { useEffect, useState } from "react";
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

type Status = { available: boolean; enabled: boolean; running: boolean; connected: number; tokenSince: number | null };

const ACCESS = () =>
  AGENT_ACCESS.map((value) => ({ value, label: t(`settings.agents.access.${value}`), hint: t(`settings.agents.access.${value}.hint`) }));

/** The MCP token: who is connected, since when it is valid, and a new one on demand. */
function TokenRow({ status, refresh }: { status: Status; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
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
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = () => void client.call("agents.status", {}).then(setStatus, () => setStatus(null));
  const { enabled, access } = settings.agents;
  // plan 183: the socket opens and closes with the switch, so what it says follows it
  useEffect(refresh, [enabled]);
  useEffect(() => {
    if (window.ternoDesktop) void window.ternoDesktop.agentInfo().then(setAgent).catch(() => {});
  }, []);
  if (!agentsHere && DesktopOnly) {
    return (
      <DesktopOnly feature="agents" />
    );
  }
  const mcp = agent?.mcpCommand ?? "/Applications/Terno.app/Contents/Resources/bin/terno-mcp";
  const levels = ACCESS();
  const generic = JSON.stringify({ mcpServers: { terno: { command: mcp } } }, null, 2);
  return (
    <div data-testid="agents-tab">
      <SettingsGroup title={t("settings.agents.access")}>
        <SettingsRow
          label={t("settings.agents.enabled")}
          hint={t("settings.agents.enabled.hint")}
          error={enabled && status?.available && !status.running ? t("settings.agents.startFailed") : null}
          errorTestId="agents-start-failed"
        >
          {(a) => <Switch {...a} data-testid="agents-enabled" checked={enabled} onCheckedChange={(on) => void update({ agents: { enabled: on } })} />}
        </SettingsRow>
        {enabled && (
          <SettingsRow label={t("settings.agents.level")} hint={levels.find((l) => l.value === access)?.hint}>
            {({ id: _id, ...a }) => (
              <Select value={access} onValueChange={(v) => void update({ agents: { access: v as AgentAccess } })} items={levels.map(({ value, label }) => ({ value, label }))}>
                <SelectTrigger {...a} size="sm" className="w-auto min-w-40" data-testid="agents-access">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {levels.map((l) => (
                    <SelectItem key={l.value} value={l.value} data-testid={`agents-access-${l.value}`}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        )}
        {enabled && status?.running && <TokenRow status={status} refresh={refresh} />}
      </SettingsGroup>
      <SettingsGroup title={t("common.connect")} footer={t("settings.agents.connect.footer")}>
        <SettingsRow stacked label="Claude Code">
          {() => <CopyBlock testId="mcp-claude" label={t("settings.agents.claudeCommand")} text={`claude mcp add terno -- "${mcp}"`} />}
        </SettingsRow>
        <SettingsRow stacked label="Codex" hint={t("settings.agents.codex.hint", { path: "~/.codex/config.toml" })}>
          {() => <CopyBlock testId="mcp-codex" label={t("settings.agents.codexConfig")} text={`[mcp_servers.terno]\ncommand = "${mcp}"`} />}
        </SettingsRow>
        <SettingsRow stacked label={t("settings.agents.other")} hint={t("settings.agents.other.hint")}>
          {() => <CopyBlock testId="mcp-other" label={t("settings.agents.otherConfig")} text={generic} />}
        </SettingsRow>
        {agent && (
          <SettingsRow stacked label={t("settings.agents.skill")}>
            {() => <CopyBlock label={t("settings.agents.skillInstall")} text={`mkdir -p ~/.claude/skills/terno && cp "${agent.skillPath}" ~/.claude/skills/terno/SKILL.md`} />}
          </SettingsRow>
        )}
      </SettingsGroup>
    </div>
  );
}

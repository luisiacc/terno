import { aiCanRun, NUDGE_DAYS, type AiErrorKind, type AiSummariesStatus } from "@terno/core";
import type { AiUsageReport, AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { useEffect, useState } from "react";
import { errorHelp, providerLabel, routeOf, summariesOffered, usd } from "~/lib/ai";
import { localized } from "~/lib/i18n";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

const NUDGE_CHOICES = NUDGE_DAYS.map((d) => String(d));

/**
 * Plan 142, on by default since plan 211 wherever AI runs (a switch off stays off). What you sent in the last 30 days is the
 * backend's to check, each account once, with no offer.
 */
export function FollowupsGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, followups } = settings;
  // plan 168: Terno picks where it runs (`routeFor`); the hint names who receives it
  const target = routeOf("followup", ai);
  const ready = aiCanRun("followup", ai);
  const [status, setStatus] = useState<{ blockedBy: { kind: AiErrorKind; message: string; limit?: "daily" | "monthly" } | null } | null>(null);
  useEffect(() => {
    if (!followups.enabled) return setStatus(null);
    let current = true;
    void client.call("followups.status", {}).then((r) => current && setStatus(r), () => {});
    // a failure arriving while this is open says so too
    const off = client.on("followupsStatus", setStatus);
    return () => { current = false; off(); };
  }, [followups.enabled, ai]);
  return (
    <SettingsGroup title={t("followups.title")} testId="ai-followups">
      <SettingsRow find="ai.followups" label={t("ai.followups.switch")} hint={ready ? t("ai.followups.hint", { provider: providerLabel(target.provider, ai) }) : t("ai.followups.hintNoProvider")}>
        {(a) => <Switch {...a} checked={followups.enabled} disabled={!ready && !followups.enabled} data-testid="ai-followups-switch" onCheckedChange={(enabled) => void update({ followups: { enabled } })} />}
      </SettingsRow>
      {followups.enabled && status?.blockedBy && (
        <SettingsNote testId="ai-followups-status">
          <span role="status" className="text-destructive-ink">{t("ai.followups.paused")}</span>
          {errorHelp(status.blockedBy.kind, ai) && <span> {errorHelp(status.blockedBy.kind, ai)}</span>}
        </SettingsNote>
      )}
      {followups.enabled && (
        <SettingsRow find="ai.nudge" label={t("ai.followups.nudge")} hint={t("ai.followups.nudgeHint")}>
          {({ id: _id, "aria-describedby": described }) => (
            <Select value={String(followups.nudgeAfterDays)} onValueChange={(v) => void update({ followups: { nudgeAfterDays: Number(v) as 3 | 5 | 7 | 14 } })} items={NUDGE_CHOICES.map((d) => ({ value: d, label: t("ai.followups.nudgeDays", { count: Number(d) }) }))}>
              <SelectTrigger aria-label={t("ai.followups.nudge")} aria-describedby={described} size="sm" className="w-28" data-testid="ai-followups-nudge">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NUDGE_CHOICES.map((d) => (
                  <SelectItem key={d} value={d}>{t("ai.followups.nudgeDays", { count: Number(d) })}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** Plan 141 §7: on by default, since nothing runs until someone asks. The row names where a question and its mail go. */
export function AskGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, ask } = settings;
  const target = routeOf("ask", ai);
  return (
    <SettingsGroup title={t("ai.ask.title")} testId="ai-ask">
      <SettingsRow find="ai.ask" label={t("ai.ask.switch")} hint={target.provider === "none" ? t("ai.ask.hintNoProvider") : `${t("ai.ask.hint", { provider: providerLabel(target.provider, ai) })} ${t("settings.ask.commandsHint")}`}>
        {(a) => <Switch {...a} checked={ask.enabled} data-testid="ai-ask-switch" onCheckedChange={(enabled) => void update({ ask: { enabled } })} />}
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * Plan 132 §6: whether summaries run, and why they've stopped. Only with AI (plan 157); where they run is Terno's pick
 * (plan 168), named in the hint. Without AI the provider group above is the way in, so nothing shows here.
 */
export function SummariesGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, summaries } = settings;
  const target = routeOf("summary", ai);
  const [status, setStatus] = useState<AiSummariesStatus | null>(null);
  const offered = useApp(summariesOffered);
  useEffect(() => {
    if (!offered) return setStatus(null);
    let current = true;
    void client.call("ai.summaries.status", {}).then((s) => current && setStatus(s), () => {});
    return () => { current = false; };
  }, [offered, summaries.enabled, target.provider, target.model]);
  if (!offered) return null;
  const blocked = status?.blockedBy;
  const help = blocked ? errorHelp(blocked.limit ? undefined : blocked.kind, ai) : status?.lastError ? errorHelp(status.lastError, ai) : null;
  return (
    <SettingsGroup title={t("ai.summaries.title")} testId="ai-summaries">
      <SettingsRow find="ai.summaries" label={t("ai.summaries.switch")} hint={t("ai.summaries.hint", { provider: providerLabel(target.provider, ai) })}>
        {(a) => <Switch {...a} checked={summaries.enabled} data-testid="ai-summaries-switch" onCheckedChange={(enabled) => void update({ summaries: { enabled } })} />}
      </SettingsRow>
      {summaries.enabled && (blocked || status?.lastError) && (
        <SettingsNote testId="ai-summaries-status">
          <span role="status" className="text-destructive-ink">{blocked ? localized(blocked.message, blocked.i18n) : t("ai.summaries.lastError")}</span>
          {help && <span> {help}</span>}
        </SettingsNote>
      )}
    </SettingsGroup>
  );
}

/** Plan 131: what AI has cost on the user's own keys, and the ceiling on what runs by itself. */
export function AiUseGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const [usage, setUsage] = useState<AiUsageReport | null>(null);
  useEffect(() => {
    let current = true;
    void client.call("ai.usage", {}).then((u) => current && setUsage(u), () => {});
    return () => { current = false; };
  }, []);
  return (
    <SettingsGroup testId="ai-use">
      <SettingsRow find="ai.usage" label={t("ai.usage.label")} hint={usage?.estimated ? t("ai.usage.hintEstimated") : t("ai.usage.hint")} testId="ai-usage">
        {() => <span className="text-sm text-muted-foreground tabular" data-testid="ai-usage-value">{usage ? t(usage.estimated ? "ai.usage.valueEstimated" : "ai.usage.value", { count: usage.month.requests, usd: usd(usage.month.usd) }) : "…"}</span>}
      </SettingsRow>
      {usage && usage.monthAsk.requests > 0 && (
        <SettingsNote testId="ai-usage-ask">{t("ai.ask.usage", { count: usage.monthAsk.requests, usd: usd(usage.monthAsk.usd) })}</SettingsNote>
      )}
      <SettingsRow find="ai.limit" labelFor label={t("ai.limit.label")} hint={t("ai.limit.hint")} testId="ai-limit">
        {(a) => (
          <NumberField
            id={a.id}
            aria-labelledby={a["aria-labelledby"]}
            aria-describedby={a["aria-describedby"]}
            min={0}
            max={100_000}
            step={1}
            format={{ style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }}
            className="h-7 w-28"
            data-testid="ai-limit-input"
            commitOnEnter
            value={settings.ai.monthlyLimitUsd}
            onValueCommitted={(value) => {
              if (value !== null && value !== settings.ai.monthlyLimitUsd) void update({ ai: { monthlyLimitUsd: value } });
            }}
          />
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

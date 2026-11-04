import { SUMMARY_DEFAULT_MODEL, type AiProviderId, type AiSummariesStatus, type ModelInfo } from "@terno/core";
import type { AiSettings, AiUsageReport, AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { useEffect, useState } from "react";
import { errorHelp, modelName, providerLabel, summaryTarget } from "~/lib/ai";
import { reconcileSettings } from "~/lib/appearance";
import { localized } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { CommitInput, SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

/** The providers summaries may run on here: what has a key, and what's set up as the configured one. */
function providerChoices(ai: AiSettings): AiProviderId[] {
  const out = new Set<AiProviderId>();
  if (ai.keys.openai?.hasKey) out.add("openai");
  if (ai.keys.anthropic?.hasKey) out.add("anthropic");
  if (ai.provider !== "none") out.add(ai.provider);
  if (ai.tasks.summary) out.add(ai.tasks.summary.provider);
  return [...out];
}

/** A model per provider, when one isn't chosen yet: what it's set to, or Luna on OpenAI. */
const modelFor = (ai: AiSettings, provider: AiProviderId) => (provider === "openai" ? SUMMARY_DEFAULT_MODEL : ai.profiles[provider]?.model || (provider === ai.provider ? ai.model : ""));

/** Plan 132 §2: where summaries run, asked outright when a default would move mail somewhere the user didn't pick. */
function TargetRow({ ai, update }: { ai: AiSettings; update: SettingsUpdate }) {
  const target = summaryTarget(ai);
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const provider = target.state === "ready" ? target.provider : null;
  useEffect(() => {
    setModels([]);
    if (!provider) return;
    let current = true;
    void client.call("ai.listModels", { provider }).then((r) => current && setModels(r.models), () => {});
    return () => { current = false; };
  }, [provider]);
  const saveKey = async () => {
    const value = key.trim();
    if (!value) return;
    try {
      setApp({ settings: reconcileSettings(await client.call("ai.setKey", { provider: "openai", value })) });
      setKey("");
      setAdding(false);
      snack.success(t("ai.key.savedSnack"));
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  if (target.state !== "ready") {
    const configured = target.state === "ask" ? target.provider : null;
    return (
      <SettingsRow stacked labelFor={adding} label={t("ai.summaries.target")} hint={configured ? t("ai.summaries.ask", { provider: providerLabel(configured, ai) }) : t("ai.summaries.none")} testId="ai-summaries-target">
        {(a) =>
          adding ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <Input {...a} aria-label={t("ai.summaries.keyLabel")} data-testid="ai-summaries-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" className="h-7 bg-background dark:bg-input/30" />
              <Button type="submit" size="sm" disabled={!key.trim()} data-testid="ai-summaries-key-save">
                {t("common.save")}
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" data-testid="ai-summaries-add-key" onClick={() => setAdding(true)}>
                {t("ai.summaries.addKey")}
              </Button>
              {configured && (
                <Button variant="outline" size="sm" data-testid="ai-summaries-use" onClick={() => void update({ ai: { tasks: { summary: { provider: configured, model: ai.model } } } })}>
                  {t("ai.summaries.use", { provider: providerLabel(configured, ai) })}
                </Button>
              )}
            </div>
          )
        }
      </SettingsRow>
    );
  }
  const choices = providerChoices(ai);
  const hasModel = models.some((m) => m.id === target.model);
  const shownModels = hasModel || !target.model ? models : [{ id: target.model }, ...models];
  return (
    <SettingsRow stacked label={t("ai.summaries.target")} hint={t("ai.summaries.targetHint")} testId="ai-summaries-target">
      {({ id: _id, "aria-describedby": described }) => (
        <div className="flex items-center gap-2">
          <Select
            value={target.provider}
            onValueChange={(v) => {
              const next = v as AiProviderId;
              if (next !== target.provider) void update({ ai: { tasks: { summary: { provider: next, model: modelFor(ai, next) || target.model } } } });
            }}
            items={choices.map((p) => ({ value: p, label: providerLabel(p, ai) }))}
          >
            <SelectTrigger aria-label={t("ai.summaries.targetProvider")} aria-describedby={described} size="sm" className="w-44 shrink-0" data-testid="ai-summaries-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((p) => (
                <SelectItem key={p} value={p} data-testid={`ai-summaries-provider-${p}`}>
                  {providerLabel(p, ai)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* the offline demo has one model, nothing to choose (as the row above) */}
          {target.provider === "fake" ? null : shownModels.length > 1 ? (
            <Select value={target.model} onValueChange={(v) => void update({ ai: { tasks: { summary: { provider: target.provider, model: v as string } } } })} items={shownModels.map((m) => ({ value: m.id, label: modelName(m.id) }))}>
              <SelectTrigger aria-label={t("ai.summaries.targetModel")} size="sm" className="min-w-0 flex-1" data-testid="ai-summaries-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {shownModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {modelName(m.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="min-w-0 flex-1">
              <CommitInput
                a11y={{ "aria-label": t("ai.summaries.targetModel") }}
                data-testid="ai-summaries-model-input"
                className="h-7 bg-background font-mono text-xs dark:bg-input/30"
                value={target.model}
                onCommit={async (model) => {
                  if (model.trim()) await update({ ai: { tasks: { summary: { provider: target.provider, model: model.trim() } } } }, { quiet: true });
                }}
              />
            </div>
          )}
        </div>
      )}
    </SettingsRow>
  );
}

/** Plan 132 §2 and §6: turning summaries on, where they run, and why they've stopped, findable here. */
export function SummariesGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, summaries } = settings;
  const target = summaryTarget(ai);
  const [status, setStatus] = useState<AiSummariesStatus | null>(null);
  useEffect(() => {
    let current = true;
    void client.call("ai.summaries.status", {}).then((s) => current && setStatus(s), () => {});
    return () => { current = false; };
  }, [summaries.enabled, ai.tasks.summary?.provider, ai.keys.openai?.hasKey]);
  const blocked = status?.blockedBy;
  const help = blocked ? errorHelp(blocked.limit ? undefined : blocked.kind, ai) : status?.lastError ? errorHelp(status.lastError, ai) : null;
  return (
    <SettingsGroup title={t("ai.summaries.title")} testId="ai-summaries">
      <SettingsRow label={t("ai.summaries.switch")} hint={target.state === "ready" ? t("ai.summaries.hint", { provider: providerLabel(target.provider, ai) }) : t("ai.summaries.hintNoProvider")}>
        {(a) => <Switch {...a} checked={summaries.enabled} disabled={target.state !== "ready" && !summaries.enabled} data-testid="ai-summaries-switch" onCheckedChange={(enabled) => void update({ summaries: { enabled } })} />}
      </SettingsRow>
      <TargetRow ai={ai} update={update} />
      {summaries.enabled && (blocked || status?.lastError) && (
        <SettingsNote testId="ai-summaries-status">
          <span role="status" className="text-destructive-ink">{blocked ? localized(blocked.message, blocked.i18n) : t("ai.summaries.lastError")}</span>
          {help && <span> {help}</span>}
        </SettingsNote>
      )}
    </SettingsGroup>
  );
}

const usd = (amount: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: amount > 0 && amount < 0.1 ? 3 : 2 }).format(amount);

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
      <SettingsRow label={t("ai.usage.label")} hint={t("ai.usage.hint")} testId="ai-usage">
        {() => <span className="text-sm text-muted-foreground tabular" data-testid="ai-usage-value">{usage ? t("ai.usage.value", { count: usage.month.requests, usd: usd(usage.month.usd) }) : "…"}</span>}
      </SettingsRow>
      <SettingsRow label={t("ai.limit.label")} hint={t("ai.limit.hint")} testId="ai-limit">
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

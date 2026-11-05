import { ASK_CLAUDE_MODEL, SUMMARY_CLAUDE_MODEL, SUMMARY_DEFAULT_MODEL, type AiProviderId, type AiSummariesStatus, type AiTaskName, type ModelInfo } from "@terno/core";
import type { AiSettings, AiUsageReport, AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { useEffect, useState } from "react";
import { askTarget, errorHelp, modelName, providerLabel, summaryTarget } from "~/lib/ai";
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
                <Button variant="outline" size="sm" data-testid="ai-summaries-use" onClick={() => void update({ ai: { tasks: { summary: { provider: configured, model: configured === "anthropic" ? SUMMARY_CLAUDE_MODEL : ai.model } } } })}>
                  {t("ai.summaries.use", { provider: providerLabel(configured, ai) })}
                </Button>
              )}
            </div>
          )
        }
      </SettingsRow>
    );
  }
  return <TaskTargetRow ai={ai} update={update} task="summary" provider={target.provider} model={target.model} choices={providerChoices(ai)} modelFor={(next) => modelFor(ai, next) || target.model} models={models} prefix="ai-summaries" labels={{ row: t("ai.summaries.target"), hint: t("ai.summaries.targetHint"), provider: t("ai.summaries.targetProvider"), model: t("ai.summaries.targetModel") }} />;
}

/** The provider and model a feature runs on: plan 131 §2's row, one per feature, naming where its mail goes. */
export function TaskTargetRow({ ai, update, task, provider, model, choices, modelFor: nextModel, models, prefix, labels }: { ai: AiSettings; update: SettingsUpdate; task: AiTaskName; provider: AiProviderId; model: string; choices: readonly AiProviderId[]; modelFor: (provider: AiProviderId) => string; models: readonly ModelInfo[]; prefix: string; labels: { row: string; hint: string; provider: string; model: string } }) {
  const hasModel = models.some((m) => m.id === model);
  const shownModels = hasModel || !model ? models : [{ id: model }, ...models];
  return (
    <SettingsRow stacked label={labels.row} hint={labels.hint} testId={`${prefix}-target`}>
      {({ id: _id, "aria-describedby": described }) => (
        <div className="flex items-center gap-2">
          <Select
            value={provider}
            onValueChange={(v) => {
              const next = v as AiProviderId;
              if (next !== provider) void update({ ai: { tasks: { [task]: { provider: next, model: nextModel(next) } } } });
            }}
            items={choices.map((p) => ({ value: p, label: providerLabel(p, ai) }))}
          >
            <SelectTrigger aria-label={labels.provider} aria-describedby={described} size="sm" className="w-44 shrink-0" data-testid={`${prefix}-provider`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((p) => (
                <SelectItem key={p} value={p} data-testid={`${prefix}-provider-${p}`}>
                  {providerLabel(p, ai)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* the offline demo has one model, nothing to choose (as the row above) */}
          {provider === "fake" ? null : shownModels.length > 1 ? (
            <Select value={model} onValueChange={(v) => void update({ ai: { tasks: { [task]: { provider, model: v as string } } } })} items={shownModels.map((m) => ({ value: m.id, label: modelName(m.id) }))}>
              <SelectTrigger aria-label={labels.model} size="sm" className="min-w-0 flex-1" data-testid={`${prefix}-model`}>
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
                a11y={{ "aria-label": labels.model }}
                data-testid={`${prefix}-model-input`}
                className="h-7 bg-background font-mono text-xs dark:bg-input/30"
                value={model}
                onCommit={async (value) => {
                  if (value.trim()) await update({ ai: { tasks: { [task]: { provider, model: value.trim() } } } }, { quiet: true });
                }}
              />
            </div>
          )}
        </div>
      )}
    </SettingsRow>
  );
}

/** Plan 141 §7: on by default, since nothing runs until someone asks. The row names where a question and its mail go. */
export function AskGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, ask } = settings;
  const target = askTarget(ai);
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    setModels([]);
    if (target.provider === "none") return;
    let current = true;
    void client.call("ai.listModels", { provider: target.provider }).then((r) => current && setModels(r.models), () => {});
    return () => { current = false; };
  }, [target.provider]);
  return (
    <SettingsGroup title={t("ai.ask.title")} testId="ai-ask">
      <SettingsRow label={t("ai.ask.switch")} hint={target.provider === "none" ? t("ai.ask.hintNoProvider") : t("ai.ask.hint", { provider: providerLabel(target.provider, ai) })}>
        {(a) => <Switch {...a} checked={ask.enabled} data-testid="ai-ask-switch" onCheckedChange={(enabled) => void update({ ask: { enabled } })} />}
      </SettingsRow>
      {target.provider !== "none" && <TaskTargetRow ai={ai} update={update} task="ask" provider={target.provider} model={target.model} choices={[...new Set([...providerChoices(ai), target.provider])]} modelFor={(next) => (next === "anthropic" ? ASK_CLAUDE_MODEL : modelFor(ai, next) || target.model)} models={models} prefix="ai-ask" labels={{ row: t("ai.ask.target"), hint: t("ai.ask.targetHint"), provider: t("ai.ask.targetProvider"), model: t("ai.ask.targetModel") }} />}
    </SettingsGroup>
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
      <SettingsRow label={t("ai.usage.label")} hint={usage?.estimated ? t("ai.usage.hintEstimated") : t("ai.usage.hint")} testId="ai-usage">
        {() => <span className="text-sm text-muted-foreground tabular" data-testid="ai-usage-value">{usage ? t(usage.estimated ? "ai.usage.valueEstimated" : "ai.usage.value", { count: usage.month.requests, usd: usd(usage.month.usd) }) : "…"}</span>}
      </SettingsRow>
      {usage && usage.monthAsk.requests > 0 && (
        <SettingsNote testId="ai-usage-ask">{t("ai.ask.usage", { count: usage.monthAsk.requests, usd: usd(usage.monthAsk.usd) })}</SettingsNote>
      )}
      <SettingsRow labelFor label={t("ai.limit.label")} hint={t("ai.limit.hint")} testId="ai-limit">
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

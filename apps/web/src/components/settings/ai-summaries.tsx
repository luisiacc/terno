import { ASK_CLAUDE_MODEL, DIGEST_CLAUDE_MODEL, DIGEST_OPENAI_MODEL, FOLLOWUP_CLAUDE_MODEL, FOLLOWUP_OPENAI_MODEL, NUDGE_DAYS, SUMMARY_CLAUDE_MODEL, SUMMARY_DEFAULT_MODEL, type AiErrorKind, type AiProviderId, type AiSummariesStatus, type AiTaskName, type ModelInfo, type NotNewsletter } from "@terno/core";
import type { AiSettings, AiUsageReport, AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CloseButton } from "@terno/ui/components/close-button";
import { Input } from "@terno/ui/components/input";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { useEffect, useRef, useState } from "react";
import { digestTarget, askTarget, errorHelp, followupTarget, modelName, providerLabel, summariesOffered, summaryTarget } from "~/lib/ai";
import { reconcileSettings } from "~/lib/appearance";
import { localized } from "~/lib/i18n";
import { undoAction } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import { reloadList } from "~/state/list";
import { leaveOut, letBackIn, senderKey } from "~/state/today";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
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
      <SettingsRow stacked labelFor={adding} label={t("ai.summaries.target")} hint={ai.fromEnv ? t("ai.summaries.devKey") : configured ? t("ai.summaries.ask", { provider: providerLabel(configured, ai) }) : t("ai.summaries.none")} testId="ai-summaries-target">
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
              {/* plan 146: a key saved now would change nothing, and overwrite the one kept for later */}
              {!ai.fromEnv && (
                <Button variant="outline" size="sm" data-testid="ai-summaries-add-key" onClick={() => setAdding(true)}>
                  {t("ai.summaries.addKey")}
                </Button>
              )}
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

const NUDGE_CHOICES = NUDGE_DAYS.map((d) => String(d));

/**
 * Plan 142 §8: off by default. Turning it on offers the last 30 days once, with the count and the cost, and sends nothing
 * old without a yes.
 */
export function FollowupsGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, followups } = settings;
  const target = followupTarget(ai);
  const ready = target.provider !== "none";
  const [offer, setOffer] = useState<{ count: number; usd: number | null } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const offering = followups.enabled && !followups.scanAnswered;
  const [status, setStatus] = useState<{ blockedBy: { kind: AiErrorKind; message: string } | null } | null>(null);
  useEffect(() => {
    if (!followups.enabled) return setStatus(null);
    let current = true;
    void client.call("followups.status", {}).then((r) => current && setStatus(r), () => {});
    // a failure arriving while this is open says so too
    const off = client.on("followupsStatus", setStatus);
    return () => { current = false; off(); };
  }, [followups.enabled, ai]);
  useEffect(() => {
    if (!offering) return setOffer(null);
    let current = true;
    void client.call("followups.scanOffer", {}).then((o) => current && setOffer(o), () => {});
    return () => { current = false; };
  }, [offering]);
  useEffect(() => {
    setModels([]);
    if (!ready || !followups.enabled) return;
    let current = true;
    void client.call("ai.listModels", { provider: target.provider }).then((r) => current && setModels(r.models), () => {});
    return () => { current = false; };
  }, [target.provider, ready, followups.enabled]);
  const answer = async (check: boolean) => {
    if (check) await client.call("followups.scan", {}).catch(() => {});
    await update({ followups: { scanAnswered: true } }, { quiet: true });
  };
  return (
    <SettingsGroup title={t("followups.title")} testId="ai-followups">
      <SettingsRow label={t("ai.followups.switch")} hint={ready ? t("ai.followups.hint", { provider: providerLabel(target.provider, ai) }) : t("ai.followups.hintNoProvider")}>
        {(a) => <Switch {...a} checked={followups.enabled} disabled={!ready && !followups.enabled} data-testid="ai-followups-switch" onCheckedChange={(enabled) => void update({ followups: { enabled } })} />}
      </SettingsRow>
      {offering && offer && offer.count > 0 && (
        <SettingsNote testId="ai-followups-offer">
          <span>{offer.usd !== null ? t("ai.followups.offerCost", { count: offer.count, usd: usd(offer.usd) }) : t("ai.followups.offer", { count: offer.count })}</span>{" "}
          <Button variant="link" size="xs" data-testid="ai-followups-check" onClick={() => void answer(true)}>{t("ai.followups.check")}</Button>{" "}
          <Button variant="link-secondary" size="xs" data-testid="ai-followups-notnow" onClick={() => void answer(false)}>{t("ai.followups.notNow")}</Button>
        </SettingsNote>
      )}
      {followups.enabled && status?.blockedBy && (
        <SettingsNote testId="ai-followups-status">
          <span role="status" className="text-destructive-ink">{t("ai.followups.paused")}</span>
          {errorHelp(status.blockedBy.kind, ai) && <span> {errorHelp(status.blockedBy.kind, ai)}</span>}
        </SettingsNote>
      )}
      {followups.enabled && ready && <TaskTargetRow ai={ai} update={update} task="followup" provider={target.provider} model={target.model} choices={[...new Set([...providerChoices(ai), target.provider])]} modelFor={(next) => (next === "anthropic" ? FOLLOWUP_CLAUDE_MODEL : next === "openai" ? FOLLOWUP_OPENAI_MODEL : modelFor(ai, next) || target.model)} models={models} prefix="ai-followups" labels={{ row: t("ai.followups.target"), hint: t("ai.followups.targetHint"), provider: t("ai.followups.targetProvider"), model: t("ai.followups.targetModel") }} />}
      {followups.enabled && (
        <SettingsRow label={t("ai.followups.nudge")} hint={t("ai.followups.nudgeHint")}>
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
      <SettingsRow label={t("ai.ask.switch")} hint={target.provider === "none" ? t("ai.ask.hintNoProvider") : `${t("ai.ask.hint", { provider: providerLabel(target.provider, ai) })} ${t("settings.ask.commandsHint")}`}>
        {(a) => <Switch {...a} checked={ask.enabled} data-testid="ai-ask-switch" onCheckedChange={(enabled) => void update({ ask: { enabled } })} />}
      </SettingsRow>
      {target.provider !== "none" && <TaskTargetRow ai={ai} update={update} task="ask" provider={target.provider} model={target.model} choices={[...new Set([...providerChoices(ai), target.provider])]} modelFor={(next) => (next === "anthropic" ? ASK_CLAUDE_MODEL : modelFor(ai, next) || target.model)} models={models} prefix="ai-ask" labels={{ row: t("ai.ask.target"), hint: t("ai.ask.targetHint"), provider: t("ai.ask.targetProvider"), model: t("ai.ask.targetModel") }} />}
    </SettingsGroup>
  );
}

/** Plan 145 §4: its own opt-in, since it sends mail with no click. Only for someone who has Today. */
export function DigestGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, today } = settings;
  const target = digestTarget(ai);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const on = today?.digest === true;
  useEffect(() => {
    setModels([]);
    if (!on) return;
    let current = true;
    void client.call("ai.listModels", { provider: target.provider }).then((r) => current && setModels(r.models), () => {});
    return () => { current = false; };
  }, [on, target.provider]);
  return (
    <SettingsGroup title={t("today.digest.settingsTitle")} testId="ai-digest">
      <SettingsRow label={t("today.digest.settingsSwitch")} hint={t("today.digest.settingsHint", { provider: providerLabel(target.provider, ai) })}>
        {(a) => <Switch {...a} checked={on} data-testid="ai-digest-switch" onCheckedChange={(digest) => void update({ today: { digest } })} />}
      </SettingsRow>
      {on && <TaskTargetRow ai={ai} update={update} task="digest" provider={target.provider} model={target.model} choices={[...new Set([...providerChoices(ai), target.provider])]} modelFor={(next) => (next === "anthropic" ? DIGEST_CLAUDE_MODEL : next === "openai" ? DIGEST_OPENAI_MODEL : modelFor(ai, next) || target.model)} models={models} prefix="ai-digest" labels={{ row: t("today.digest.target"), hint: t("today.digest.targetHint"), provider: t("ai.followups.targetProvider"), model: t("ai.followups.targetModel") }} />}
      <NotNewslettersRow />
    </SettingsGroup>
  );
}

/**
 * Plan 166: the senders said not to be newsletters, where the digest's settings are: each can be let back in, with Undo.
 * Shown whenever there's one, the digest on or off (they're out of Automated mail too). Nothing here leaves the machine.
 */
function NotNewslettersRow() {
  const [senders, setSenders] = useState<NotNewsletter[] | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    let current = true;
    const read = () => void client.call("today.notNewsletters", {}).then((r) => current && setSenders(r.senders), () => {});
    read();
    const off = client.on("todayDigest", read);
    return () => {
      current = false;
      off();
    };
  }, []);
  if (!senders?.length) return null;
  const nameOf = (e: NotNewsletter) => e.name || e.email;
  const remove = async (e: NotNewsletter, at: number) => {
    const key = senderKey({ fromEmail: e.email });
    // the keys go to the next sender's Remove (else the one before): the row they were on is gone
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>("[data-testid=ai-digest-excluded-remove]") ?? [])];
    const next = buttons[at + 1] ?? buttons[at - 1];
    setSenders((held) => held && held.filter((x) => x !== e));
    next?.focus({ preventScroll: true });
    try {
      const r = await client.call("today.newsletterAgain", { email: e.email, at: e.at });
      letBackIn(key);
      void reloadList({ keepSelection: true });
      if (!r.removed) return;
      const removed = r.removed;
      const undo = registerUndo(async () => {
        // back where it was: its own time, so the list's order is as before
        await client.call("today.notNewsletter", removed);
        leaveOut(key);
        await reloadList({ keepSelection: true });
      });
      snack.success(t("today.digest.excluded.removed", { sender: nameOf(e) }), { duration: 8000, action: undoAction(undo, t("today.digest.excluded.removeUndo", { sender: nameOf(e) })) });
    } catch (error) {
      setSenders((held) => held && [...held, e].sort((a, b) => b.at - a.at));
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <SettingsRow label={t("today.digest.excluded.title")} hint={t("today.digest.excluded.hint")} stacked testId="ai-digest-excluded">
      {(a) => (
        <ul ref={list} aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} className="flex flex-col">
          {senders.map((e, i) => (
            <li key={`${e.email}-${e.at}`} className="flex min-h-9 items-center gap-3 border-b border-hairline py-1 last:border-b-0" data-testid="ai-digest-excluded-item">
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{nameOf(e)}</span>
                {e.name && e.name !== e.email && <span className="ml-2 text-xs text-muted-foreground">{e.email}</span>}
              </span>
              <CloseButton size="sm" label={t("today.digest.excluded.remove", { sender: nameOf(e) })} className="relative after:absolute after:-inset-1 after:content-['']" data-testid="ai-digest-excluded-remove" onClick={() => void remove(e, i)} />
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}

/** Plan 132 §2 and §6: where summaries run, and why they've stopped. The switch only with AI (plan 157); the row below is how someone gets it. */
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
  const offered = useApp(summariesOffered);
  return (
    <SettingsGroup title={t("ai.summaries.title")} testId="ai-summaries">
      {offered && (
        <SettingsRow label={t("ai.summaries.switch")} hint={target.state === "ready" ? t("ai.summaries.hint", { provider: providerLabel(target.provider, ai) }) : t("ai.summaries.hintNoProvider")}>
          {(a) => <Switch {...a} checked={summaries.enabled} disabled={target.state !== "ready" && !summaries.enabled} data-testid="ai-summaries-switch" onCheckedChange={(enabled) => void update({ summaries: { enabled } })} />}
        </SettingsRow>
      )}
      <TargetRow ai={ai} update={update} />
      {offered && summaries.enabled && (blocked || status?.lastError) && (
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

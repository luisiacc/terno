import { aiCanRun, NUDGE_DAYS, type AiErrorKind, type AiSummariesStatus, type NotNewsletter } from "@terno/core";
import type { AiUsageReport, AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CloseButton } from "@terno/ui/components/close-button";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { useEffect, useRef, useState } from "react";
import { errorHelp, providerLabel, routeOf, summariesOffered } from "~/lib/ai";
import { localized } from "~/lib/i18n";
import { undoAction } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import { reloadList } from "~/state/list";
import { leaveOut, letBackIn, senderKey } from "~/state/today";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

const NUDGE_CHOICES = NUDGE_DAYS.map((d) => String(d));

/**
 * Plan 142 §8: off by default. Turning it on offers the last 30 days once, with the count and the cost, and sends nothing
 * old without a yes.
 */
export function FollowupsGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, followups } = settings;
  // plan 168: Terno picks where it runs (`routeFor`); the hint names who receives it
  const target = routeOf("followup", ai);
  const ready = aiCanRun("followup", ai);
  const [offer, setOffer] = useState<{ count: number; usd: number | null } | null>(null);
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
  const answer = async (check: boolean) => {
    if (check) await client.call("followups.scan", {}).catch(() => {});
    await update({ followups: { scanAnswered: true } }, { quiet: true });
  };
  return (
    <SettingsGroup title={t("followups.title")} testId="ai-followups">
      <SettingsRow find="ai.followups" label={t("ai.followups.switch")} hint={ready ? t("ai.followups.hint", { provider: providerLabel(target.provider, ai) }) : t("ai.followups.hintNoProvider")}>
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

/** Plan 145 §4: its own opt-in, since it sends mail with no click. Only for someone who has Today. */
export function DigestGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, today } = settings;
  const target = routeOf("digest", ai);
  const on = today?.digest === true;
  return (
    <SettingsGroup title={t("today.digest.settingsTitle")} testId="ai-digest">
      <SettingsRow find="ai.digest" label={t("today.digest.settingsSwitch")} hint={t("today.digest.settingsHint", { provider: providerLabel(target.provider, ai) })}>
        {(a) => <Switch {...a} checked={on} data-testid="ai-digest-switch" onCheckedChange={(digest) => void update({ today: { digest } })} />}
      </SettingsRow>
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
    // the last one gone, the list goes with it: the digest's switch above it (Codex review: focus fell to the dialog)
    const next = buttons[at + 1] ?? buttons[at - 1] ?? document.querySelector<HTMLElement>("[data-testid=ai-digest-switch]");
    setSenders((held) => held && held.filter((x) => x !== e));
    next?.focus({ preventScroll: true });
    try {
      const r = await client.call("today.newsletterAgain", { email: e.email, id: e.id });
      letBackIn(key);
      void reloadList({ keepSelection: true });
      if (!r.removed) return;
      const removed = r.removed;
      const undo = registerUndo(async () => {
        // back as it was (its own time, so the list's order is as before), in one unit
        await client.call("today.notNewslettersUndo", { restore: [removed] });
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
    <SettingsRow find="ai.digestExcluded" label={t("today.digest.excluded.title")} hint={t("today.digest.excluded.hint")} stacked testId="ai-digest-excluded">
      {(a) => (
        <ul ref={list} aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} className="flex flex-col">
          {senders.map((e, i) => (
            <li key={e.id} className="flex min-h-9 items-center gap-3 border-b border-hairline py-1 last:border-b-0" data-testid="ai-digest-excluded-item">
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

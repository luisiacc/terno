import { aiCanRun, type AiErrorKind, type FirstScreen, type NotNewsletter } from "@terno/core";
import type { AppSettings, I18nRef } from "@terno/core/rpc";
import { getLocale, localeTag, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CloseButton } from "@terno/ui/components/close-button";
import { Switch } from "@terno/ui/components/switch";
import { Time, TimeField } from "@terno/ui/components/time-field";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { Inbox, Sun } from "@terno/ui/icons";
import { useEffect, useRef, useState } from "react";
import { setAccountFeed } from "~/lib/accounts";
import { undoAction } from "~/lib/actions";
import { aiAllowed, datedReaderLine, errorHelp, providerLabel, routeOf, todayOffered } from "~/lib/ai";
import { useDatedMutes } from "~/lib/dated-mutes";
import { localized } from "~/lib/i18n";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { leaveOut, letBackIn, senderKey } from "~/state/today";
import { HideWholeKind, MutedList } from "../what-matters/muted-list";
import { ShownList } from "../what-matters/shown-list";
import { openSettingsTab, PrivacyNote, SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

/**
 * Plan 247: What matters' own section, where it can exist (AI can run; settingsTabs), even while it's hidden from the
 * sidebar (its first switch is how it comes back). Its groups go by what you can do: the view, what it looks for, senders,
 * each morning, and which accounts feed it.
 */
export function WhatMattersTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  return (
    <div data-testid="what-matters-tab">
      <ViewGroup settings={settings} update={update} />
      <FindsGroup settings={settings} update={update} />
      <SendersGroup />
      <MorningGroup settings={settings} update={update} />
      <AccountsGroup />
    </div>
  );
}

/** The view: whether it's in the sidebar, whether it opens first (plan 207), and whether what's finished stays. */
function ViewGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const today = settings.today;
  // a local build with Dev mode's Pro AI off: the rows save, but What matters stays out of the sidebar, so say why
  const proOff = !useApp(aiAllowed);
  // Open at launch only where it shows (Codex code review of 207 #6: Dev mode's AI off has nothing to open on)
  const shown = useApp(todayOffered);
  const first: FirstScreen = settings.firstScreen ?? "inbox";
  return (
    <SettingsGroup testId="wm-settings-view">
      {proOff && (
        <SettingsRow find={false} label={t("today.settings.pro")} hint={t("today.settings.proHint")} testId="today-pro-note">
          {() => (
            <Button variant="outline" size="sm" data-testid="today-dev-open" onClick={() => openSettingsTab("dev")}>
              {t("settings.dev.open")}
            </Button>
          )}
        </SettingsRow>
      )}
      <SettingsRow find="whatMatters.show" label={t("settings.whatMatters.show")} hint={t("settings.whatMatters.show.hint")}>
        {(a) => <Switch {...a} checked={today?.show !== false} data-testid="today-show" onCheckedChange={(show) => void update({ today: { show } })} />}
      </SettingsRow>
      {shown && (
        <SettingsRow find="whatMatters.firstScreen" label={t("firstScreen.setting")} hint={t("firstScreen.setting.hint")} testId="first-screen-row">
          {(a) => (
            <ToggleGroup
              aria-labelledby={a["aria-labelledby"]}
              aria-describedby={a["aria-describedby"]}
              variant="segmented"
              value={[first]}
              onValueChange={(v: string[]) => {
                const next = v[0];
                if ((next === "inbox" || next === "whatMatters") && next !== first) void update({ firstScreen: next });
              }}
              data-testid="first-screen-toggle"
            >
              <ToggleGroupItem value="inbox" data-testid="first-screen-inbox" className="gap-1.5">
                <Inbox aria-hidden />
                {t("view.inbox")}
              </ToggleGroupItem>
              <ToggleGroupItem value="whatMatters" data-testid="first-screen-what-matters" className="gap-1.5">
                <Sun aria-hidden />
                {t("today.title")}
              </ToggleGroupItem>
            </ToggleGroup>
          )}
        </SettingsRow>
      )}
      {/* the owner: What matters first hides the Inbox's number; this keeps it */}
      {shown && first === "whatMatters" && (
        <SettingsRow find="whatMatters.keepInboxCount" label={t("firstScreen.keepInboxCount")} hint={t("firstScreen.keepInboxCount.hint")} testId="keep-inbox-count-row">
          {(a) => <Switch {...a} data-testid="keep-inbox-count" checked={settings.keepInboxCount} onCheckedChange={(on) => void update({ keepInboxCount: on })} />}
        </SettingsRow>
      )}
      <SettingsRow find="whatMatters.finished" label={t("today.settings.finished")} hint={t("today.settings.finishedHint")}>
        {(a) => <Switch {...a} checked={today?.finished !== false} data-testid="today-finished" onCheckedChange={(finished) => void update({ today: { finished } })} />}
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * Plan 204 §6: dates and requests in new mail, on by default since plan 211 wherever AI runs (a switch off stays off); the
 * last 14 days are the backend's to check. It says when it has stopped, and who reads the mail (plan 210, iteration 1).
 */
function FindsGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, dated } = settings;
  const ready = aiCanRun("dated", ai);
  const reader = datedReaderLine(ai);
  const [status, setStatus] = useState<{ blockedBy: { kind: AiErrorKind; message: string; i18n?: I18nRef; limit?: "daily" | "monthly" } | null } | null>(null);
  useEffect(() => {
    if (!dated.enabled) return setStatus(null);
    let current = true;
    void client.call("dated.status", {}).then((r) => current && setStatus(r), () => {});
    const off = client.on("datedStatus", setStatus);
    return () => {
      current = false;
      off();
    };
  }, [dated.enabled, ai]);
  return (
    <SettingsGroup
      title={t("settings.whatMatters.finds")}
      testId="ai-dated"
      footer={reader && <PrivacyNote testId="today-privacy" title={t("ai.privacy")}>{reader}</PrivacyNote>}
    >
      {/* where its mail goes, beside the switch (plan 131); the footer says it in full. No route (the section shows only where AI
          runs, so only while settings settle): a switch that's on can still go off */}
      <SettingsRow find="whatMatters.dated" label={t("ai.dated.switch")} hint={ready ? t("settings.whatMatters.dated.hint", { provider: providerLabel(routeOf("dated", ai).provider, ai) }) : t("settings.whatMatters.dated.noProvider")}>
        {(a) => <Switch {...a} checked={dated.enabled} disabled={!ready && !dated.enabled} data-testid="ai-dated-switch" onCheckedChange={(enabled) => void update({ dated: { enabled } })} />}
      </SettingsRow>
      {dated.enabled && status?.blockedBy && (
        <SettingsNote testId="ai-dated-status">
          {/* plan 239: stopped by the day's guard or the monthly ceiling, its own sentence says why and until when */}
          <span role="status" className="text-destructive-ink">{status.blockedBy.limit ? localized(status.blockedBy.message, status.blockedBy.i18n) : t("ai.dated.paused")}</span>
          {!status.blockedBy.limit && errorHelp(status.blockedBy.kind, ai) && <span> {errorHelp(status.blockedBy.kind, ai)}</span>}
        </SettingsNote>
      )}
    </SettingsGroup>
  );
}

/** Plan 240 and plan 210 (iterations 4, 5): the senders always shown and what's hidden, each with its way back. */
function SendersGroup() {
  const [mutes, setMutes] = useDatedMutes();
  // the last one gone from either list, the keys land on the view's last switch, not the dialog
  const fallback = () => document.querySelector<HTMLElement>("[data-testid=today-finished]");
  return (
    <SettingsGroup title={t("settings.whatMatters.senders")} testId="wm-settings-senders">
      <SettingsRow find="whatMatters.shown" label={t("settings.whatMatters.shown")} hint={t("settings.whatMatters.shown.hint")} stacked testId="today-shown">
        {(a) => <ShownList testId="today-shown-list" labelledBy={a["aria-labelledby"]} describedBy={a["aria-describedby"]} fallback={fallback} empty />}
      </SettingsRow>
      <SettingsRow find="whatMatters.muted" label={t("settings.whatMatters.muted")} hint={t("settings.whatMatters.muted.hint")} stacked testId="today-muted">
        {(a) => (
          <div className="flex flex-col gap-1.5">
            <MutedList mutes={mutes} setMutes={setMutes} testId="today-muted-list" labelledBy={a["aria-labelledby"]} describedBy={a["aria-describedby"]} fallback={fallback} empty />
            {/* plan 210 (iteration 5): a whole kind is hidden only from here */}
            <HideWholeKind mutes={mutes} />
          </div>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * Plan 145 §4–5: what comes each morning, at one time: the newsletter digest (its own opt-in, since it sends mail with no
 * click) and the notification. The time is theirs alone (no timer runs without one of them: today.ts `arm`), so with both
 * off it waits, saying why (as Undo send's window does, plan 188).
 */
function MorningGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const { ai, today } = settings;
  const digest = today?.digest === true;
  const notify = today?.notify === true;
  const [h = 8, m = 0] = (today?.prepareAt ?? "08:00").split(":").map(Number);
  return (
    <SettingsGroup title={t("settings.whatMatters.morning")} testId="ai-digest">
      <SettingsRow find="whatMatters.digest" label={t("settings.whatMatters.digest")} hint={t("settings.whatMatters.digest.hint", { provider: providerLabel(routeOf("digest", ai).provider, ai) })}>
        {(a) => <Switch {...a} checked={digest} data-testid="ai-digest-switch" onCheckedChange={(on) => void update({ today: { digest: on } })} />}
      </SettingsRow>
      <NotNewslettersRow />
      <SettingsRow find="whatMatters.notify" label={t("settings.whatMatters.notify")} hint={t("settings.whatMatters.notify.hint")}>
        {(a) => <Switch {...a} checked={notify} data-testid="today-notify" onCheckedChange={(on) => void update({ today: { notify: on } })} />}
      </SettingsRow>
      <SettingsRow find="whatMatters.time" label={t("settings.whatMatters.time")} hint={digest || notify ? t("settings.whatMatters.time.hint") : t("settings.whatMatters.time.offHint")} testId="today-time-row">
        {(a) => (
          <TimeField
            aria-labelledby={a["aria-labelledby"]}
            aria-describedby={a["aria-describedby"]}
            data-testid="today-prepare-at"
            isDisabled={!digest && !notify}
            locale={localeTag()}
            hourCycle={getLocale() === "en" ? 12 : 24}
            value={new Time(h, m)}
            onChange={(v) => {
              if (v) void update({ today: { prepareAt: `${String(v.hour).padStart(2, "0")}:${String(v.minute).padStart(2, "0")}` } });
            }}
            className="w-30 shrink-0"
          />
        )}
      </SettingsRow>
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
      letBackIn([key]);
      void reloadList({ keepSelection: true });
      if (!r.removed) return;
      const removed = r.removed;
      const undo = registerUndo(async () => {
        // back as it was (its own time, so the list's order is as before), in one unit
        await client.call("today.notNewslettersUndo", { restore: [removed] });
        leaveOut([key]);
        await reloadList({ keepSelection: true });
      });
      snack.success(t("today.digest.excluded.removed", { sender: nameOf(e) }), { duration: 8000, action: undoAction(undo, t("today.digest.excluded.removeUndo", { sender: nameOf(e) })) });
    } catch (error) {
      setSenders((held) => held && [...held, e].sort((a, b) => b.at - a.at));
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <SettingsRow find="whatMatters.digestExcluded" label={t("today.digest.excluded.title")} hint={t("today.digest.excluded.hint")} stacked testId="ai-digest-excluded">
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
 * Plan 211's per-account "Show in What matters", here too with two accounts or more (with one, off would empty the view;
 * Accounts keeps its switch). Both save through the account, so they agree.
 */
function AccountsGroup() {
  const accounts = useApp((s) => s.accounts);
  if (accounts.length < 2) return null;
  return (
    <SettingsGroup title={t("settings.whatMatters.accounts")} find="whatMatters.accounts" testId="wm-settings-accounts" footer={t("settings.whatMatters.accounts.footer")}>
      {accounts.map((account) => (
        <SettingsRow find={false} key={account.id} label={account.displayName} hint={account.displayName !== account.email ? account.email : undefined} testId="wm-account">
          {(a) => (
            <Switch
              {...a}
              data-testid="wm-account-feed"
              data-account-id={account.id}
              checked={account.feed !== false}
              onCheckedChange={(on) => void setAccountFeed(account.id, on)}
            />
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

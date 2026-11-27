import { leadScreen, UNDO_SEND_SECONDS, type FirstScreen, type UndoSendSeconds } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Keyboard } from "@terno/ui/icons";
import { useEffect, useReducer, useRef } from "react";
import { isLanguageSetting, LOCALE_IDS, LOCALES, resolveLocale, t, type LanguageSetting } from "@terno/i18n";
import { setApp, useApp } from "~/state/app";
import { todayOffered } from "~/lib/ai";
import { commitLanguage } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { MacSection } from "~/lib/web-parts";
import { PersonRulesList } from "./person-rules-list";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";
import { badgeSupported, pageNotificationsSupported } from "~/lib/notify";

/**
 * Plan 41: system notifications, their preview, and the unread count on the
 * Dock (desktop) or the installed app's icon (a browser that has it). In a
 * browser the switch reads on only with the permission granted, and turning
 * it on asks inside the click.
 */
/** Plan 207: the badge shows the first screen's number, and says which. */
const badgeLabel = (desktop: boolean, lead: FirstScreen): string =>
  lead === "whatMatters" ? t(desktop ? "settings.general.badgeWhatMatters" : "settings.general.badgeWhatMattersWeb") : t(desktop ? "settings.general.badge" : "settings.general.badgeWeb");
const badgeHint = (desktop: boolean, lead: FirstScreen): string =>
  lead === "whatMatters" ? t("settings.general.badgeWhatMatters.hint") : t(desktop ? "settings.general.badge.hint" : "settings.general.badgeWeb.hint");
/** plan 273: what's said follows the first screen, as the badge does */
const notifyHint = (desktop: boolean, lead: FirstScreen): string =>
  lead === "whatMatters" ? t(desktop ? "settings.general.notify.hintWhatMatters" : "settings.general.notify.hintWhatMattersWeb") : t(desktop ? "settings.general.notify.hint" : "settings.general.notify.hintWeb");

function NotificationsGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const desktop = !!window.ternoDesktop;
  const lead = leadScreen(settings.firstScreen, useApp(todayOffered));
  const page = !desktop && pageNotificationsSupported();
  // the browser's permission, read live: it can change in the site's settings while this is open (Codex code review #10)
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!page) return;
    let status: PermissionStatus | null = null;
    void navigator.permissions
      ?.query({ name: "notifications" as PermissionName })
      .then((s) => {
        status = s;
        s.addEventListener("change", repaint);
      })
      .catch(() => {});
    return () => status?.removeEventListener("change", repaint);
  }, [page]);
  const badge = desktop || badgeSupported();
  if (!desktop && !page && !badge) return null;
  const on = settings.notifications && (desktop || (page && Notification.permission === "granted"));
  const toggle = async (next: boolean) => {
    if (next && page && Notification.permission !== "granted") {
      const answer = await Notification.requestPermission().catch(() => "denied" as const);
      repaint();
      if (answer !== "granted") return void snack.error(t("settings.general.notify.denied"));
    }
    await update({ notifications: next });
    repaint();
  };
  return (
    <SettingsGroup title={t("settings.general.notifications")} testId="notifications-group">
      {(desktop || page) && (
        <SettingsRow find="general.notify" label={t("settings.general.notify")} hint={notifyHint(desktop, lead)} testId="notify-row">
          {(a) => <Switch {...a} data-testid="notify-switch" checked={on} onCheckedChange={(next) => void toggle(next)} />}
        </SettingsRow>
      )}
      {(desktop || page) && (
        <SettingsRow find="general.notifyPreview" label={t("settings.general.notifyPreview")} hint={t("settings.general.notifyPreview.hint")} testId="notify-preview-row">
          {(a) => <Switch {...a} data-testid="notify-preview-switch" disabled={!on} checked={settings.notificationPreview} onCheckedChange={(next) => void update({ notificationPreview: next })} />}
        </SettingsRow>
      )}
      {badge && (
        <SettingsRow find={desktop ? "general.badge" : "general.badgeWeb"} label={badgeLabel(desktop, lead)} hint={badgeHint(desktop, lead)} testId="badge-row">
          {(a) => <Switch {...a} data-testid="badge-switch" checked={settings.dockBadge} onCheckedChange={(next) => void update({ dockBadge: next })} />}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** Language: System (what it resolves to now), then each language by its own name. */
function LanguageRow({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  // a choice made in the open list waits for it to finish closing (re-mounting an open popup breaks
  // Base UI); typing on the closed control (typeahead) applies at once
  const listOpen = useRef(false);
  const chosen = useRef<LanguageSetting | null>(null);
  const system = LOCALES[resolveLocale("system", navigator.languages?.length ? navigator.languages : [navigator.language])].name;
  const items = [{ value: "system", label: t("language.system", { language: system }) }, ...LOCALE_IDS.map((id) => ({ value: id, label: LOCALES[id].name }))];
  // switched here first so focus comes back to this control after the app re-renders in the new language
  const commit = (v: LanguageSetting) =>
    void commitLanguage(v, settings.language, () => update({ language: v }, { quiet: true }), (error) => snack.error(error instanceof Error ? error.message : String(error)), "language-select");
  return (
    <SettingsRow find="general.language" label={t("language.label")} hint={t("language.hint")} testId="language-row">
      {({ id: _id, ...a }) => (
        <Select
          value={settings.language}
          onValueChange={(v) => {
            if (!isLanguageSetting(v) || v === settings.language) return;
            if (listOpen.current) chosen.current = v;
            else commit(v);
          }}
          onOpenChange={(open) => {
            if (!open) return;
            listOpen.current = true;
            chosen.current = null;
          }}
          onOpenChangeComplete={(open) => {
            if (open) return;
            listOpen.current = false;
            const v = chosen.current;
            chosen.current = null;
            if (v) commit(v);
          }}
          items={items}
        >
          <SelectTrigger {...a} id="language-select" size="sm" className="w-44" data-testid="language-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value} data-testid={`language-${item.value}`} lang={item.value === "system" ? undefined : LOCALES[item.value as keyof typeof LOCALES].tag}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </SettingsRow>
  );
}

/** Plan 188: Undo send's windows, in seconds. */
const undoSendChoices = (): { value: UndoSendSeconds; label: string }[] => UNDO_SEND_SECONDS.map((n) => ({ value: n, label: t("settings.general.undoSendTime.seconds", { count: n }) }));

export function GeneralTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  return (
    <div data-testid="general-tab">
      {/* plan 294: remote images went to Appearance → Messages, the sync window to Accounts, Diagnostics to About */}
      <SettingsGroup>
        <LanguageRow settings={settings} update={update} />
      </SettingsGroup>

      {/* plan 278: your word on who is a person; the last one reset, the keys land on the language above */}
      <SettingsGroup title={t("settings.general.people")} testId="people-group" find="general.people">
        <SettingsRow find={false} label={t("settings.general.peopleRules")} hint={t("settings.general.people.hint")} stacked testId="people-rules">
          {(a) => <PersonRulesList testId="people-rules-list" labelledBy={a["aria-labelledby"]} describedBy={a["aria-describedby"]} fallback={() => document.querySelector<HTMLElement>("[data-testid=language-select]")} />}
        </SettingsRow>
      </SettingsGroup>

      <NotificationsGroup settings={settings} update={update} />

      <SettingsGroup title={t("settings.general.writing")}>
        <SettingsRow find="general.suggestions" label={t("settings.general.suggestions")} hint={t("settings.general.suggestions.hint")} testId="suggestions-row">
          {(a) => <Switch {...a} data-testid="suggestions-switch" checked={settings.composeSuggestions} onCheckedChange={(on) => void update({ composeSuggestions: on })} />}
        </SettingsRow>
        <SettingsRow find="general.undoSend" label={t("settings.general.undoSend")} hint={t("settings.general.undoSend.hint", { seconds: settings.undoSendSeconds })} testId="undo-send-row">
          {(a) => <Switch {...a} data-testid="undo-send-switch" checked={settings.undoSend} onCheckedChange={(on) => void update({ undoSend: on })} />}
        </SettingsRow>
        {/* plan 188 (WCAG 2.2.1): the window is the user's; off with Undo send, the row stays and says why (as Preview under Compact) */}
        <SettingsRow find="general.undoSendTime" label={t("settings.general.undoSendTime")} hint={settings.undoSend ? t("settings.general.undoSendTime.hint") : t("settings.general.undoSendTime.offHint")} testId="undo-send-time-row">
          {({ id: _id, ...a }) => (
            <Select value={settings.undoSendSeconds} disabled={!settings.undoSend} onValueChange={(v) => void update({ undoSendSeconds: v as UndoSendSeconds })} items={undoSendChoices()}>
              <SelectTrigger {...a} size="sm" className="w-32" data-testid="undo-send-time">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {undoSendChoices().map((d) => (
                  <SelectItem key={d.value} value={d.value} data-testid={`undo-send-${d.value}`}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
        <SettingsRow find="general.sendSound" label={t("settings.general.sendSound")} hint={t("settings.general.sendSound.hint")} testId="send-sound-row">
          {(a) => <Switch {...a} data-testid="send-sound-switch" checked={settings.sendSound} onCheckedChange={(on) => void update({ sendSound: on })} />}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.keyboard")}>
        {/* plan 188 (WCAG 2.1.4): letters and symbols alone can be turned off; named keys and chords stay */}
        <SettingsRow find="general.characterKeys" label={t("settings.general.characterKeys")} hint={t("settings.general.characterKeys.hint")} testId="character-keys-row">
          {(a) => <Switch {...a} data-testid="character-keys-switch" checked={settings.characterKeys} onCheckedChange={(on) => void update({ characterKeys: on })} />}
        </SettingsRow>
        <SettingsRow find="general.shortcuts" label={t("settings.general.shortcuts")} hint={t("settings.general.shortcuts.hint")}>
          {({ id: _id, "aria-labelledby": _l, ...a }) => (
            <Button {...a} variant="outline" size="sm" data-testid="open-shortcuts" onClick={() => setApp({ dialog: "shortcuts" })}>
              <Keyboard /> {t("settings.general.shortcuts.show")}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      {MacSection && (
        <MacSection />
      )}
    </div>
  );
}

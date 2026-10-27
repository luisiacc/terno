import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Columns2, Keyboard, Rows3 } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { updateAppearance } from "~/lib/appearance";
import { Suspense, useEffect, useReducer, useRef, useState } from "react";
import { isLanguageSetting, LOCALE_IDS, LOCALES, resolveLocale, t, type LanguageSetting } from "@terno/i18n";
import { setApp } from "~/state/app";
import { commitLanguage } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { MacSection } from "~/lib/web-parts";
import { parseSyncWindow, SYNC_WINDOW_MAX, SYNC_WINDOW_MIN } from "~/lib/settings-values";
import { DiagnosticsSection } from "./diagnostics-section";
import { useHasUpdates } from "~/lib/updates";
import { UpdatesSection } from "./updates-section";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";
import { badgeSupported, pageNotificationsSupported } from "~/lib/notify";

const WEB = import.meta.env.VITE_TARGET === "web";

/**
 * A number of days, saved when it is valid (Enter or leaving the field);
 * anything else stays as typed with the reason, announced. A change of the
 * stored value shows in place (the same element: keyboard focus stays).
 */
export function DaysField({
  value,
  onSave,
  a11y,
  testId,
  placeholder,
  allowEmpty,
}: {
  value: number | null;
  /** null: emptied (only with allowEmpty) */
  onSave: (days: number | null) => Promise<void>;
  a11y: { id: string; "aria-describedby"?: string };
  testId?: string;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const errorId = `${a11y.id}-days-error`;
  const [text, setText] = useState(value === null ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  // the stored value changed: show it in the same element (keyboard focus stays)
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    // unless what is in the field is an edit of its own, typed since
    if (text === (shown === null ? "" : String(shown))) {
      setText(value === null ? "" : String(value));
      setError(null);
    }
  }
  const commit = async () => {
    if (allowEmpty && text.trim() === "") {
      setError(null);
      if (value !== null) await onSave(null).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    const r = parseSyncWindow(text);
    if ("error" in r) return setError(r.error);
    setError(null);
    if (r.days === value) return;
    try {
      await onSave(r.days);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Input
          {...a11y}
          type="number"
          inputMode="numeric"
          min={SYNC_WINDOW_MIN}
          max={SYNC_WINDOW_MAX}
          step={1}
          className="h-7 w-20 text-right tabular-nums"
          data-testid={testId}
          value={text}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={[a11y["aria-describedby"], error ? errorId : null].filter(Boolean).join(" ") || undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && void commit()}
        />
        {t("settings.days")}
      </span>
      {error && (
        <span id={errorId} role="alert" className="text-xs text-destructive-ink" data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </span>
      )}
    </span>
  );
}

const density = () =>
  [
    { value: "comfortable", label: t("settings.general.density.comfortable") },
    { value: "compact", label: t("settings.general.density.compact") },
  ] as const;

/**
 * Plan 38: system notifications, their preview, and the unread count on the
 * Dock (desktop) or the installed app's icon (a browser that has it). In a
 * browser the switch reads on only with the permission granted, and turning
 * it on asks inside the click.
 */
function NotificationsGroup({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const desktop = !!window.ternoDesktop;
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
        <SettingsRow label={t("settings.general.notify")} hint={t(desktop ? "settings.general.notify.hint" : "settings.general.notify.hintWeb")} testId="notify-row">
          {(a) => <Switch {...a} data-testid="notify-switch" checked={on} onCheckedChange={(next) => void toggle(next)} />}
        </SettingsRow>
      )}
      {(desktop || page) && (
        <SettingsRow label={t("settings.general.notifyPreview")} hint={t("settings.general.notifyPreview.hint")} testId="notify-preview-row">
          {(a) => <Switch {...a} data-testid="notify-preview-switch" disabled={!on} checked={settings.notificationPreview} onCheckedChange={(next) => void update({ notificationPreview: next })} />}
        </SettingsRow>
      )}
      {badge && (
        <SettingsRow label={t(desktop ? "settings.general.badge" : "settings.general.badgeWeb")} hint={t(desktop ? "settings.general.badge.hint" : "settings.general.badgeWeb.hint")} testId="badge-row">
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
    <SettingsRow label={t("language.label")} hint={t("language.hint")} testId="language-row">
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

export function GeneralTab({ settings, update, onLocalOff }: { settings: AppSettings; update: SettingsUpdate; onLocalOff: () => void }) {
  const updates = useHasUpdates();
  return (
    <div data-testid="general-tab">
      <SettingsGroup>
        <SettingsRow
          testId="local-mode-row"
          label={t("settings.general.localMode")}
          hint={
            WEB ? t("settings.general.localMode.hintWeb") : settings.localMode && settings.senderIcons ? t("settings.general.localMode.hintIcons") : t("settings.general.localMode.hint")
          }
        >
          {(a) => <Switch {...a} data-testid="local-mode-switch" checked={settings.localMode} onCheckedChange={(on) => (on ? void update({ localMode: true }) : onLocalOff())} />}
        </SettingsRow>
        {/* plan 37: the same in both modes; local mode doesn't decide remote images */}
        <SettingsRow label={t("settings.general.remoteImages")} hint={t(settings.remoteImages === "always" ? "settings.general.remoteImages.hintOn" : "settings.general.remoteImages.hint")}>
          {(a) => <Switch {...a} data-testid="remote-images-switch" checked={settings.remoteImages === "always"} onCheckedChange={(on) => void update({ remoteImages: on ? "always" : "ask" })} />}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <LanguageRow settings={settings} update={update} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.list")}>
        {/* plan 24: the conversation beside the list, or in its place (applied at once, like the style) */}
        <SettingsRow label={t("settings.general.layout")} hint={t("settings.general.layout.hint")} testId="layout-row">
          {(a) => (
            <ToggleGroup
              aria-labelledby={a["aria-labelledby"]}
              aria-describedby={a["aria-describedby"]}
              variant="outline"
              size="sm"
              value={[settings.layout]}
              onValueChange={(v: string[]) => v[0] && void updateAppearance({ layout: v[0] as AppSettings["layout"] })}
              data-testid="layout-toggle"
            >
              <ToggleGroupItem value="split" data-testid="layout-split" className="gap-1.5">
                <Columns2 aria-hidden />
                {t("settings.general.layout.split")}
              </ToggleGroupItem>
              <ToggleGroupItem value="list" data-testid="layout-list" className="gap-1.5">
                <Rows3 aria-hidden />
                {t("settings.general.layout.list")}
              </ToggleGroupItem>
            </ToggleGroup>
          )}
        </SettingsRow>
        <SettingsRow label={t("settings.general.density")} hint={t("settings.general.density.hint")}>
          {({ id: _id, ...a }) => (
            <Select value={settings.density} onValueChange={(v) => void update({ density: v as AppSettings["density"] })} items={density().map((d) => ({ ...d }))}>
              <SelectTrigger {...a} size="sm" className="w-32" data-testid="density-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {density().map((d) => (
                  <SelectItem key={d.value} value={d.value} data-testid={`density-${d.value}`}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.sync")}>
        <SettingsRow labelFor label={t("settings.general.syncWindow")} hint={t("settings.general.syncWindow.hint")}>
          {(a) => <DaysField a11y={a} testId="sync-window" value={settings.syncWindowDays} onSave={(days) => update({ syncWindowDays: days ?? settings.syncWindowDays }, { quiet: true })} />}
        </SettingsRow>
      </SettingsGroup>

      <NotificationsGroup settings={settings} update={update} />

      <SettingsGroup title={t("settings.general.writing")}>
        <SettingsRow label={t("settings.general.suggestions")} hint={t("settings.general.suggestions.hint")} testId="suggestions-row">
          {(a) => <Switch {...a} data-testid="suggestions-switch" checked={settings.composeSuggestions} onCheckedChange={(on) => void update({ composeSuggestions: on })} />}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.keyboard")}>
        <SettingsRow label={t("settings.general.shortcuts")} hint={t("settings.general.shortcuts.hint")}>
          {({ id: _id, "aria-labelledby": _l, ...a }) => (
            <Button {...a} variant="outline" size="sm" data-testid="open-shortcuts" onClick={() => setApp({ dialog: "shortcuts" })}>
              <Keyboard /> {t("settings.general.shortcuts.show")}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      {updates && <UpdatesSection />}

      <DiagnosticsSection settings={settings} update={update} />

      {MacSection && (
        <Suspense>
          <MacSection />
        </Suspense>
      )}
    </div>
  );
}

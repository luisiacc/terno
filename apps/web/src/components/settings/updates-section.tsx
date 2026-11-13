import type { UpdateChannel, UpdateState } from "@terno/core/updates";
import { localeTag, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Progress } from "@terno/ui/components/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Spinner } from "@terno/ui/components/spinner";
import { Switch } from "@terno/ui/components/switch";
import { ArrowDown, CircleCheck, ExternalLink, Info, RotateCw, TriangleAlert } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatBytes } from "~/lib/format";
import { openLink } from "~/lib/open-link";
import { TERNO_LINKS } from "~/lib/terno-links";
import { aboutStatus, checkForUpdates, downloadUpdate, errorText, installUpdate, openReleaseNotes, setUpdatePrefs, unsupportedText, updateNow, useUpdates, type AboutStatus } from "~/lib/updates";
import { SettingsGroup, SettingsRow } from "./parts";

const CHANNELS = [
  { value: "stable", label: "updates.settings.stable" },
  { value: "nightly", label: "updates.settings.nightly" },
] as const;

/** "5 minutes ago", "yesterday": when the last check answered. */
function ago(at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: "auto" });
  const s = Math.round((at - now) / 1000);
  if (Math.abs(s) < 60) return t("updates.settings.justNow");
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, "hour");
  return rtf.format(Math.round(h / 24), "day");
}

function channelHint(state: UpdateState): string {
  // Squirrel can't unstage an update: it installs first, on the channel it came from
  if (state.ready) return t("updates.settings.readyChannel", { version: state.ready.version });
  return t(state.channel === "nightly" ? "updates.settings.nightlyHint" : "updates.settings.stableHint");
}

/** An update's size and date, when the feed gave them. */
function meta(update: { size: number | null; releaseDate: string | null }): string {
  const date = update.releaseDate ? new Date(update.releaseDate).toLocaleDateString(localeTag(), { month: "short", day: "numeric", year: "numeric" }) : null;
  return [update.size ? formatBytes(update.size) : null, date].filter(Boolean).join(" · ");
}

/** The status's words: a title and the line under it. */
function words(status: AboutStatus): { title: string; detail: string } {
  switch (status.kind) {
    case "idle":
      return { title: status.checkedAt ? t("about.status.idleChecked", { time: ago(status.checkedAt) }) : t("about.status.idle"), detail: t("about.status.background") };
    case "up-to-date":
      return { title: t("about.status.upToDate"), detail: status.checkedAt ? t("updates.settings.lastChecked", { time: ago(status.checkedAt) }) : t("updates.settings.notChecked") };
    case "checking":
      return { title: t("about.status.checking"), detail: t("about.status.background") };
    case "available":
      return { title: t("about.status.available", { version: status.update.version }), detail: meta(status.update) || t("updates.popover.available") };
    case "downloading":
      return { title: t("about.status.downloading", { version: status.version }), detail: "" };
    case "verifying":
      return { title: t("about.status.verifying", { version: status.version }), detail: t("updates.verifying") };
    case "ready":
      if (status.installing) return { title: t("about.status.installing"), detail: t("about.status.ready", { version: status.update.version }) };
      if (status.deferred) return { title: t("about.status.waiting"), detail: t("updates.popover.deferred") };
      // a Restart that was refused says why (unsaved drafts), the update still staged
      return { title: t("about.status.ready", { version: status.update.version }), detail: status.refused ? errorText(status.refused) : t("about.status.readyHint") };
    case "required":
      if (status.unsupported) return { title: t("updates.pill.required"), detail: unsupportedText(status.unsupported) };
      return { title: t("updates.pill.required"), detail: status.refused ? errorText(status.refused) : t("updates.required.consent") };
    case "error":
      return { title: t(`about.status.failed.${status.stage}`), detail: errorText(status.error) };
    case "unsupported":
      return { title: t("about.status.unsupported"), detail: unsupportedText(status.reason) };
  }
}

/** A 16 px glyph for the state, in the leading column (decorative: the title says it). */
function Glyph({ status }: { status: AboutStatus }) {
  const k = status.kind;
  if (k === "checking" || k === "verifying" || (k === "ready" && (status.deferred || status.installing)) || (k === "required" && status.working)) return <Spinner aria-hidden />;
  if (k === "up-to-date") return <CircleCheck aria-hidden className="size-4 text-success-ink" />;
  if (k === "available" || k === "downloading" || k === "required") return <ArrowDown aria-hidden className="size-4 text-primary" />;
  if (k === "ready") return <RotateCw aria-hidden className="size-4 text-primary" />;
  if (k === "error") return <TriangleAlert aria-hidden className="size-4 text-destructive-ink" />;
  return <Info aria-hidden className="size-4 text-muted-foreground" />;
}

/**
 * Plan 190: About's update row (desktop): whether Terno is current, what is pending, and the one action that state
 * allows: Check for Updates, Download, Restart to Update, Try Again. The same calls the sidebar pill's popover makes,
 * so the two are one flow. `lead` is the leading column's class, shared with the row above so the text lines up.
 */
export function UpdateStatusRow({ state, lead }: { state: UpdateState; lead: string }) {
  const [busy, setBusy] = useState(false);
  const checkFailed = useUpdates((s) => s.checkFailed);
  const status = aboutStatus(state, { checkFailed });
  const statusRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  /**
   * A control in the row had focus last: when the state takes it away (Download → the bar, What's New → a check),
   * focus stays in the row, on its words.
   * Read from focusin (a removed element fires no reliable blur); a disabled action stays focusable (focusableWhenDisabled).
   */
  const focused = useRef(false);
  useEffect(() => {
    const track = (e: FocusEvent) => void (focused.current = rowRef.current?.contains(e.target as Node) ?? false);
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);
  const { title, detail } = words(status);
  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  const update = status.kind === "available" || status.kind === "ready" ? status.update : null;
  const action = (() => {
    switch (status.kind) {
      case "available":
        return (
          <Button size="sm" focusableWhenDisabled disabled={busy} onClick={() => act(downloadUpdate)} data-testid="updates-download">
            {t("updates.download")}
          </Button>
        );
      case "ready":
        return (
          <Button size="sm" focusableWhenDisabled disabled={busy || status.deferred || status.installing} onClick={() => act(installUpdate)} data-testid="updates-restart">
            {t("updates.pill.restart")}
          </Button>
        );
      case "required":
        return status.unsupported ? (
          <Button size="sm" onClick={() => openLink(TERNO_LINKS.latest)} data-testid="updates-download-page">
            {t("updates.required.downloadPage")}
          </Button>
        ) : (
          <Button size="sm" focusableWhenDisabled disabled={busy || status.working} onClick={() => act(updateNow)} data-testid="updates-now">
            {t("updates.required.action")}
          </Button>
        );
      case "error":
        return (
          <Button size="sm" variant="outline" focusableWhenDisabled disabled={busy} onClick={() => act(status.retry === "download" ? downloadUpdate : checkForUpdates)} data-testid="updates-retry">
            {t("updates.tryAgain")}
          </Button>
        );
      case "downloading":
      case "verifying":
        return null;
      default:
        return (
          <Button size="sm" variant="outline" focusableWhenDisabled disabled={status.kind === "unsupported"} loading={busy || status.kind === "checking"} onClick={() => act(checkForUpdates)} data-testid="updates-check">
            {t("about.check")}
          </Button>
        );
    }
  })();
  // every render: a cheap look at whether the focused control just left the row
  useLayoutEffect(() => {
    if (!focused.current || rowRef.current?.contains(document.activeElement)) return;
    focused.current = false;
    if (document.activeElement === document.body || document.activeElement === null) statusRef.current?.focus({ preventScroll: true });
  });
  return (
    <div ref={rowRef} className="flex min-h-14 items-center gap-3 py-3" data-testid="updates-status-row" data-state={status.kind}>
      <span className={cn(lead, "flex items-center justify-center self-start pt-0.5")}>
        <Glyph status={status} />
      </span>
      <div className="min-w-0 flex-1">
        {/* the result of a check is heard where it is shown; the bar's percent isn't (it would talk four times a second) */}
        <div ref={statusRef} tabIndex={-1} role="status" data-testid="updates-status" className="outline-none">
          <p className="text-sm font-medium" data-testid="updates-status-title">
            {title}
          </p>
          {detail && <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{detail}</p>}
        </div>
        {status.kind === "downloading" && (
          <div className="mt-2 flex max-w-72 items-center gap-2.5" data-testid="updates-progress">
            <Progress value={status.percent} aria-label={title} aria-valuetext={`${status.percent}%`} className="flex-1" />
            <span aria-hidden className="w-8 text-right text-xs text-muted-foreground tabular-nums">
              {status.percent}%
            </span>
          </div>
        )}
        {update && (
          <Button variant="link-secondary" className="mt-1.5 text-xs" onClick={() => openReleaseNotes(update.version)} data-testid="updates-whats-new">
            {t("updates.whatsNewIn", { version: update.version })}
            <ExternalLink data-icon="inline-end" aria-hidden className="text-muted-foreground" />
          </Button>
        )}
      </div>
      {action && (
        <div className="flex shrink-0 items-center gap-2">
          {action}
        </div>
      )}
    </div>
  );
}

/** Settings → About → Updates (desktop): how updates come, and from which channel. */
export function UpdatePrefsGroup({ state }: { state: UpdateState }) {
  const unsupported = state.status === "unsupported";
  const mode = state.mode === "auto" ? "updates.settings.autoHint" : "updates.settings.manualHint";
  const modeHint = `${t(mode)} ${t("updates.settings.where")}`;
  return (
    <SettingsGroup title={t("updates.settings.title")} testId="updates-section">
      <SettingsRow find="about.autoUpdate" label={t("updates.settings.auto")} hint={modeHint} testId="updates-mode-row">
        {(a) => (
          <Switch
            {...a}
            data-testid="updates-auto-switch"
            disabled={unsupported}
            checked={state.mode === "auto"}
            onCheckedChange={(on) => void setUpdatePrefs({ mode: on ? "auto" : "manual", channel: state.channel })}
          />
        )}
      </SettingsRow>
      <SettingsRow find="about.channel" label={t("updates.settings.channel")} hint={<span data-testid="updates-channel-hint">{channelHint(state)}</span>}>
        {({ id: _id, ...a }) => (
          <Select value={state.channel} disabled={unsupported || state.ready !== null} onValueChange={(v) => void setUpdatePrefs({ mode: state.mode, channel: v as UpdateChannel })} items={CHANNELS.map((c) => ({ value: c.value, label: t(c.label) }))}>
            <SelectTrigger {...a} size="sm" className="w-32" data-testid="updates-channel-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNELS.map((c) => (
                <SelectItem key={c.value} value={c.value} data-testid={`updates-channel-${c.value}`}>
                  {t(c.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

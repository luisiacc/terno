import type { UpdateChannel, UpdateState } from "@terno/core/updates";
import { Button } from "@terno/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { checkForUpdates, errorText, setUpdatePrefs, unsupportedText, useUpdates } from "~/lib/updates";
import { SettingsGroup, SettingsRow } from "./parts";

const CHANNELS = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
] as const;

/** "5 minutes ago", "yesterday": when the last check answered. */
function ago(at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const s = Math.round((at - now) / 1000);
  if (Math.abs(s) < 60) return "just now";
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, "hour");
  return rtf.format(Math.round(h / 24), "day");
}

function statusLine(state: UpdateState): string {
  if (state.status === "unsupported" && state.unsupported) return unsupportedText(state.unsupported);
  if (state.ready) return `Terno ${state.ready.version} is ready: it installs when Terno restarts.`;
  if (state.status === "downloading") return `Downloading Terno ${state.available?.version ?? ""} (${state.percent ?? 0}%)…`;
  if (state.status === "verifying") return "Checking the download’s signature…";
  if (state.status === "available" && state.available) return `Terno ${state.available.version} is available.`;
  if (state.error) return errorText(state.error.kind);
  const checked = state.checkedAt ? `Last checked ${ago(state.checkedAt)}.` : "Not checked yet.";
  return state.status === "up-to-date" ? `Terno is up to date. ${checked}` : checked;
}

/** Settings → General → Updates (desktop): how updates come, from which channel, and a check now. */
export function UpdatesSection() {
  const state = useUpdates((s) => s.state);
  const [checking, setChecking] = useState(false);
  if (!state) return null;
  const unsupported = state.status === "unsupported";
  const where = "Updates come from GitHub (github.com) and nowhere else.";
  const modeHint = state.localMode
    ? `Local mode is on: Terno checks and downloads only when you ask. ${where}`
    : state.mode === "auto"
      ? `New versions download in the background and install when Terno restarts. ${where}`
      : `Terno tells you when there’s a new version; you choose when to download it. ${where}`;
  return (
    <SettingsGroup
      title="Updates"
      testId="updates-section"
      footer={
        <span data-testid="updates-version" className="tabular-nums select-text">
          Terno {state.current}
        </span>
      }
    >
      <SettingsRow label="Download updates automatically" hint={modeHint} testId="updates-mode-row">
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
      <SettingsRow label="Channel" hint={state.channel === "nightly" ? "Nightly builds get changes first and can be rough. Back on Stable, Terno waits for the next stable release instead of going back." : "Tested releases."}>
        {({ id: _id, ...a }) => (
          <Select value={state.channel} disabled={unsupported} onValueChange={(v) => void setUpdatePrefs({ mode: state.mode, channel: v as UpdateChannel })} items={CHANNELS.map((c) => ({ ...c }))}>
            <SelectTrigger {...a} size="sm" className="w-32" data-testid="updates-channel-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNELS.map((c) => (
                <SelectItem key={c.value} value={c.value} data-testid={`updates-channel-${c.value}`}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
      <SettingsRow label="Check for updates" hint={<span data-testid="updates-status">{statusLine(state)}</span>}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <Button
            {...a}
            variant="outline"
            size="sm"
            data-testid="updates-check"
            disabled={unsupported || checking || state.status === "checking" || state.status === "downloading" || state.status === "installing"}
            onClick={() => {
              setChecking(true);
              void checkForUpdates().finally(() => setChecking(false));
            }}
          >
            {(checking || state.status === "checking") && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            Check Now
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

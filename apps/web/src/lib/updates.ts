import type { UnsupportedReason, UpdateChannel, UpdateErrorKind, UpdateErrorStage, UpdateInfo, UpdateMode, UpdateState } from "@terno/core/updates";
import { t, type TextKey } from "@terno/i18n";
import { create } from "zustand";
import { openLink } from "~/lib/open-link";
import { snack } from "~/lib/snack";
import { releaseNotesUrl } from "~/lib/terno-links";
import { useWeb } from "~/web/lifecycle";

/**
 * In-app updates in the renderer. Desktop: main owns the state, the policy
 * and the install (apps/desktop/src/updates); this mirrors its state and
 * asks. Web: a new deployment waiting in the service worker (web/connect.ts)
 * feeds the same pill. Nothing here polls: main pushes, the page listens.
 */

let bridge = typeof window === "undefined" ? undefined : window.ternoDesktop?.updates;

interface UpdatesStore {
  state: UpdateState | null;
  /** "Later": the accent goes quiet until the next launch (the pill stays) */
  later: boolean;
  /** this shell has the updater (state, not a call: the React Compiler caches pure-looking calls) */
  available: boolean;
  /** the last manual check never reached main (the state it left is stale): About says so until main's next state */
  checkFailed: boolean;
}

export const useUpdates = create<UpdatesStore>(() => ({ state: null, later: false, available: Boolean(bridge), checkFailed: false }));

let started = false;

/** Desktop: the first state, then every one main pushes. Idempotent. */
export function startUpdates(): void {
  if (started || !bridge) return;
  started = true;
  bridge.onState((state) => adopt(state));
  void bridge.state().then((state) => state && adopt(state));
}

function adopt(state: UpdateState): void {
  const was = useUpdates.getState().state;
  useUpdates.setState({ state, checkFailed: false });
  if (state.justUpdated && was?.justUpdated !== state.justUpdated) {
    const version = state.justUpdated;
    snack.success(t("updates.updated", { version }), {
      id: "updated",
      background: true,
      duration: 8000,
      secondary: { label: t("updates.whatsNew"), name: t("updates.whatsNewIn", { version }), onClick: () => openReleaseNotes(version) },
    });
    bridge?.seen();
  }
}

export function openReleaseNotes(version: string): void {
  openLink(releaseNotesUrl(version));
}

/** What the sidebar pill shows, from the state (pure: unit-tested). */
export type PillModel =
  | { kind: "hidden" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "verifying"; version: string }
  | { kind: "ready"; version: string; deferred: boolean; quiet: boolean }
  | { kind: "error"; stage: "download" | "verify" | "install" }
  /** plan 95: below the feed's minimum (the window is covered once drafts are saved; until then, this) */
  | { kind: "required"; version: string }
  | { kind: "web" };

export function pillModel(state: UpdateState | null, o: { later: boolean; webUpdate: boolean }): PillModel {
  if (o.webUpdate) return { kind: "web" };
  if (!state) return { kind: "hidden" };
  if (state.required) return { kind: "required", version: state.required };
  // a ready update wins over anything a later check or download is doing
  if (state.ready && state.status !== "installing") return { kind: "ready", version: state.ready.version, deferred: state.deferred === "sending", quiet: o.later };
  if (state.status === "installing" && state.ready) return { kind: "ready", version: state.ready.version, deferred: false, quiet: false };
  if (state.status === "downloading" && state.available) return { kind: "downloading", version: state.available.version, percent: state.percent ?? 0 };
  if (state.status === "verifying" && state.available) return { kind: "verifying", version: state.available.version };
  // a failed download or install is worth a word in the sidebar; a failed check isn't (Settings says it)
  if (state.error && state.error.stage !== "check" && (state.error.kind === "not-applied" || state.available)) return { kind: "error", stage: state.error.stage };
  if (state.status === "available" && state.available) return { kind: "available", version: state.available.version };
  return { kind: "hidden" };
}

/**
 * Plan 190: Settings → About's update row, from the state (pure: unit-tested). Unlike the pill it always has
 * something to say (up to date, when it last looked, why it can't), and the action is the one that state allows.
 */
export type AboutStatus =
  | { kind: "idle"; checkedAt: number | null }
  | { kind: "up-to-date"; checkedAt: number | null }
  | { kind: "checking" }
  | { kind: "available"; update: UpdateInfo }
  /** the version is the download's own (`target`): a later offer doesn't rename it */
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "verifying"; version: string }
  /** installing: the restart is under way; deferred: it waits for a send; refused: why the last Restart didn't happen */
  | { kind: "ready"; update: UpdateInfo; deferred: boolean; installing: boolean; refused: UpdateErrorKind | null }
  /** plan 95; a copy that can't update itself is sent to the download page instead; refused: why the last install didn't happen */
  | { kind: "required"; version: string; working: boolean; unsupported: UnsupportedReason | null; refused: UpdateErrorKind | null }
  /** retry: what Try Again does (a failed install or a failed check looks again; a failed download downloads again) */
  | { kind: "error"; stage: UpdateErrorStage; error: UpdateErrorKind; retry: "check" | "download" }
  | { kind: "unsupported"; reason: UnsupportedReason };

export function aboutStatus(state: UpdateState, o: { checkFailed?: boolean } = {}): AboutStatus {
  const unsupported = state.status === "unsupported" ? (state.unsupported ?? "dev") : null;
  const refused = state.error?.stage === "install" ? state.error.kind : null;
  if (state.required) return { kind: "required", version: state.required, working: state.updatingNow, unsupported, refused };
  if (unsupported) return { kind: "unsupported", reason: unsupported };
  // a ready update wins over anything a later check or download is doing (as in the pill)
  if (state.ready) {
    return { kind: "ready", update: state.ready, deferred: state.deferred === "sending", installing: state.status === "installing", refused };
  }
  // the last check never reached main: whatever the state said before it (checking, an older error) is stale; main's next state clears it
  if (o.checkFailed) return { kind: "error", stage: "check", error: "unknown", retry: "check" };
  const inFlight = state.target ?? state.available;
  if (state.status === "downloading" && inFlight) return { kind: "downloading", version: inFlight.version, percent: state.percent ?? 0 };
  if (state.status === "verifying" && inFlight) return { kind: "verifying", version: inFlight.version };
  if (state.status === "checking") return { kind: "checking" };
  // a failed download or verification settles back on the offer, the error kept beside it
  if (state.error) {
    const download = (state.error.stage === "download" || state.error.stage === "verify") && state.available !== null;
    return { kind: "error", stage: state.error.stage, error: state.error.kind, retry: download ? "download" : "check" };
  }
  if (state.status === "available" && state.available) return { kind: "available", update: state.available };
  if (state.status === "up-to-date") return { kind: "up-to-date", checkedAt: state.checkedAt };
  return { kind: "idle", checkedAt: state.checkedAt };
}

export function usePill(): PillModel {
  const state = useUpdates((s) => s.state);
  const later = useUpdates((s) => s.later);
  const webUpdate = useWeb((s) => s.update !== null);
  return pillModel(state, { later, webUpdate });
}

export function updateLater(): void {
  useUpdates.setState({ later: true });
}

/** "Check for Updates…" (menu, ⌘K, Settings): the result as a snack. */
export async function checkForUpdates(): Promise<void> {
  if (!bridge) return;
  const id = snack.loading(t("updates.checking"), { id: "update-check" });
  let state: UpdateState | null = null;
  try {
    state = await bridge.check();
  } catch {
    state = null;
  }
  useUpdates.setState(state ? { state, checkFailed: false } : { checkFailed: true });
  const said = checkResult(state);
  if (said.tone === "error") snack.error(said.message, { id, description: said.description, action: { label: t("updates.tryAgain"), onClick: () => void checkForUpdates() } });
  else if (said.tone === "success") snack.success(said.message, { id, description: said.description });
  else snack(said.message, { id, description: said.description });
}

/** What a manual check found, in words (pure: unit-tested). */
export function checkResult(state: UpdateState | null): { tone: "success" | "neutral" | "error"; message: string; description?: string } {
  if (!state) return { tone: "error", message: t("updates.check.failed"), description: t("updates.error.unknown") };
  if (state.status === "unsupported" && state.unsupported) return { tone: "neutral", message: t("updates.check.unsupported"), description: unsupportedText(state.unsupported) };
  if (state.ready) return { tone: "success", message: t("updates.check.ready", { version: state.ready.version }), description: t("updates.check.readyHint") };
  if (state.status === "downloading" || state.status === "verifying") return { tone: "neutral", message: t("updates.check.downloading", { version: state.available?.version ?? "" }).replace("  ", " ") };
  if (state.status === "available" && state.available) return { tone: "success", message: t("updates.check.available", { version: state.available.version }), description: t("updates.check.availableHint") };
  if (state.status === "error" && state.error) return { tone: "error", message: t("updates.check.failed"), description: errorText(state.error.kind) };
  return { tone: "success", message: t("updates.check.upToDate"), description: t("updates.check.latest", { version: state.current }) };
}

const UNSUPPORTED = {
  dev: "updates.unsupported.dev",
  unsigned: "updates.unsupported.unsigned",
  translated: "updates.unsupported.translated",
  dmg: "updates.unsupported.location",
  translocated: "updates.unsupported.location",
  "read-only": "updates.unsupported.location",
  "not-writable": "updates.unsupported.location",
} as const satisfies Record<UnsupportedReason, TextKey>;

export function unsupportedText(reason: UnsupportedReason): string {
  return t(UNSUPPORTED[reason] ?? "updates.unsupported.location");
}

const ERRORS = {
  unsaved: "updates.error.unsaved",
  offline: "updates.error.offline",
  server: "updates.error.server",
  integrity: "updates.error.integrity",
  disk: "updates.error.disk",
  blocked: "updates.error.blocked",
  "not-applied": "updates.error.notApplied",
  unknown: "updates.error.unknown",
} as const satisfies Record<UpdateErrorKind, TextKey>;

export function errorText(kind: UpdateErrorKind): string {
  return t(ERRORS[kind] ?? "updates.error.unknown");
}

/** Plan 95's "Update Terno": a check if needed, the download, then the restart (main runs the whole of it). */
export async function updateNow(): Promise<void> {
  if (!bridge?.updateNow) return;
  const state = await bridge.updateNow().catch(() => null);
  if (state) useUpdates.setState({ state });
}

export async function downloadUpdate(): Promise<void> {
  const state = await bridge?.download().catch(() => null);
  if (state) useUpdates.setState({ state });
}

/** "Restart Now": main flushes every window's drafts, closes the backend and lets Squirrel relaunch. */
export async function installUpdate(): Promise<void> {
  const state = await bridge?.install().catch(() => null);
  if (state) useUpdates.setState({ state });
}

export async function setUpdatePrefs(prefs: { mode: UpdateMode; channel: UpdateChannel }): Promise<void> {
  const state = await bridge?.setPrefs(prefs).catch(() => null);
  if (state) useUpdates.setState({ state });
}

/** Desktop shells with the updater (the web has its own pill, an older shell none). */
export const useHasUpdates = (): boolean => useUpdates((s) => s.available);

/** e2e (render-probe builds): a stand-in for main, so the pill and Settings can be driven through every state. */
export function setBridgeForTests(fake: NonNullable<typeof bridge>): void {
  bridge = fake;
  started = false;
  useUpdates.setState({ available: true });
  startUpdates();
}

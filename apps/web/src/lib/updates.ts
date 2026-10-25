import type { UpdateChannel, UpdateMode, UpdateState } from "@terno/core/updates";
import { create } from "zustand";
import { snack } from "~/lib/snack";
import { useWeb } from "~/web/lifecycle";

/**
 * In-app updates in the renderer. Desktop: main owns the state, the policy
 * and the install (apps/desktop/src/updates); this mirrors its state and
 * asks. Web: a new deployment waiting in the service worker (web/connect.ts)
 * feeds the same pill. Nothing here polls: main pushes, the page listens.
 */

const bridge = typeof window === "undefined" ? undefined : window.ternoDesktop?.updates;

interface UpdatesStore {
  state: UpdateState | null;
  /** "Later": the accent goes quiet until the next launch (the pill stays) */
  later: boolean;
}

export const useUpdates = create<UpdatesStore>(() => ({ state: null, later: false }));

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
  useUpdates.setState({ state });
  if (state.justUpdated && was?.justUpdated !== state.justUpdated) {
    const version = state.justUpdated;
    snack.success(`Terno updated to ${version}`, {
      id: "updated",
      background: true,
      duration: 8000,
      secondary: { label: "What’s New", name: `What’s new in Terno ${version}`, onClick: () => openReleaseNotes(version) },
    });
    bridge?.seen();
  }
}

export function openReleaseNotes(version: string): void {
  window.ternoDesktop?.openExternal(`https://github.com/luisiacc/terno/releases/tag/v${encodeURIComponent(version)}`);
}

/** What the sidebar pill shows, from the state (pure: unit-tested). */
export type PillModel =
  | { kind: "hidden" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "verifying"; version: string }
  | { kind: "ready"; version: string; deferred: boolean; quiet: boolean }
  | { kind: "error"; stage: "download" | "verify" | "install" }
  | { kind: "web" };

export function pillModel(state: UpdateState | null, o: { later: boolean; webUpdate: boolean }): PillModel {
  if (o.webUpdate) return { kind: "web" };
  if (!state) return { kind: "hidden" };
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
  const id = snack.loading("Checking for updates…", { id: "update-check" });
  let state: UpdateState | null = null;
  try {
    state = await bridge.check();
  } catch {
    state = null;
  }
  if (state) useUpdates.setState({ state });
  const said = checkResult(state);
  if (said.tone === "error") snack.error(said.message, { id, description: said.description, action: { label: "Try Again", onClick: () => void checkForUpdates() } });
  else if (said.tone === "success") snack.success(said.message, { id, description: said.description });
  else snack(said.message, { id, description: said.description });
}

/** What a manual check found, in words (pure: unit-tested). */
export function checkResult(state: UpdateState | null): { tone: "success" | "neutral" | "error"; message: string; description?: string } {
  if (!state) return { tone: "error", message: "Couldn’t check for updates", description: "Something went wrong. Try again in a moment." };
  if (state.status === "unsupported" && state.unsupported) return { tone: "neutral", message: "This copy of Terno can’t update itself", description: unsupportedText(state.unsupported) };
  if (state.ready) return { tone: "success", message: `Terno ${state.ready.version} is ready`, description: "Restart Terno to finish updating." };
  if (state.status === "downloading" || state.status === "verifying") return { tone: "neutral", message: `Downloading Terno ${state.available?.version ?? ""}…`.replace("  ", " ") };
  if (state.status === "available" && state.available) return { tone: "success", message: `Terno ${state.available.version} is available`, description: "Download it from the update button in the sidebar." };
  if (state.status === "error" && state.error) return { tone: "error", message: "Couldn’t check for updates", description: errorText(state.error.kind) };
  return { tone: "success", message: "Terno is up to date", description: `You have the latest version (${state.current}).` };
}

export function unsupportedText(reason: NonNullable<UpdateState["unsupported"]>): string {
  switch (reason) {
    case "dev":
      return "Updates are off in development builds.";
    case "unsigned":
      return "This build isn’t signed, so macOS won’t let it update itself. Download new versions from the releases page.";
    case "translated":
      return "This is the Intel build running on Apple silicon. Download the Apple silicon version to get updates.";
    default:
      return "Move Terno to Applications to get updates.";
  }
}

export function errorText(kind: NonNullable<UpdateState["error"]>["kind"]): string {
  switch (kind) {
    case "offline":
      return "Terno couldn’t reach GitHub. Check your connection and try again.";
    case "server":
      return "GitHub didn’t answer as expected. Try again later.";
    case "integrity":
      return "The download didn’t match what was published, so Terno discarded it. Try again.";
    case "disk":
      return "Terno couldn’t save the download. Check that your disk has space.";
    case "blocked":
      return "The request was stopped before it left this Mac.";
    case "not-applied":
      return "The update didn’t install. Terno is still on the previous version.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
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

export const UPDATES_AVAILABLE = Boolean(bridge);

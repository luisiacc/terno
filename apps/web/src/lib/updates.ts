import type { UnsupportedReason, UpdateChannel, UpdateErrorKind, UpdateMode, UpdateState } from "@terno/core/updates";
import { t, type TextKey } from "@terno/i18n";
import { create } from "zustand";
import { snack } from "~/lib/snack";
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
}

export const useUpdates = create<UpdatesStore>(() => ({ state: null, later: false, available: Boolean(bridge) }));

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
  const id = snack.loading(t("updates.checking"), { id: "update-check" });
  let state: UpdateState | null = null;
  try {
    state = await bridge.check();
  } catch {
    state = null;
  }
  if (state) useUpdates.setState({ state });
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

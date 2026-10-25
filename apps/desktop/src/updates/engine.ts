/**
 * electron-updater and Squirrel.Mac, behind a small surface. Its own bundle
 * (dist/updater.cjs, ~250 KB): main requires it only once the updater has
 * work to do, never on the startup path. (electron-updater pulls in
 * graceful-fs, which patches fs.close process-wide; harmless.)
 *
 * - Every request goes through an isolated session (persist:terno-updater):
 *   no cookies or credentials go out or come back, the renderer's session
 *   and its local-mode fence are untouched, and each request (redirects
 *   included, they come back through here) must pass `allowed`.
 * - The zip's sha512 is checked by electron-updater; Squirrel then checks
 *   the new bundle's code signature against the running app's designated
 *   requirement. Only Squirrel's own "update-downloaded" means ready.
 * - autoInstallOnAppQuit stays on so Squirrel validates right after the
 *   download, which also means a ready update installs at any quit: main
 *   runs its coordinated shutdown on every quit for that reason.
 */
import { autoUpdater as squirrel, session } from "electron";
import { CancellationToken, MacUpdater } from "electron-updater";
import type { UpdateChannel } from "@terno/core/updates";
import { inboundHeaders, outboundHeaders, type FeedConfig } from "./policy";

export const UPDATER_PARTITION = "persist:terno-updater";

export interface EngineInfo {
  version: string;
  releaseNotes: unknown;
  releaseDate: string | null;
  size: number | null;
}

export interface EngineHandlers {
  progress(percent: number): void;
  /** Squirrel accepted the bundle */
  ready(): void;
  /** Squirrel refused it, or failed later on its own */
  squirrelError(error: Error): void;
}

export interface Engine {
  /** the newest release if it's newer than this one (never a downgrade), else null */
  check(channel: UpdateChannel): Promise<EngineInfo | null>;
  /** resolves once the zip is verified and handed to Squirrel (its verdict comes as ready / squirrelError) */
  download(): Promise<void>;
  cancel(): void;
  quitAndInstall(): void;
}

export function createEngine(o: { feed: FeedConfig; allowed(url: string): boolean; handlers: EngineHandlers }): Engine {
  const ses = session.fromPartition(UPDATER_PARTITION, { cache: false });
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !o.allowed(details.url) }));
  ses.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: outboundHeaders(details.requestHeaders) }));
  ses.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: inboundHeaders(details.responseHeaders ?? {}) }));

  const updater = new MacUpdater();
  // our session instead of electron-updater's own partition
  (updater as unknown as { httpExecutor: { cachedSession: unknown } }).httpExecutor.cachedSession = ses;
  // its log lines carry URLs and paths: diagnostics take our coded events instead
  updater.logger = null;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = true;
  updater.fullChangelog = false;
  // no staged rollouts: its random per-profile id (.updaterId, sent as x-user-staging-id) is never created
  (updater as unknown as { getOrCreateStagingUserId(): Promise<string> }).getOrCreateStagingUserId = async () => "00000000-0000-4000-8000-000000000000";
  updater.setFeedURL(o.feed);
  updater.on("download-progress", (p: { percent: number }) => o.handlers.progress(p.percent));
  squirrel.on("update-downloaded", () => o.handlers.ready());
  squirrel.on("error", (error: Error) => o.handlers.squirrelError(error));
  // electron-updater re-emits Squirrel's errors; ours come back from the promises
  updater.on("error", () => {});

  let token: CancellationToken | null = null;
  return {
    async check(channel) {
      updater.channel = channel === "nightly" ? "nightly" : "latest";
      // setting a channel allows downgrades; nightly → stable never offers one
      updater.allowDowngrade = false;
      updater.allowPrerelease = channel === "nightly";
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      const info = result.updateInfo;
      const file = info.files?.find((f) => f.url.endsWith(".zip")) ?? info.files?.[0];
      return { version: info.version, releaseNotes: info.releaseNotes ?? null, releaseDate: info.releaseDate ?? null, size: typeof file?.size === "number" ? file.size : null };
    },
    async download() {
      token = new CancellationToken();
      try {
        await updater.downloadUpdate(token);
      } finally {
        token = null;
      }
    },
    cancel() {
      token?.cancel();
      // a check has no token of its own: whatever the session has in flight is cut (its promise rejects)
      void ses.closeAllConnections();
    },
    quitAndInstall() {
      updater.quitAndInstall();
    },
  };
}

/**
 * The updater's rules, apart from Electron so they're unit-tested in Node:
 * when it may touch the network (local mode, the setting, the user's
 * grants), where it may go (GitHub's release hosts, or a test build's own
 * feed), which copies can update themselves, and the feed itself.
 */
import type { UnsupportedReason, UpdateChannel, UpdateErrorKind, UpdateMode } from "@terno/core/updates";

// ───────────────────────────── when: local mode × setting × grants ─────────────────────────────

export type Trigger = "auto" | "manual";

/**
 * Automatic work needs automatic mode outside local mode (a check also runs
 * in manual mode: it only offers). A manual check is one grant, a manual
 * download a second one; each is allowed anywhere, local mode included,
 * because the user asked for exactly that request.
 */
export function mayCheck(o: { localMode: boolean; trigger: Trigger }): boolean {
  return o.trigger === "manual" || !o.localMode;
}

export function mayDownload(o: { localMode: boolean; mode: UpdateMode; trigger: Trigger }): boolean {
  return o.trigger === "manual" || (!o.localMode && o.mode === "auto");
}

/**
 * The open grants: the updater's session lets a request through only while
 * one is open. Automatic grants are refused in local mode and revoked when
 * it turns on; a manual one lasts until its check or download settles.
 */
export class Grants {
  private open = new Map<number, Trigger>();
  private seq = 0;

  grant(trigger: Trigger, o: { localMode: boolean }): number | null {
    if (trigger === "auto" && o.localMode) return null;
    const id = ++this.seq;
    this.open.set(id, trigger);
    return id;
  }

  release(id: number | null): void {
    if (id !== null) this.open.delete(id);
  }

  /** local mode turned on: automatic grants end now (their requests are refused from here on) */
  revokeAutomatic(): boolean {
    let revoked = false;
    for (const [id, t] of this.open) if (t === "auto") revoked = this.open.delete(id) || revoked;
    return revoked;
  }

  get active(): boolean {
    return this.open.size > 0;
  }
}

// ───────────────────────────── where: hosts ─────────────────────────────

/** GitHub's release feed and the CDN its downloads redirect to. */
export const GITHUB_RELEASE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

/**
 * A request (or a redirect, which comes back through here) is allowed only
 * over https to GitHub's release hosts, with no credentials in the URL; a
 * test build may also reach its own feed's origin, and only that.
 */
export function updateRequestAllowed(url: string, testFeed: string | null): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (testFeed) {
    try {
      if (u.origin === new URL(testFeed).origin) return true;
    } catch {
      /* not a URL: only GitHub then */
    }
  }
  return u.protocol === "https:" && u.port === "" && GITHUB_RELEASE_HOSTS.has(u.hostname.toLowerCase());
}

/**
 * What may go out with an update request: no cookies or credentials, and not
 * electron-updater's staged-rollout id (x-user-staging-id, a random id kept
 * in the profile: a stable identifier GitHub has no business seeing).
 */
const DROPPED_HEADERS = /^(cookie|authorization|proxy-authorization|x-user-staging-id)$/i;
export function outboundHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED_HEADERS.test(name)));
}

/** Nor may anything set a cookie in the updater's session. */
export function inboundHeaders(headers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !/^set-cookie2?$/i.test(name)));
}

// ───────────────────────────── which copies can update ─────────────────────────────

export interface LocationProbe {
  packaged: boolean;
  /** codesign: false for an ad-hoc signature (Squirrel refuses every update to it), null when unknown */
  signed: boolean | null;
  /** an x64 build running under Rosetta */
  translated: boolean;
  /** the running .app bundle */
  bundlePath: string;
  /** the volume the bundle is on is mounted read-only */
  volumeReadOnly: boolean;
  /** the bundle's folder can be written (Squirrel swaps the bundle there) */
  parentWritable: boolean;
}

/** Why this copy can't update itself, or null. Location reasons all say "Move Terno to Applications". */
export function unsupportedReason(p: LocationProbe): UnsupportedReason | null {
  if (!p.packaged) return "dev";
  if (p.signed === false) return "unsigned";
  if (p.bundlePath.includes("/AppTranslocation/")) return "translocated";
  if (p.bundlePath.startsWith("/Volumes/") && p.volumeReadOnly) return "dmg";
  if (p.volumeReadOnly) return "read-only";
  if (!p.parentWritable) return "not-writable";
  if (p.translated) return "translated";
  return null;
}

/** /X/Terno.app/Contents/MacOS/Terno → /X/Terno.app */
export function bundleOf(execPath: string): string | null {
  const i = execPath.lastIndexOf(".app/Contents/");
  return i === -1 ? null : execPath.slice(0, i + 4);
}

/** `codesign -dv` output: a real identity has a team; an ad-hoc signature says so. */
export function signedFromCodesign(output: string): boolean | null {
  if (/Signature=adhoc/.test(output) || /TeamIdentifier=not set/.test(output)) return false;
  if (/TeamIdentifier=[A-Z0-9]{10}\b/.test(output)) return true;
  return null;
}

// ───────────────────────────── the feed ─────────────────────────────

export type FeedConfig = { provider: "github"; owner: string; repo: string } | { provider: "generic"; url: string };

export const RELEASE_REPO = { owner: "luisiacc", repo: "terno" } as const;

/** Baked into test builds only (scripts/build.mjs): env doesn't survive Squirrel's relaunch, and a release reads none. */
export interface TestBuild {
  feed: string;
  userData: string;
  appData: string;
  appName: string;
  /** the first check's delay (a release waits STARTUP_CHECK_DELAY_MS) */
  checkDelayMs?: number;
}

/**
 * The feed this build checks: GitHub's releases, or a test build's baked
 * generic feed. The environment is never read: no variable can point a
 * release somewhere else.
 */
export function resolveFeed(testBuild: TestBuild | undefined): FeedConfig {
  if (testBuild?.feed) return { provider: "generic", url: testBuild.feed };
  return { provider: "github", ...RELEASE_REPO };
}

/** electron-updater's channel file: latest-mac.yml or nightly-mac.yml. */
export function channelFile(channel: UpdateChannel): string {
  return channel === "nightly" ? "nightly" : "latest";
}

// ───────────────────────────── errors ─────────────────────────────

/**
 * What kind of failure, from what electron-updater, Electron's net and
 * Squirrel throw (codes and domains only; their messages carry URLs).
 */
export function errorKind(error: unknown): UpdateErrorKind {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; statusCode?: unknown; domain?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  const status = typeof e.statusCode === "number" ? e.statusCode : Number(/HttpError: (\d{3})/.exec(message)?.[1] ?? NaN);
  if (/ERR_BLOCKED_BY_CLIENT/.test(message)) return "blocked";
  if (code === "ERR_CHECKSUM_MISMATCH" || /sha512 checksum mismatch|checksum mismatch/i.test(message) || /SQRLCodeSignatureErrorDomain|code signature|did not pass validation/i.test(message)) return "integrity";
  if (code === "ENOSPC" || code === "EACCES" || code === "EROFS" || code === "EPERM") return "disk";
  if (/net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|FAILED)|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED)/.test(message) || /^E(CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH)$/.test(code)) return "offline";
  if (Number.isFinite(status) && status >= 400) return "server";
  if (code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" || code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || code === "ERR_UPDATER_INVALID_UPDATE_INFO" || code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS") return "server";
  return "unknown";
}

/** Failures that are the world's, not ours: logged, never reported. */
export function expectedKind(kind: UpdateErrorKind): boolean {
  return kind === "offline" || kind === "server" || kind === "blocked" || kind === "disk";
}

// ───────────────────────────── prefs ─────────────────────────────

export interface UpdatePrefs {
  mode: UpdateMode;
  channel: UpdateChannel;
  checkedAt: number | null;
}

export const DEFAULT_PREFS: UpdatePrefs = { mode: "auto", channel: "stable", checkedAt: null };

export function parsePrefs(value: unknown): UpdatePrefs {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    mode: v.mode === "manual" ? "manual" : "auto",
    channel: v.channel === "nightly" ? "nightly" : "stable",
    checkedAt: typeof v.checkedAt === "number" && Number.isFinite(v.checkedAt) ? v.checkedAt : null,
  };
}

// ───────────────────────────── health after an install ─────────────────────────────

/** Written just before an install (a restart, or a quit with an update ready). */
export interface PendingInstall {
  from: string;
  to: string;
  txId: string;
  at: number;
}

export function parsePending(value: unknown): PendingInstall | null {
  const v = (value && typeof value === "object" ? value : null) as Record<string, unknown> | null;
  if (!v) return null;
  const ok = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(s);
  if (!ok(v.from) || !ok(v.to) || !ok(v.txId) || typeof v.at !== "number") return null;
  return { from: v.from, to: v.to, txId: v.txId, at: v.at };
}

/**
 * Once the backend is ready in the next run: the target version running is
 * "applied"; the old one still running is "not-applied"; any other version
 * (installed by hand meanwhile) says nothing about this update.
 */
export function installOutcome(p: PendingInstall, running: string): "applied" | "not-applied" | null {
  if (running === p.to) return "applied";
  if (running === p.from) return "not-applied";
  return null;
}

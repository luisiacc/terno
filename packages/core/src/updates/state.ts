/**
 * The in-app update's state, as a pure reducer (plan 11, T3 Code's shape).
 * Main owns it on desktop and sends every new state to the windows; the
 * renderer only draws it. Nothing here does I/O or reads a clock.
 *
 * - A verified update ("ready": Squirrel accepted the bundle) is never lost
 *   to a later check that fails or finds nothing; it installs at the next
 *   quit or restart whatever happens afterwards.
 * - Errors carry a kind, never a server's text.
 */

export type UpdateChannel = "stable" | "nightly";
/** auto: check and download in the background; manual: check in the background, download when asked */
export type UpdateMode = "auto" | "manual";
export type UnsupportedReason = "dev" | "unsigned" | "dmg" | "translocated" | "read-only" | "not-writable" | "translated";
export type UpdateErrorStage = "check" | "download" | "verify" | "install";
export type UpdateErrorKind = "offline" | "server" | "integrity" | "disk" | "blocked" | "not-applied" | "unknown";

export interface UpdateInfo {
  version: string;
  /** release notes as plain text (never HTML), bounded */
  notes: string;
  /** the download's size in bytes, when the feed says */
  size: number | null;
  /** ISO date of the release, when the feed says */
  releaseDate: string | null;
}

export type UpdateStatus = "idle" | "unsupported" | "checking" | "up-to-date" | "available" | "downloading" | "verifying" | "ready" | "installing" | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** why this copy can't update itself (status "unsupported") */
  unsupported: UnsupportedReason | null;
  mode: UpdateMode;
  channel: UpdateChannel;
  /** the running version */
  current: string;
  /** the newest version the feed offered */
  available: UpdateInfo | null;
  /** downloaded and accepted by Squirrel: installs at the next quit or restart */
  ready: UpdateInfo | null;
  percent: number | null;
  /** epoch ms of the last check that answered (or failed) */
  checkedAt: number | null;
  error: { stage: UpdateErrorStage; kind: UpdateErrorKind; canRetry: boolean } | null;
  /** "Restart now" was asked while a send was in flight: it happens once the send finishes */
  deferred: "sending" | null;
  /** in local mode nothing is checked or downloaded unless the user asks each time */
  localMode: boolean;
  /** this run is the version an update just installed (once, for "Terno updated to …") */
  justUpdated: string | null;
}

export type UpdateEvent =
  | { type: "unsupported"; reason: UnsupportedReason }
  | { type: "prefs"; mode: UpdateMode; channel: UpdateChannel }
  | { type: "local-mode"; on: boolean }
  | { type: "check-start" }
  | { type: "check-failed"; at: number; kind: UpdateErrorKind }
  | { type: "available"; at: number; update: UpdateInfo }
  | { type: "not-available"; at: number }
  /** a check or download that was in flight was stopped (local mode turned on, channel changed) */
  | { type: "cancelled" }
  | { type: "download-start" }
  | { type: "download-progress"; percent: number }
  | { type: "download-failed"; kind: UpdateErrorKind }
  /** electron-updater has the zip (sha512 checked); Squirrel validates its signature next */
  | { type: "downloaded" }
  /** Squirrel accepted it: only now is it ready */
  | { type: "ready" }
  | { type: "verify-failed"; kind: UpdateErrorKind }
  | { type: "install-start" }
  | { type: "install-deferred"; reason: "sending" }
  | { type: "install-failed"; kind: UpdateErrorKind }
  | { type: "applied"; version: string }
  | { type: "not-applied"; version: string }
  | { type: "seen" };

export function initialUpdateState(o: { current: string; mode: UpdateMode; channel: UpdateChannel; localMode: boolean; checkedAt?: number | null }): UpdateState {
  return {
    status: "idle",
    unsupported: null,
    mode: o.mode,
    channel: o.channel,
    current: o.current,
    available: null,
    ready: null,
    percent: null,
    checkedAt: o.checkedAt ?? null,
    error: null,
    deferred: null,
    localMode: o.localMode,
    justUpdated: null,
  };
}

/** Where a state settles when nothing is in flight: ready beats available beats idle. */
function settled(s: UpdateState): UpdateState {
  if (s.ready) return { ...s, status: "ready", percent: 100 };
  if (s.available) return { ...s, status: "available", percent: null };
  return { ...s, status: "idle", percent: null };
}

export function reduceUpdate(s: UpdateState, e: UpdateEvent): UpdateState {
  // an unsupported copy stays unsupported: nothing else can happen to it
  if (s.status === "unsupported" && e.type !== "prefs" && e.type !== "local-mode" && e.type !== "seen") return s;
  switch (e.type) {
    case "unsupported":
      return { ...s, status: "unsupported", unsupported: e.reason, available: null, ready: null, percent: null, error: null };
    case "prefs":
      // another channel: what it offered (not yet staged) no longer applies; a staged update can't be unstaged
      if (e.channel !== s.channel) return settled({ ...s, mode: e.mode, channel: e.channel, available: s.ready, error: null });
      return { ...s, mode: e.mode };
    case "local-mode":
      return { ...s, localMode: e.on };
    case "check-start":
      if (s.status === "downloading" || s.status === "verifying" || s.status === "installing") return s;
      // with an update ready the check runs quietly (a newer one may have shipped)
      if (s.ready) return { ...s, error: null };
      return { ...s, status: "checking", error: null };
    case "check-failed":
      // a verified update survives a failed check
      if (s.ready) return { ...settled(s), checkedAt: e.at, error: null };
      return { ...s, status: "error", checkedAt: e.at, percent: null, error: { stage: "check", kind: e.kind, canRetry: true } };
    case "available":
      if (s.ready?.version === e.update.version) return { ...settled(s), checkedAt: e.at, error: null };
      return { ...s, status: s.ready ? "ready" : "available", available: e.update, checkedAt: e.at, error: null, percent: s.ready ? 100 : null };
    case "not-available":
      if (s.ready) return { ...settled(s), checkedAt: e.at, error: null };
      return { ...s, status: "up-to-date", available: null, checkedAt: e.at, error: null, percent: null };
    case "cancelled":
      return settled({ ...s, error: null });
    case "download-start":
      if (!s.available) return s;
      return { ...s, status: "downloading", percent: 0, error: null };
    case "download-progress":
      if (s.status !== "downloading") return s;
      return { ...s, percent: Math.max(0, Math.min(100, Math.floor(e.percent))) };
    case "download-failed":
      return { ...settled(s), error: { stage: "download", kind: e.kind, canRetry: s.available !== null } };
    case "downloaded":
      if (s.status !== "downloading") return s;
      return { ...s, status: "verifying", percent: 100 };
    case "ready":
      if (!s.available) return s;
      return { ...s, status: "ready", ready: s.available, percent: 100, error: null };
    case "verify-failed":
      return { ...settled(s), error: { stage: "verify", kind: e.kind, canRetry: s.available !== null } };
    case "install-start":
      if (!s.ready) return s;
      return { ...s, status: "installing", deferred: null, error: null };
    case "install-deferred":
      if (!s.ready) return s;
      return { ...s, status: "ready", deferred: e.reason };
    case "install-failed":
      return { ...settled(s), deferred: null, error: { stage: "install", kind: e.kind, canRetry: s.ready !== null } };
    case "applied":
      return { ...s, justUpdated: e.version };
    case "not-applied":
      return { ...s, status: "error", error: { stage: "install", kind: "not-applied", canRetry: true } };
    case "seen":
      return { ...s, justUpdated: null };
  }
}

/** Plain text from release notes (GitHub sends HTML): tags dropped, entities decoded, blank runs folded, bounded. */
export function notesText(notes: unknown, max = 4000): string {
  const raw = typeof notes === "string" ? notes : Array.isArray(notes) ? notes.map((n) => (n && typeof n === "object" && typeof (n as { note?: unknown }).note === "string" ? (n as { note: string }).note : "")).join("\n\n") : "";
  const text = raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n• ")
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|pre|blockquote)\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, ent: string) => {
      const e = ent.toLowerCase();
      if (e.startsWith("#x")) return safeChar(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return safeChar(parseInt(e.slice(1), 10));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[e] ?? "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function safeChar(code: number): string {
  // controls and lone surrogates would draw as garbage; nothing else needs refusing in plain text
  if (!Number.isFinite(code) || code < 32 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return "";
  return String.fromCodePoint(code);
}

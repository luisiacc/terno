/**
 * Plan 226: Terno opened from outside Applications (its disk image, Downloads) offers, once per launch and before
 * anything starts, to move itself there: in Applications it stays installed and can update itself. Pure: the
 * decision and the flow, with every Electron call injected (install-main.ts wires them).
 */
import { compareVersions, validVersion } from "@terno/core/updates";

export type InstallFrom = "dmg" | "elsewhere";

/** What's already at /Applications/Terno.app, read from its Info.plist. */
export interface InstalledCopy {
  id: string;
  version: string;
}

export interface InstallProbe {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** a test build skips the offer unless it bakes offerInstall (plan 226's real run) */
  testBuild: { offerInstall?: boolean } | undefined;
  demo: boolean;
  /** a launch that must never take focus (the packaged smoke) can't ask */
  background: boolean;
  /** a terno:// link launched this copy: the move's relaunch wouldn't carry it */
  linkWaiting: boolean;
  /** the rest is read only once the cheap checks pass: an installed Terno pays one call */
  inApplications(): boolean;
  bundlePath(): string;
  /** the bundle's folder can't be written because its volume is read-only (a mounted disk image) */
  volumeReadOnly(): boolean;
  ownId(): string | null;
  version: string;
  installed(): InstalledCopy | null;
}

/** The installed copy is one this copy must not replace: a newer Terno (a downgrade), or another app under the name. */
export function mustKeep(installed: InstalledCopy | null, ownId: string | null, version: string): boolean {
  if (!installed) return false;
  if (!ownId || installed.id !== ownId) return true;
  // a version that can't be read is no reason to keep it: the copy being moved is a release, and this one is the same app
  return validVersion(installed.version) && validVersion(version) && compareVersions(installed.version, version) > 0;
}

/** Where this copy runs from when the offer applies, else null. */
export function offerMoveFrom(p: InstallProbe): InstallFrom | null {
  if (!p.packaged || p.platform !== "darwin" || p.demo || p.background || p.linkWaiting) return null;
  if (p.testBuild && !p.testBuild.offerInstall) return null;
  if (p.inApplications()) return null;
  if (mustKeep(p.installed(), p.ownId(), p.version)) return null;
  return p.bundlePath().startsWith("/Volumes/") && p.volumeReadOnly() ? "dmg" : "elsewhere";
}

export type InstallStep = "offered" | "moved" | "declined" | "kept" | "failed";

export interface OfferDeps {
  /** the question; true: Move to Applications */
  ask(from: InstallFrom): Promise<boolean>;
  /** Electron's move: true when it moved (and the app now quits and relaunches); the handler decides a conflict */
  move(conflict: (type: "exists" | "existsAndRunning") => boolean): boolean;
  /** what's in Applications right now (re-read at the move: the dialog may have been open a while) */
  installed(): InstalledCopy | null;
  ownId: string | null;
  version: string;
  /** after a move that threw: how to install by hand */
  failed(): Promise<void>;
  /** main's quit gate: open while the move quits, shut again when it doesn't */
  quitting(on: boolean): void;
  log(step: InstallStep, from: InstallFrom): void;
}

/** The offer, start to end: "moving" when Electron is quitting to relaunch from Applications, else "open" (start as usual). */
export async function offerMove(from: InstallFrom, d: OfferDeps): Promise<"moving" | "open"> {
  d.log("offered", from);
  if (!(await d.ask(from))) {
    d.log("declined", from);
    return "open";
  }
  let kept = false;
  d.quitting(true);
  let moved: boolean;
  try {
    moved = d.move((type) => {
      // a running copy takes focus and this one quits: what the user wanted, the same app open from Applications
      if (type === "existsAndRunning") return true;
      kept = mustKeep(d.installed(), d.ownId, d.version);
      return !kept;
    });
  } catch {
    // Electron throws for a failed copy and, despite its typings, for a cancelled admin prompt: one message fits both
    d.quitting(false);
    d.log("failed", from);
    await d.failed();
    return "open";
  }
  if (moved) {
    d.log("moved", from);
    return "moving";
  }
  d.quitting(false);
  d.log(kept ? "kept" : "declined", from);
  return "open";
}

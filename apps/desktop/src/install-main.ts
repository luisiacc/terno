/**
 * Plan 226: install-location.ts's offer, wired to Electron: the probe, the native dialogs (in the menu's language)
 * and app.moveToApplicationsFolder. Called once from whenReady, before the backend or any window.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { app, dialog } from "electron";
import { log } from "@terno/core/diag";
import { t } from "@terno/i18n";
import { TEST_BUILD } from "./test-build";
import { bundleOf } from "./updates/policy";
import { moveDestination, offerMove, offerMoveFrom, type InstalledCopy } from "./install-location";

/** One key of a bundle's Info.plist (plutil reads XML and binary alike), or null. */
function plistValue(bundle: string, key: string): string | null {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", join(bundle, "Contents/Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

/** What's at the move's destination: /Applications under this bundle's own name, as Electron's move puts it. */
function installedCopy(bundle: string): InstalledCopy | null {
  const at = moveDestination(bundle);
  const id = plistValue(at, "CFBundleIdentifier");
  return id ? { id, version: plistValue(at, "CFBundleShortVersionString") ?? "" } : null;
}

function readOnlyVolume(bundle: string): boolean {
  try {
    accessSync(dirname(bundle), constants.W_OK);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EROFS";
  }
}

/** true: Electron is quitting to relaunch from Applications, so nothing else may start. */
export async function offerInstall(o: { demo: boolean; background: boolean; linkWaiting(): boolean; quitting(on: boolean): void }): Promise<boolean> {
  const bundle = bundleOf(process.execPath) ?? "";
  let ownId: string | null | undefined;
  const own = () => (ownId === undefined ? (ownId = bundle ? plistValue(bundle, "CFBundleIdentifier") : null) : ownId);
  const from = offerMoveFrom({
    packaged: app.isPackaged,
    platform: process.platform,
    testBuild: TEST_BUILD,
    demo: o.demo,
    background: o.background,
    linkWaiting: o.linkWaiting(),
    inApplications: () => app.isInApplicationsFolder(),
    bundlePath: () => bundle,
    volumeReadOnly: () => readOnlyVolume(bundle),
    ownId: own,
    version: app.getVersion(),
    installed: () => installedCopy(bundle),
  });
  if (!from) return false;
  const result = await offerMove(from, {
    ask: async (where) => {
      const { response } = await dialog.showMessageBox({
        message: t("install.offer.title"),
        detail: t(where === "dmg" ? "install.offer.fromDmg" : "install.offer.elsewhere"),
        buttons: [t("install.offer.move"), t("install.offer.notNow")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      return response === 0;
    },
    move: (conflictHandler) => app.moveToApplicationsFolder({ conflictHandler }),
    installed: () => installedCopy(bundle),
    linkWaiting: o.linkWaiting,
    ownId: own(),
    version: app.getVersion(),
    failed: async () => {
      await dialog.showMessageBox({ type: "warning", message: t("install.failed.title"), detail: t("install.failed.detail"), buttons: [t("install.failed.ok")], noLink: true });
    },
    quitting: o.quitting,
    log: (installStep, installFrom) => log.info("install.offer", { installStep, installFrom }),
  });
  return result === "moving";
}

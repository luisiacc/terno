import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog } from "electron";
import { t } from "@terno/i18n";
import { LegacyProfileConflictError, LegacyProfileInUseError, migrateLegacyProfile, resolveProfile } from "./legacy-profile";
import { readLanguage, switchLanguage } from "./locale";

export const APP_NAME = process.env.TERNO_TEST_APP_NAME ?? "Terno";
/** in a profile that came from Única: its renderer localStorage (origin app://unica) still has to move (app.ts) */
export const LEGACY_STORAGE_PENDING = "legacy-storage-pending";

/**
 * Names the app (which also names its keychain item) and points userData at
 * the profile: TERNO_USER_DATA, else ~/Library/Application Support/Terno
 * (what the MCP sidecar looks for). A legacy Única profile is renamed first:
 * the default one takes over ~/Library/Application Support/Unica; an explicit
 * path only has its database files renamed (resolveProfile).
 * false: the app must not start (Única still has the profile open, or its
 * files can't be moved safely: nothing was changed, the user is told why).
 */
export function prepareProfile(): boolean {
  app.setName(APP_NAME);
  // TERNO_TEST_APP_DATA: tests stand in for ~/Library/Application Support (the default profile's parent)
  const appData = process.env.TERNO_TEST_APP_DATA ?? app.getPath("appData");
  const { path: profile, adoptSibling } = resolveProfile({ explicit: process.env.TERNO_USER_DATA, defaultPath: join(appData, "Terno") });
  try {
    const m = migrateLegacyProfile(profile, { adoptSibling });
    if (m.movedFrom) console.log(`[profile] moved ${m.movedFrom} → ${profile}`);
    for (const r of m.renamed) console.log(`[profile] renamed ${r}`);
    for (const c of m.conflicts) console.warn(`[profile] left alone (the Terno one exists): ${c}`);
    if (m.movedFrom || m.renamed.length) writeFileSync(join(profile, LEGACY_STORAGE_PENDING), `${new Date().toISOString()}\n`);
  } catch (error) {
    void refuse(profile, error);
    return false;
  }
  app.setPath("userData", profile);
  return true;
}

/** Why the app won't open, in main's current locale. */
export function refusal(error: unknown): { title: string; message: string } {
  if (error instanceof LegacyProfileInUseError) return { title: t("desktop.profile.inUse.title"), message: t("desktop.profile.inUse.message") };
  if (error instanceof LegacyProfileConflictError) return { title: t("desktop.profile.failed.title"), message: t("desktop.profile.conflict.message", { files: error.files.join("\n") }) };
  // whatever else failed (an unreadable database, a full disk), the profile stays as it was and nothing opens empty
  return { title: t("desktop.profile.failed.title"), message: t("desktop.profile.failed.message", { error: error instanceof Error ? error.message : String(error) }) };
}

/**
 * Tells the user, then quits. Before `ready` there are no system languages
 * and userData isn't set: the profile's locale.json names the language, else
 * English. prepareProfile has already returned false (main opens nothing).
 */
async function refuse(profile: string, error: unknown): Promise<void> {
  try {
    await switchLanguage(readLanguage(profile), []);
  } catch {
    // English, then: the box shows either way
  }
  const { title, message } = refusal(error);
  dialog.showErrorBox(title, message);
  app.exit(1);
}

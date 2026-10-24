import { join } from "node:path";
import { app, dialog } from "electron";
import { LegacyProfileInUseError, migrateLegacyProfile } from "./legacy-profile";

export const APP_NAME = process.env.TERNO_TEST_APP_NAME ?? "Terno";

/**
 * Names the app (which also names its keychain item) and points userData at
 * the profile: TERNO_USER_DATA, else ~/Library/Application Support/Terno
 * (what the MCP sidecar looks for). A legacy Única profile is renamed first.
 * false: the app must not start (Única still has the profile open).
 */
export function prepareProfile(): boolean {
  app.setName(APP_NAME);
  const profile = process.env.TERNO_USER_DATA ?? join(app.getPath("appData"), "Terno");
  try {
    const m = migrateLegacyProfile(profile);
    if (m.movedFrom) console.log(`[profile] moved ${m.movedFrom} → ${profile}`);
    for (const r of m.renamed) console.log(`[profile] renamed ${r}`);
    for (const c of m.conflicts) console.warn(`[profile] left alone (the Terno one exists): ${c}`);
  } catch (error) {
    if (!(error instanceof LegacyProfileInUseError)) throw error;
    dialog.showErrorBox("Única sigue abierta", "Cierra Única y vuelve a abrir Terno: tu correo pasa a Terno en cuanto Única no lo esté usando.");
    app.exit(1);
    return false;
  }
  app.setPath("userData", profile);
  return true;
}

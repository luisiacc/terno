import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog } from "electron";
import { LegacyProfileConflictError, LegacyProfileInUseError, migrateLegacyProfile } from "./legacy-profile";

export const APP_NAME = process.env.TERNO_TEST_APP_NAME ?? "Terno";
/** in a profile that came from Única: its renderer localStorage (origin app://unica) still has to move (app.ts) */
export const LEGACY_STORAGE_PENDING = "legacy-storage-pending";

/**
 * Names the app (which also names its keychain item) and points userData at
 * the profile: TERNO_USER_DATA, else ~/Library/Application Support/Terno
 * (what the MCP sidecar looks for). A legacy Única profile is renamed first.
 * false: the app must not start (Única still has the profile open, or its
 * files can't be moved safely: nothing was changed, the user is told why).
 */
export function prepareProfile(): boolean {
  app.setName(APP_NAME);
  const profile = process.env.TERNO_USER_DATA ?? join(app.getPath("appData"), "Terno");
  try {
    const m = migrateLegacyProfile(profile);
    if (m.movedFrom) console.log(`[profile] moved ${m.movedFrom} → ${profile}`);
    for (const r of m.renamed) console.log(`[profile] renamed ${r}`);
    for (const c of m.conflicts) console.warn(`[profile] left alone (the Terno one exists): ${c}`);
    if (m.movedFrom || m.renamed.length) writeFileSync(join(profile, LEGACY_STORAGE_PENDING), `${new Date().toISOString()}\n`);
  } catch (error) {
    if (error instanceof LegacyProfileInUseError) {
      dialog.showErrorBox("Única sigue abierta", "Cierra Única y vuelve a abrir Terno: tu correo pasa a Terno en cuanto Única no lo esté usando.");
    } else if (error instanceof LegacyProfileConflictError) {
      dialog.showErrorBox(
        "No se pudo pasar tu correo de Única a Terno",
        `Junto a tu correo de Única hay archivos de un intento anterior que no se pueden emparejar con él:\n\n${error.files.join("\n")}\n\nNo se ha tocado ningún archivo. Para no perder correo, Terno no se abre hasta resolverlo: con Única y Terno cerrados, mueve esos archivos a otra carpeta y vuelve a abrir Terno.`,
      );
    } else {
      // whatever else failed (an unreadable database, a full disk), the profile stays as it was and nothing opens empty
      dialog.showErrorBox("No se pudo pasar tu correo de Única a Terno", `${error instanceof Error ? error.message : String(error)}\n\nNo se ha borrado nada. Cierra Única y vuelve a abrir Terno.`);
    }
    app.exit(1);
    return false;
  }
  app.setPath("userData", profile);
  return true;
}

/**
 * Main's language: menus, dialogs and save panels. The setting lives in the
 * backend's settings and arrives with its policy; main keeps a copy in
 * userData/locale.json so the first menu (built before the backend reports)
 * and the profile's error boxes (before `ready`) are in the right language.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLocale, isLanguageSetting, loadLocale, resolveLocale, type LanguageSetting, type LocaleId } from "@terno/i18n";

export const LOCALE_FILE = "locale.json";

export function readLanguage(dir: string): LanguageSetting {
  try {
    const v = (JSON.parse(readFileSync(join(dir, LOCALE_FILE), "utf8")) as { language?: unknown }).language;
    return isLanguageSetting(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function writeLanguage(dir: string, language: LanguageSetting): void {
  try {
    writeFileSync(join(dir, LOCALE_FILE), JSON.stringify({ language }));
  } catch {
    // the next start shows the system's language until the backend reports
  }
}

/**
 * Makes `language` main's locale; resolves true when the locale changed.
 * `system` is the system's preferred languages (after `ready`), or none
 * before it (English, unless the setting names a language).
 */
export async function switchLanguage(language: LanguageSetting, system: readonly string[]): Promise<boolean> {
  const id: LocaleId = resolveLocale(language, system);
  if (id === getLocale()) return false;
  try {
    await loadLocale(id);
  } catch {
    return false;
  }
  return true;
}

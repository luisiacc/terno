/** Values typed into settings: what is valid, and why not. */
import { t } from "@terno/i18n";

export const SYNC_WINDOW_MIN = 7;
export const SYNC_WINDOW_MAX = 3650;

/** A whole number of days in [7, 3650] (the contract's range), or why not. */
export function parseSyncWindow(text: string): { days: number } | { error: string } {
  const value = text.trim();
  const days = Number(value);
  if (!/^\d+$/.test(value) || days < SYNC_WINDOW_MIN || days > SYNC_WINDOW_MAX) {
    return { error: t("settings.syncWindow.invalid", { min: SYNC_WINDOW_MIN, max: SYNC_WINDOW_MAX }) };
  }
  return { days };
}

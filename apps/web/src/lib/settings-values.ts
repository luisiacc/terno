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

/** plan 79: how far back a new account downloads; the General setting is preselected (and listed if it's none of these) */
const WINDOWS = [30, 90, 180, 365, 730];

export function windowLabel(days: number): string {
  if (days === 365) return t("account.window.year");
  if (days % 365 === 0) return t("account.window.years", { years: days / 365 });
  return t("account.window.days", { days });
}

export function windowChoices(general: number): number[] {
  return WINDOWS.includes(general) ? WINDOWS : [...WINDOWS, general].sort((a, b) => a - b);
}

/** Values typed into settings: what is valid, and why not. */

export const SYNC_WINDOW_MIN = 7;
export const SYNC_WINDOW_MAX = 3650;

/** A whole number of days in [7, 3650] (the contract's range), or why not. */
export function parseSyncWindow(text: string): { days: number } | { error: string } {
  const value = text.trim();
  const days = Number(value);
  if (!/^\d+$/.test(value) || days < SYNC_WINDOW_MIN || days > SYNC_WINDOW_MAX) {
    return { error: `Escribe un número de días entre ${SYNC_WINDOW_MIN} y ${SYNC_WINDOW_MAX}.` };
  }
  return { days };
}

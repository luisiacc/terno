/**
 * Plan 38 in main: the Dock badge, from what the backend reports over the
 * parent port (validated again here). Electron stays behind the deps, so
 * this is tested with fakes.
 */
import { badgeText } from "@terno/core";

/** A badge count from the backend, or null. */
export function parseBadge(v: unknown): number | null {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;
}

export interface DesktopAttentionDeps {
  setBadge(text: string): void;
}

export class DesktopAttention {
  private badgeShown: string | null = null;

  constructor(private readonly deps: DesktopAttentionDeps) {}

  badge(raw: unknown): void {
    const count = parseBadge(raw);
    if (count === null) return;
    const text = badgeText(count);
    if (text === this.badgeShown) return;
    this.badgeShown = text;
    this.deps.setBadge(text);
  }

  /** what the Dock shows (tests) */
  get badgeText(): string | null {
    return this.badgeShown;
  }
}

/**
 * Plan 283 (CASA 6.2.1): a packaged Terno can't be debugged. The fuses keep Node's inspector out of a shipped build
 * (scripts/fuses.mjs); these rules cover what no fuse does: DevTools, and Chromium's DevTools protocol.
 */

/** Chromium's switches that serve the DevTools protocol, which drives every page as fully as an inspector drives main. */
export const PROTOCOL_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;

/** DevTools open only in an unpackaged run (the dev server, the source smoke run); every window takes this. */
export function devToolsAllowed(packaged: boolean): boolean {
  return !packaged;
}

/**
 * The switch to refuse, or null. A packaged app serves the DevTools protocol only beside a running Node inspector:
 * an inspectable package (Playwright passes `--inspect=0` with it) can start one, a shipped one never can (its fuse is
 * off), so the rule follows the fuse and the binary is the one source of truth. Unpackaged runs are left alone.
 */
export function refusedProtocolSwitch(o: { packaged: boolean; inspectorUrl: string | undefined; hasSwitch: (name: string) => boolean }): string | null {
  if (!o.packaged || o.inspectorUrl) return null;
  return PROTOCOL_SWITCHES.find((s) => o.hasSwitch(s)) ?? null;
}

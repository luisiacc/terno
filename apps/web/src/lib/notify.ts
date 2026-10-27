/**
 * Plan 38 in the page. Desktop: main shows the badge. Elsewhere (the web, a
 * browser on the dev backend) the page puts the unread count on the
 * installed app's icon where the browser has setAppBadge.
 */
import { getApp, useApp } from "~/state/app";

type BadgeNavigator = Navigator & { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };

const desktop = () => typeof window !== "undefined" && !!window.ternoDesktop;

/** The browser can put a number on the installed app's icon. */
export const badgeSupported = (): boolean => !desktop() && typeof (navigator as BadgeNavigator).setAppBadge === "function";

function syncBadge(): void {
  const nav = navigator as BadgeNavigator;
  const { settings, counts } = getApp();
  const n = settings?.dockBadge ? counts.inboxUnread : 0;
  const done = n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.();
  // not installed, or not allowed: nothing to show
  void done?.catch(() => {});
}

/** At the end of boot. */
export function startAttention(): void {
  if (!badgeSupported()) return;
  syncBadge();
  let last = "";
  useApp.subscribe((s) => {
    const key = `${s.settings?.dockBadge}:${s.counts.inboxUnread}`;
    if (key === last) return;
    last = key;
    syncBadge();
  });
}

/**
 * Web-only pieces: none on the desktop, so its bundle holds nothing of the web host. The web build swaps this module for
 * `web-parts.web.tsx` (vite.config), which has the real ones.
 */
export const DesktopBanner = null as typeof import("~/web/nudge").DesktopBanner | null;
export const OnboardingNudge = null as typeof import("~/web/nudge").OnboardingNudge | null;
export const MacSection = null as typeof import("~/web/nudge").MacSection | null;
export const DesktopOnly = null as typeof import("~/web/nudge").DesktopOnly | null;
export const StorageSection = null as typeof import("~/web/storage-section").StorageSection | null;
/** which tab owns the mailbox, open errors, updates */
export const WebGate = null as typeof import("~/web/gate").WebGate | null;

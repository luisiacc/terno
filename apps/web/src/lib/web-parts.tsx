import { lazy } from "react";

/**
 * Web-only pieces, behind the compile-time target: the desktop bundle
 * contains none of them (each is null there and its chunk is never emitted).
 */
const WEB = import.meta.env.VITE_TARGET === "web";
const nudge = () => import("~/web/nudge");

export const DesktopBanner = WEB ? lazy(() => nudge().then((m) => ({ default: m.DesktopBanner }))) : null;
export const OnboardingNudge = WEB ? lazy(() => nudge().then((m) => ({ default: m.OnboardingNudge }))) : null;
export const MacSection = WEB ? lazy(() => nudge().then((m) => ({ default: m.MacSection }))) : null;
export const DesktopOnly = WEB ? lazy(() => nudge().then((m) => ({ default: m.DesktopOnly }))) : null;
export const StorageSection = WEB ? lazy(() => import("~/web/storage-section").then((m) => ({ default: m.StorageSection }))) : null;

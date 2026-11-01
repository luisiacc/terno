// Plan 99: whether this build connects Gmail with Terno's own Google client (no setup).
// The web build's client ID is public; the desktop's clients stay in its backend.
const WEB = import.meta.env.VITE_TARGET === "web";

/** the web build's own client ID ("" without one) */
export const webBuiltInClientId = (): string => (WEB ? (import.meta.env.VITE_TERNO_GOOGLE_CLIENT_ID as string | undefined) ?? "" : "");

/** the client the web signs in with: the one in Settings, else the build's */
export const webClientId = (settingsClientId: string | undefined): string => settingsClientId || webBuiltInClientId();

export const googleBuiltIn = (): boolean => (WEB ? webBuiltInClientId() !== "" : window.ternoDesktop?.googleBuiltIn === true);

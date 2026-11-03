// Plans 99 and 123: the web build signs in to Google with Terno's own client ID, the
// only one (it is public; the desktop's clients stay in its backend).
const WEB = import.meta.env.VITE_TARGET === "web";

/** the web build's own client ID ("" without one) */
export const webBuiltInClientId = (): string => (WEB ? (import.meta.env.VITE_TERNO_GOOGLE_CLIENT_ID as string | undefined) ?? "" : "");

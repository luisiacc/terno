import { create } from "zustand";

/**
 * "Cargar contenido", per message, for the session: the reader and printing
 * read the same answer, so a print never loads what the reader didn't.
 */
export const useRemoteConsent = create<{ allowed: ReadonlySet<number> }>(() => ({ allowed: new Set() }));

export function allowRemoteFor(messageId: number): void {
  const { allowed } = useRemoteConsent.getState();
  if (!allowed.has(messageId)) useRemoteConsent.setState({ allowed: new Set(allowed).add(messageId) });
}

/** The setting says always, or this message was allowed; local mode never loads remote content, whatever either says. */
export function remoteAllowed(messageId: number, settings: { remoteImages: "ask" | "always"; localMode: boolean }, allowed: ReadonlySet<number> = useRemoteConsent.getState().allowed): boolean {
  return !settings.localMode && (settings.remoteImages === "always" || allowed.has(messageId));
}

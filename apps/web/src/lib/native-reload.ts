import { create } from "zustand";

/** One disclosed, document-bound native refusal; main validates and consumes its action. */
export const useNativeReload = create<{ anyway: (() => void) | null }>(() => ({ anyway: null }));
export function installNativeReload(): void {
  window.ternoDesktop?.onReloadRefused?.((anyway) => useNativeReload.setState({ anyway }));
}

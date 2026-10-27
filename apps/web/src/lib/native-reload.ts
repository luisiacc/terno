import { create } from "zustand";

/** One disclosed, document-bound native refusal; main validates and consumes its action. */
export const useNativeReload = create<{ anyway: (() => void) | null; modalHost: HTMLElement | null; focusTarget: string | null }>(() => ({ anyway: null, modalHost: null, focusTarget: null }));
let modalOwner: { host: HTMLElement; root: HTMLElement | null; inert: boolean } | null = null;
const focusedAction = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest('[data-testid="native-reload-notice"]') ? active.dataset.testid ?? null : null;
};

/** The current fatal dialog owns placement and background modality together. */
export function registerNativeReloadModal(host: HTMLElement, root: HTMLElement | null): () => void {
  const focusTarget = focusedAction();
  const prior = modalOwner;
  if (prior?.root && prior.root !== root) prior.root.inert = prior.inert;
  const owner = { host, root, inert: prior?.root === root ? prior.inert : Boolean(root?.inert) };
  modalOwner = owner;
  if (root) root.inert = true;
  useNativeReload.setState({ modalHost: host, focusTarget });
  return () => {
    if (modalOwner !== owner) return;
    const focusTarget = focusedAction();
    modalOwner = null;
    if (root) root.inert = owner.inert;
    if (useNativeReload.getState().modalHost === host) useNativeReload.setState({ modalHost: null, focusTarget });
  };
}

export function installNativeReload(): void {
  window.ternoDesktop?.onReloadRefused?.((anyway) => useNativeReload.setState({ anyway }));
}

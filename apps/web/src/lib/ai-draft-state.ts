import { create } from "zustand";
import { client } from "~/rpc/connection";
import { draftingOffered } from "./ai";
import { getApp, useApp } from "~/state/app";

/**
 * Plan 133: AI drafting's state, which the send path can import without depending on `lib/ai-draft.ts` (that imports
 * the send path): whether it's on, which drafts have its row up, and the hooks `lib/ai-draft.ts` fills in.
 */

/** `open`: the row or strip is up; `writing`: a draft is on its way; `ready`: one waits for the draft to be opened again */
export type AiDraftBadge = "open" | "writing" | "ready";

export const useAiDraftUi = create<{ enabled: boolean; rows: Readonly<Record<string, AiDraftBadge>>; stylePage: boolean }>(() => ({ enabled: true, rows: {}, stylePage: false }));

export const aiDraftHooks: {
  /** a suggestion nobody has decided on: the row asks, and this send stops here (§10.4) */
  blocksSend: (key: string, sendAt?: number) => boolean;
  /** waits until what was committed has its provenance row, so the send can be compared with it */
  provenance: (key: string) => Promise<void>;
  /** Esc in the form: true when the row took it */
  escape: (key: string) => boolean;
  /** a preview is up: no ghost text under it */
  busy: (key: string) => boolean;
} = {
  blocksSend: () => false,
  provenance: () => Promise.resolve(),
  escape: () => false,
  busy: () => false,
};

/** Plan 147: the feature's own switch, and whether it can run at all. */
export const canDraft = (): boolean => useAiDraftUi.getState().enabled && draftingOffered(getApp());

export function useCanDraft(): boolean {
  const enabled = useAiDraftUi((s) => s.enabled);
  return useApp(draftingOffered) && enabled;
}

/** Whether the feature shows, read once at boot; Settings keeps it current. No side effects, as the contract promises. */
export async function loadDraftingEnabled(): Promise<void> {
  try {
    const prefs = await client.call("writing.prefs.get", {});
    useAiDraftUi.setState({ enabled: prefs.global.enabled });
  } catch {
    /* it stays on: asking is what would say otherwise, with the reason */
  }
}

import { create } from "zustand";
import { client } from "~/rpc/connection";
import { aiReady } from "./ai";
import { getApp } from "~/state/app";

/**
 * Plan 133: all of AI drafting the entry chunk holds. Whether it's on, which drafts have its row up (so a form mounts
 * the lazy row only then), and the hooks the send path and the forms call, which do nothing until the lazy module
 * (`lib/ai-draft.ts`, in the `ai-draft` chunk) has loaded: until then no draft can have anything in progress.
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

export type AiDraftModule = typeof import("~/components/composer/ai-draft");
export const loadAiDraft = (): Promise<AiDraftModule> => import("~/components/composer/ai-draft");

/** A draft opened with AI set up: ⌘J answers in the same frame. Nothing loads for someone who has none. */
export function preloadAiDraft(): void {
  if (useAiDraftUi.getState().enabled && aiReady(getApp().settings?.ai)) void loadAiDraft();
}

/** ⌘J, the Sparkles buttons and the palette: the row, on `key` if named, else on what's in front of the user (§5.3). */
export function openAiDraft(o: { key?: string; threadId?: number } = {}): void {
  if (!useAiDraftUi.getState().enabled) return;
  const app = getApp();
  if (app.dialog !== null || app.menuOpen) return;
  void loadAiDraft().then((m) => m.openRow(o));
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

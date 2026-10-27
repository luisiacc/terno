import { create } from "zustand";
import { getApp } from "~/state/app";
import { bodyCheckpoint, materialize, shownDraftKey, useDrafts, type BodyCheckpoint } from "./drafts";

/** An explicit recovery view replaces the failed app/editor owner, never duplicates it. */
export const useDraftRecovery = create<{ open: boolean; key: string | null; reason: "error" | "reload"; checkpoint?: BodyCheckpoint }>(() => ({ open: false, key: null, reason: "error" }));
export function reviewDrafts(reason: "error" | "reload" = "error"): void {
  const app = getApp(), drafts = useDrafts.getState().drafts;
  const key = app.compose?.key ?? (app.selectedId === null ? null : shownDraftKey(drafts, app.selectedId, app.draftShown)) ?? Object.values(drafts).find((d) => d.recovery)?.key ?? Object.keys(drafts)[0] ?? null;
  let checkpoint: BodyCheckpoint | undefined;
  if (key) {
    try { materialize(key); } catch (error) {
      checkpoint = bodyCheckpoint(key);
      if (!checkpoint) throw error;
    }
  }
  useDraftRecovery.setState({ open: true, key, reason, checkpoint });
}

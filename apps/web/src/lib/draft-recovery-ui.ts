import { create } from "zustand";
import { getApp } from "~/state/app";
import { materialize, shownDraftKey, useDrafts } from "./drafts";

/** An explicit recovery view replaces the failed app/editor owner, never duplicates it. */
export const useDraftRecovery = create<{ open: boolean; key: string | null }>(() => ({ open: false, key: null }));
export function reviewDrafts(): void {
  const app = getApp(), drafts = useDrafts.getState().drafts;
  const key = app.compose?.key ?? (app.selectedId === null ? null : shownDraftKey(drafts, app.selectedId, app.draftShown)) ?? Object.values(drafts).find((d) => d.recovery)?.key ?? Object.keys(drafts)[0] ?? null;
  if (key) materialize(key);
  useDraftRecovery.setState({ open: true, key });
}

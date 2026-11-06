import type { FollowupRow } from "@terno/core";
import { create } from "zustand";

/** Plan 142: the backend's last snapshot of what's active, by thread (lib/followups keeps it and acts on it). */
interface FollowupsState {
  rows: readonly FollowupRow[];
  byThread: ReadonlyMap<number, readonly FollowupRow[]>;
  /** the threads with something due: the sidebar's number */
  due: number;
  /** the threads on the Inbox's top */
  onTop: number;
  loaded: boolean;
}

export const useFollowups = create<FollowupsState>(() => ({ rows: [], byThread: new Map(), due: 0, onTop: 0, loaded: false }));

import { create } from "zustand";

/**
 * Plan 296: whether the reader shows a conversation's follow-up cards, one choice for every conversation (as the summary's
 * disclosure is), kept across launches. Hiding changes nothing about the follow-ups themselves.
 */
const KEY = "terno:followupsShown";

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) !== "hidden";
  } catch {
    return true;
  }
}

export const useFollowupsShown = create<{ shown: boolean }>(() => ({ shown: stored() }));

export function setFollowupsShown(shown: boolean): void {
  useFollowupsShown.setState({ shown });
  try {
    globalThis.localStorage?.setItem(KEY, shown ? "shown" : "hidden");
  } catch {
    /* a private window: it holds for this session */
  }
}

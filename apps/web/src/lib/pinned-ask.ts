import type { AskSourceRef, AskSourceView } from "@terno/core";
import { getApp, setApp } from "~/state/app";
import { openConversation, openSource, useAsk } from "./ask";
import { toggleAsk } from "./palette-open";
import { clearPinnedAnswer, usePinnedAsk } from "./pinned-ask-state";

/**
 * Plan 165: Ask's answer showing, pinned: a copy of it goes to the card, Ask's dialog closes, and the card takes focus
 * once the dialog has gone. Only a finished answer (not one being written, nor a command's outcome). False when there
 * is none.
 */
export function pinAnswer(): boolean {
  const s = useAsk.getState();
  const turn = s.turns.at(-1);
  if (s.running || s.conversationId === null || !turn || turn.kind === "command" || !turn.answer) return false;
  const views: Record<number, AskSourceView> = {};
  for (const source of turn.sources) {
    const view = s.sources[source.messageId];
    if (view) views[source.messageId] = view;
  }
  usePinnedAsk.setState((p) => ({ pinned: { conversationId: s.conversationId!, turn, views }, collapsed: false, focus: p.focus + 1 }));
  if (getApp().dialog === "palette") setApp({ dialog: null });
  return true;
}

/**
 * Unpin: the card goes, and (`toAsk`) its answer comes back into Ask's dialog, reopened from the history if Ask holds
 * another conversation now (which stops one being answered there, as opening one from the history does). Ask's own pin
 * button unpins in place (`toAsk: false`).
 */
export async function unpinAnswer({ toAsk = true }: { toAsk?: boolean } = {}): Promise<void> {
  const pinned = usePinnedAsk.getState().pinned;
  if (!pinned) return;
  clearPinnedAnswer();
  if (!toAsk) return;
  // deleted meanwhile (another window): there's nothing to go back to, and the card has gone with it
  if (useAsk.getState().conversationId !== pinned.conversationId && !(await openConversation(pinned.conversationId))) return;
  useAsk.setState({ usedAt: Date.now() });
  if (getApp().dialog === null) toggleAsk();
}

/** A citation or a source row on the card: the message, in the reader; the card stays, with focus (it's the way back). */
export function openPinnedSource(source: AskSourceRef): void {
  const pinned = usePinnedAsk.getState().pinned;
  if (!pinned) return;
  const still = () => usePinnedAsk.getState().pinned?.turn.id === pinned.turn.id;
  void openSource(source, undefined, still, { conversationId: pinned.conversationId });
}

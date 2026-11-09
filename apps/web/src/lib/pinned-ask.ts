import type { AskSourceRef, AskSourceView } from "@terno/core";
import { t } from "@terno/i18n";
import { getApp, setApp } from "~/state/app";
import { openConversation, openSource, useAsk } from "./ask";
import { toggleAsk } from "./palette-open";
import { clearPinnedAnswer, usePinnedAsk } from "./pinned-ask-state";
import { snack } from "./snack";

/** Each pin, unpin and source asked for (an object property: the React Compiler note): an answer for an older one changes nothing. */
const seq = { card: 0, source: 0 };

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
  seq.card++;
  seq.source++;
  usePinnedAsk.setState((p) => ({ pinned: { conversationId: s.conversationId!, turn, views }, collapsed: false, focus: p.focus + 1 }));
  if (getApp().dialog === "palette") setApp({ dialog: null });
  return true;
}

/**
 * Unpin: its answer comes back into Ask's dialog (`toAsk`), reopened from the history if Ask holds another conversation
 * now (which stops one being answered there, as opening one from the history does), and only then does the card go: a
 * read that fails keeps it, and says so; a pin or close meanwhile wins. Ask's own pin button unpins in place.
 */
export async function unpinAnswer({ toAsk = true }: { toAsk?: boolean } = {}): Promise<void> {
  const pinned = usePinnedAsk.getState().pinned;
  if (!pinned) return;
  const mine = ++seq.card;
  // and Ask as it was: a question asked or another conversation opened meanwhile isn't taken over (Codex review, round 2)
  const ask = useAsk.getState();
  const card = () => seq.card === mine && usePinnedAsk.getState().pinned === pinned;
  const current = () => {
    const now = useAsk.getState();
    return card() && now.conversationId === ask.conversationId && now.running === ask.running && now.turns === ask.turns;
  };
  if (toAsk && useAsk.getState().conversationId !== pinned.conversationId) {
    // checked before it commits; once it has, Ask holds this answer by our own hand
    const opened = await openConversation(pinned.conversationId, current).catch(() => null);
    if (opened ? !card() : !current()) return;
    if (opened === null) return void snack.warning(t("ask.pinned.unpinFailed"));
    // deleted meanwhile (another window): there's nothing to go back to
    if (!opened) return clearPinnedAnswer();
  }
  clearPinnedAnswer();
  if (!toAsk) return;
  useAsk.setState({ usedAt: Date.now() });
  if (getApp().dialog === null) toggleAsk();
}

/** The card's ×: it goes (the conversation stays in Previous AI questions). */
export function closePinnedAnswer(): void {
  seq.card++;
  seq.source++;
  clearPinnedAnswer();
}

/** A citation or a source row on the card: the message, in the reader; the card stays, with focus (it's the way back). */
export function openPinnedSource(source: AskSourceRef): void {
  const pinned = usePinnedAsk.getState().pinned;
  if (!pinned) return;
  // the last one asked for wins: an earlier one answering late doesn't take the reader back
  const mine = ++seq.source;
  const still = () => seq.source === mine && usePinnedAsk.getState().pinned === pinned;
  void openSource(source, undefined, still, { conversationId: pinned.conversationId });
}

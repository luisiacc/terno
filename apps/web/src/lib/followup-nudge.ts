import type { FollowupRow } from "@terno/core";
import { openRow, rowKeyOf, setInstruction, submit, type AiPhase } from "~/lib/ai-draft";
import { openStoredDraft } from "~/lib/compose";
import { editDraftRecipients, useDrafts } from "~/lib/drafts";
import { snack } from "~/lib/snack";

/** It talks to the model, not to a person, so it isn't translated: the draft's language follows plan 133. */
export const NUDGE_INSTRUCTION = "a short, friendly nudge about my last message";
/**
 * Plan 280: a promise of theirs, late. Fixed words: the promise's own (read from their mail) never reach the instruction,
 * which is the user's voice; the draft reads the conversation as material.
 */
export const OWED_INSTRUCTION = "a short, friendly reminder about what they said they would send or do, which hasn't arrived yet";

/** Plan 142 §7: the ordinary inline reply, with the one-tap draft running. Nothing is sent. */
export async function nudge(row: FollowupRow): Promise<void> {
  try {
    await openRow({ threadId: row.threadId });
    const key = rowKeyOf(row.threadId);
    if (!key) return;
    nudges.set(row.id, key);
    // To is who it's waiting on, whoever else the thread holds
    if (row.personEmail) editDraftRecipients(key, "to", row.personName ? `${row.personName} <${row.personEmail}>` : row.personEmail, []);
    setInstruction(key, row.kind === "theirs" ? OWED_INSTRUCTION : NUDGE_INSTRUCTION);
    await submit(key);
  } catch (error) {
    snack.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Plan 161, pass 2: the draft each follow-up's Write a follow-up made, while it's there: the line offers it, not another.
 * Plan 280 (revision 11): by the follow-up, not the conversation: a wait and a promise of theirs on one each have their own.
 */
const nudges = new Map<number, string>();

/** The nudge drafted for this follow-up, if it's still a draft (sent or discarded, it's gone). */
export function nudgeDraft(followupId: number, drafts = useDrafts.getState().drafts): string | null {
  const key = nudges.get(followupId);
  if (key === undefined) return null;
  if (drafts[key]) return key;
  nudges.delete(followupId);
  return null;
}

/** "Open your follow-up": that draft (not whichever the conversation shows), in view, with the caret in it. */
export async function openNudge(followupId: number): Promise<void> {
  const key = nudgeDraft(followupId);
  if (key) await openStoredDraft(key);
}

/**
 * Plan 162 (after ai162-r03): where the draft Write a follow-up made stands, from its ⌘J session: still being written,
 * waiting on the user (a question, an error), or written (the strip, or the row closed with it placed). The card offers
 * "Open your follow-up" only once it's written.
 */
export function nudgeState(phase: AiPhase | undefined): "writing" | "waiting" | "written" {
  if (phase === "writing" || phase === "waitingBody" || phase === "resolving") return "writing";
  if (phase === "input" || phase === "question" || phase === "noProvider" || phase === "error") return "waiting";
  return "written";
}

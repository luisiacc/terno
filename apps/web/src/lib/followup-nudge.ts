import type { FollowupRow } from "@terno/core";
import { snack } from "~/lib/snack";

/** It talks to the model, not to a person, so it isn't translated: the draft's language follows plan 133. */
export const NUDGE_INSTRUCTION = "a short, friendly nudge about my last message";

/** Plan 142 §7: the ordinary inline reply, with the one-tap draft running. Nothing is sent. */
export async function nudge(row: FollowupRow): Promise<void> {
  try {
    const { openRow, setInstruction, submit, rowKeyOf } = await import("~/lib/ai-draft");
    const { editDraftRecipients } = await import("~/lib/drafts");
    await openRow({ threadId: row.threadId });
    const key = rowKeyOf(row.threadId);
    if (!key) return;
    // To is who it's waiting on, whoever else the thread holds
    if (row.personEmail) editDraftRecipients(key, "to", row.personName ? `${row.personName} <${row.personEmail}>` : row.personEmail, []);
    setInstruction(key, NUDGE_INSTRUCTION);
    await submit(key);
  } catch (error) {
    snack.error(error instanceof Error ? error.message : String(error));
  }
}

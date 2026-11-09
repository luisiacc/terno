import { openRow } from "~/lib/ai-draft";
import { snack } from "~/lib/snack";

/**
 * Plan 162 (after ai162-r01): a summary item's Reply drafts from it. The ordinary reply opens with ⌘J's row holding the
 * item as its instruction and the keys in it, ready for Return; nothing is written until the user asks (no model call
 * here), and the instruction can be changed first. It opened a blank reply, and the suggestion was lost.
 */
export async function replyFromItem(threadId: number, text: string): Promise<void> {
  try {
    // Codex review: seeded where the reply really landed, never into a draft an open that was cancelled found afterwards
    await openRow({ threadId, instruction: text.trim() });
  } catch (error) {
    snack.error(error instanceof Error ? error.message : String(error));
  }
}

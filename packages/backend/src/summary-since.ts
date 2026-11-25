import type { SummarySourceMessage } from "@terno/store";

/**
 * Plan 279: where what's new to the reader starts, as a message id (null: no since for this summary).
 *
 * The new part is the conversation's last run of messages someone else wrote that are new to the reader: unread, or
 * arrived as new mail since the last summary (a fresh mark: the 450 ms read of plan 225 comes before any summary), or at
 * or after what the reader saw unread in this showing (`snapshot`, by hand). It ends at the last message that is the
 * reader's own, or read and not new: one stray old unread message, or Mark as unread used as a reminder, doesn't make
 * the whole conversation new, and a reply of theirs means they were there. A since needs something before it.
 *
 * Nothing new, but a since already stored (`stored`): a summary made again with no newer mail (a body arriving late,
 * Summarize again) keeps it, while that message is there and nothing of the reader's comes after it: a since stays
 * until newer mail replaces it (the owner, plan 279).
 */
export function sinceBoundary(messages: readonly SummarySourceMessage[], o: { floor: number; snapshot: number | null; stored: number | null }): number | null {
  const list = messages.filter((m) => !m.trash && !m.spam);
  const at = (id: number | null) => (id === null ? -1 : list.findIndex((m) => m.id === id));
  const seen = at(o.snapshot);
  // the same test the worker's eligibility uses: an expired or left-behind mark says nothing
  const fresh = (m: SummarySourceMessage) => m.markedAt !== null && m.markedAt >= o.floor && !m.code;
  const isNew = (m: SummarySourceMessage, i: number) => !m.own && (!m.read || fresh(m) || (seen >= 0 && i >= seen));
  let anchor = list.length - 1;
  while (anchor >= 0 && isNew(list[anchor]!, anchor)) anchor--;
  if (anchor < 0) return null;
  if (anchor < list.length - 1) return list[anchor + 1]!.id;
  const kept = at(o.stored);
  return kept > 0 && !list.slice(kept).some((m) => m.own) ? list[kept]!.id : null;
}

/** The since a stored result carries, if any: which message it starts at. */
export function storedSince(bodyJson: string | null): number | null {
  if (!bodyJson) return null;
  try {
    const from = (JSON.parse(bodyJson) as { since?: { from?: unknown } }).since?.from;
    return typeof from === "number" ? from : null;
  } catch {
    return null;
  }
}

import { splitZoneNote, type FeedRowId, type ItemSeen } from "@terno/core";
import { t } from "@terno/i18n";
import { composeLanding } from "~/lib/compose";
import type { TodayTask } from "~/lib/dated";
import { currentPage, listLayout, openThread } from "~/lib/page";
import type { ReaderItem } from "~/lib/reader-items";
import { snack } from "~/lib/snack";
import { datedDay, dueShort } from "~/lib/when";
import { client } from "~/rpc/connection";
import { getApp } from "~/state/app";
import { openFeedRow } from "~/state/today";

/**
 * Plan 210 (iteration 4, the owner's "Hand to someone"): an item of What matters handed to a person. Hand to… (the row's
 * menu, the reader's line, the palette) opens an inline forward of the item's conversation in the reader, as composing
 * always is, its To field taking the recipient (the composer's own autocomplete), with one line asking them to take care of
 * it. The hand-off rides with the draft; the item closes only when the forward's send is confirmed (the backend), so Undo
 * send, a cancel or a failure leave it open.
 */

/** The item's words as a line says them: no zone note or full stop, lower-case where it's an ordinary first word. */
function words(text: string): string {
  const bare = splitZoneNote(text.trim()).text.replace(/[.\s]+$/u, "");
  return /^\p{Lu}\p{Ll}/u.test(bare) ? bare[0]!.toLocaleLowerCase() + bare.slice(1) : bare;
}

/**
 * "Could you take care of this: sign the field trip form (by Fri)?" (es "¿Puedes encargarte de esto: …"): its day only when
 * it names one still ahead (today, tomorrow, a weekday, a date); none for an undated item or one already past.
 */
export function handOffLine(text: string, dueAt: number | null, now = Date.now()): string {
  const item = words(text);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (dueAt === null || dueAt < today.getTime()) return t("whatMatters.handTo.lineUndated", { item });
  const near = datedDay(dueAt, now).near;
  const day = near === "today" || near === "tomorrow" ? t(`today.also.${near}`) : t("today.also.on", { day: dueShort(dueAt, false, now) });
  return t("whatMatters.handTo.line", { item, day });
}

/** The item a feed row's task is, as it was seen. */
export const seenOfTask = (task: TodayTask): ItemSeen => (task.kind === "dated" ? { source: "dated", id: task.item.id, revision: task.item.revision } : { source: "promise", id: task.id, revision: task.revision });

/** The item the reader's line shows, as it was read. */
export const seenOfReaderItem = (item: ReaderItem): ItemSeen => ({ source: item.source, id: item.row.id, revision: item.row.revision });

let handing = 0;

/**
 * Hand to…: the item resolved as Done on its row would be (its members, what a promise of it answers), its conversation
 * open (the row's, when it's a feed row), and the forward opened there with the hand-off. False when nothing opened (it
 * changed meanwhile, a newer Hand to… took over, or the conversation's draft is a pinned reply).
 */
export async function handTo(seen: ItemSeen, rowId?: FeedRowId): Promise<boolean> {
  const mine = ++handing;
  let h: Awaited<ReturnType<typeof client.call<"today.handoff">>>;
  try {
    h = await client.call("today.handoff", seen);
  } catch (error) {
    snack.error(t("whatMatters.handTo.failed", { error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
  if (mine !== handing) return false;
  if (rowId !== undefined && getApp().today) openFeedRow(rowId);
  // the conversation open, as Forward from the list opens it (List: as its page)
  if (getApp().selectedId !== h.threadId || (listLayout() && currentPage() === "list")) {
    openThread(h.threadId);
    // the reader mounts for it first, so the forward lands in that reader (a draft it left there is resumed in it)
    await new Promise((r) => requestAnimationFrame(r));
    if (mine !== handing || getApp().selectedId !== h.threadId) return false;
  }
  const landing = await composeLanding("forward", h.threadId, 0, undefined, undefined, { sourceId: h.messageId, handoff: { handoff: { items: h.items }, line: handOffLine(h.text, h.dueAt) } });
  return landing.kind !== "none";
}

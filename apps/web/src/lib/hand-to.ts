import { splitZoneNote, type FeedRowId, type ItemSeen, type PartOfDay } from "@terno/core";
import { t } from "@terno/i18n";
import { composeLanding } from "~/lib/compose";
import type { TodayTask } from "~/lib/dated";
import { currentPage, listLayout, openThread } from "~/lib/page";
import type { ReaderItem } from "~/lib/reader-items";
import { snack } from "~/lib/snack";
import { datedDay, dueShort, partDay, partInSentence, reminderTime } from "~/lib/when";
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
 * The claims ledger's second batch (María's book fair, Priya's deck): an item's words are written to the reader ("send Jess
 * your board meeting deck draft", "which shift you can take"); in a line to someone else they're the reader's own, or the
 * receiver is asked for theirs: "my deck draft", "which shift I can take" (es "tu" → "mi", "tus" → "mis", "contigo" →
 * "conmigo"). A "you" after a verb or a preposition is "me" ("send you the form" → "send me the form"). Only this line.
 */
const FROM = String.raw`(?<![\p{L}\p{N}'’-])`;
const UPTO = String.raw`(?![\p{L}\p{N}'’-])`;
const MINE: readonly [RegExp, string][] = [
  [new RegExp(`${FROM}yourself${UPTO}`, "giu"), "myself"],
  [new RegExp(`${FROM}yours${UPTO}`, "giu"), "mine"],
  [new RegExp(`${FROM}your${UPTO}`, "giu"), "my"],
  [new RegExp(`${FROM}you(?:['’]re| are)${UPTO}`, "giu"), "I'm"],
  [new RegExp(`${FROM}you were${UPTO}`, "giu"), "I was"],
  [new RegExp(`${FROM}you['’](ve|ll|d)${UPTO}`, "giu"), "I'$1"],
  [new RegExp(`${FROM}(to|for|with|from|at|about|on|by|of|send|give|tell|meet|remind|ask|call|email|text|cc|let|help|thank|show|pay|owe|join|invite|see|reach|pick) +you${UPTO}`, "giu"), "$1 me"],
  [new RegExp(`${FROM}you${UPTO}`, "giu"), "I"],
  [new RegExp(`${FROM}tus${UPTO}`, "giu"), "mis"],
  [new RegExp(`${FROM}tu${UPTO}`, "giu"), "mi"],
  [new RegExp(`${FROM}tuy([oa]s?)${UPTO}`, "giu"), "mí$1"],
  [new RegExp(`${FROM}contigo${UPTO}`, "giu"), "conmigo"],
];
const asMine = (text: string): string => MINE.reduce((s, [re, to]) => s.replace(re, to), text);

/** When a handed item is due: its moment, and whether that's a clock time or a part of its day (neither: the whole day). */
export interface HandOffWhen {
  dueAt: number | null;
  timed?: boolean;
  partOfDay?: PartOfDay | null;
}

/**
 * "Could you take care of this: sign the field trip form (by Fri)?" (es "¿Puedes encargarte de esto: …"): its day only when
 * it names one still ahead (today, tomorrow, a weekday, a date); none for an undated item or one already past. Round 14's
 * faults (Priya's payroll wire lost "1:00 PM"): with its time when it has one ("by today 1:00 PM", es "para hoy 13:00"), and
 * its part of the day when that's what it has ("by tomorrow morning", es "para mañana por la mañana").
 */
export function handOffLine(text: string, when: HandOffWhen, now = Date.now()): string {
  const item = asMine(words(text));
  const { dueAt } = when;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (dueAt === null || dueAt < today.getTime()) return t("whatMatters.handTo.lineUndated", { item });
  const near = datedDay(dueAt, now).near;
  const part = !when.timed && when.partOfDay ? partDay(dueAt, when.partOfDay, now) : null;
  const day = part
    ? part.near ? partInSentence(part.text) : t("today.also.on", { day: part.text })
    : near === "today" || near === "tomorrow" ? t(`today.also.${near}`) : t("today.also.on", { day: dueShort(dueAt, false, now) });
  return t("whatMatters.handTo.line", { item, day: when.timed ? `${day} ${reminderTime(dueAt)}` : day });
}

/** The item a feed row's task is, as it was seen. */
export const seenOfTask = (task: TodayTask): ItemSeen => (task.kind === "dated" ? { source: "dated", id: task.item.id, revision: task.item.revision } : { source: "promise", id: task.id, revision: task.revision });

/** A reply's row's other promises (its Also lines), handed with it as the row's Done takes them (iteration 4, merge). */
export const othersOfTask = (task: TodayTask): ItemSeen[] => (task.kind === "promise" ? (task.with ?? []) : []);

/** The item the reader's line shows, as it was read. */
export const seenOfReaderItem = (item: ReaderItem): ItemSeen => ({ source: item.source, id: item.row.id, revision: item.row.revision });

let handing = 0;

/**
 * Hand to…: the item resolved as Done on its row would be (its members, what a promise of it answers, a reply's row's
 * other promises: `others`), its conversation open (the row's, when it's a feed row), and the forward opened there with
 * the hand-off. False when nothing opened (it changed meanwhile, a newer Hand to… took over, or the conversation's draft is
 * a pinned reply).
 */
export async function handTo(seen: ItemSeen, rowId?: FeedRowId, others: readonly ItemSeen[] = []): Promise<boolean> {
  const mine = ++handing;
  let h: Awaited<ReturnType<typeof client.call<"today.handoff">>>;
  try {
    h = await client.call("today.handoff", others.length ? { ...seen, with: others.map((o) => ({ source: "promise" as const, id: o.id, revision: o.revision })) } : seen);
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
  const landing = await composeLanding("forward", h.threadId, 0, undefined, undefined, { sourceId: h.messageId, handoff: { handoff: { items: h.items }, line: handOffLine(h.text, h) } });
  return landing.kind !== "none";
}

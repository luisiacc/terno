import { dayKeyOf, dueCutoff, mailDay, promiseDay, refKey, withNeeds, withoutAnswered, type DatedRow, type FollowupRow, type ItemRef, type NeedingPromise } from "@terno/core";
import { t } from "@terno/i18n";
import { conversationItem, datedLine, datedText, promiseWhen } from "~/lib/dated";
import { followupLine } from "~/lib/followups";
import { promiseDayWords } from "~/lib/today-sentence";

/**
 * Plan 210 (iteration 3, Codex revision 10): the reader's one model of a conversation's items. What the feed's open row is
 * (its every member, or a history line's closed item), the conversation's dated items and promises of yours, each read
 * once, resolved to one item on top (the open row's, or one chosen from the line under it, or the soonest) and the others
 * once each, true duplicates (`sameAs`) as one. Nudges (waiting on a reply) aren't items: they keep their own card.
 */
export type ReaderItem = {
  /** what it is, by its key ("dated:42"): the line's identity, and what choosing it names */
  key: string;
  ref: ItemRef;
  /** open: Done, Later and Remove act on it; closed: a history line opened, said with what happened */
  open: boolean;
  missed: boolean;
  /** for the order: soonest first */
  dueAt: number;
} & ({ source: "dated"; row: DatedRow } | { source: "promise"; /** with the day of the request it answers, as the feed reads it */ row: NeedingPromise });

export interface ReaderItems {
  top: ReaderItem | null;
  /** the conversation's other open items, soonest first: the quiet line under the top one */
  others: ReaderItem[];
  /** the top one is what the feed's open row is */
  targeted: boolean;
  /** the top one is there by the user's choice (from the line under it): what D, b, ⇧D and the palette act on */
  chose: boolean;
  /**
   * plan 216: the feed's open row is this conversation's waiting row: its line leads the card (`top` null, the items its
   * Also), or, with an item chosen leading, it's the first on the Also line
   */
  waiting: "top" | "also" | null;
}

export interface ReaderInput {
  /** the conversation's dated items, as `dated.ofThread` reads them (a history line's closed one included) */
  dated: readonly DatedRow[];
  /** its follow-ups (promises are items; a nudge is left out here) and a history line's closed promise, if read */
  followups: readonly FollowupRow[];
  /** the feed's open row's items, its lead first; empty when the feed has none of this conversation open */
  target: readonly ItemRef[];
  /** an item chosen from the line under the top one, by its key: it's on top while it's there */
  chosen: string | null;
  /** plan 216: the feed's open row is this conversation's waiting row (a person waiting isn't an item: the row is its own) */
  waiting: boolean;
  now: number;
}

const NONE: ReaderItems = { top: null, others: [], targeted: false, chose: false, waiting: null };
const WAITING: ReaderItems = { ...NONE, waiting: "top" };

/** A promise of yours still to keep: open, or due (follow-ups' "it's time"). */
const openPromise = (r: FollowupRow): boolean => r.state === "open" || r.state === "due";

export function readerItems({ dated, followups, target, chosen, waiting, now }: ReaderInput): ReaderItems {
  const targetKeys = new Set(target.map(refKey));
  const items: ReaderItem[] = [];
  // plan 210 (iteration 4, design point 2): a request an open promise of yours answers is that promise's line, never a
  // line of its own ("Also in this conversation"): the feed's rule (`withoutAnswered`), a history line's closed one aside
  const shown = new Set(withoutAnswered(dated, followups).map((r) => r.id));
  for (const row of dated) {
    if (!shown.has(row.id) && !targetKeys.has(refKey({ source: "dated", id: row.id }))) continue;
    const ref = { source: "dated", id: row.id } as const;
    const at = conversationItem(row, now);
    // a closed one only as what a history line names; one over (a plan ended) not at all
    if (at) items.push({ key: refKey(ref), ref, open: true, missed: at.missed, dueAt: row.dueAt, source: "dated", row });
    else if (row.state !== "open" && targetKeys.has(refKey(ref))) items.push({ key: refKey(ref), ref, open: false, missed: false, dueAt: row.dueAt, source: "dated", row });
  }
  // (iteration 4, merge) each promise with the day of the request it answers and the day it sits under, as the feed's row
  // has them (`promiseDay`): a promise broken with a live day ahead isn't missed, and its line says the days the row says
  const requests = new Map(dated.map((r) => [r.id, r]));
  for (const row of withNeeds(followups, requests)) {
    // plan 210 (iteration 4): a promise that only holds a request ("let me check and get back to you") is the request's
    if (row.kind !== "promise" || row.holds != null) continue;
    const ref = { source: "promise", id: row.id } as const;
    const open = openPromise(row);
    if (!open && !targetKeys.has(refKey(ref))) continue;
    const day = promiseDay(row, now);
    items.push({ key: refKey(ref), ref, open, missed: open && day.dated && now >= dueCutoff(dayKeyOf(day.dueAt), day.part), dueAt: day.dueAt, source: "promise", row });
  }
  if (!items.length) return waiting ? WAITING : NONE;
  // one thing read twice is one line: the feed's open row's members together, else each with its canonical
  const groupOf = (i: ReaderItem): string => {
    const same = i.row.sameAs ?? null;
    if (targetKeys.has(i.key) || (same !== null && targetKeys.has(same))) return "target";
    return same ?? i.key;
  };
  const groups = new Map<string, ReaderItem[]>();
  for (const i of items) groups.set(groupOf(i), [...(groups.get(groupOf(i)) ?? []), i]);
  // each group's line is its lead: the open row's own (members come lead first), else its canonical, else the first
  const lead = (id: string, members: ReaderItem[]): ReaderItem => {
    if (id === "target") {
      for (const r of target) {
        const hit = members.find((m) => m.key === refKey(r));
        if (hit) return hit;
      }
    }
    return members.find((m) => m.key === id) ?? members[0]!;
  };
  const lines = [...groups].map(([id, members]) => ({ id, item: lead(id, members), keys: members.map((m) => m.key) }));
  // Missed first, then soonest (the order the conversation's own line always had)
  const order = (a: ReaderItem, b: ReaderItem) => Number(b.missed) - Number(a.missed) || a.dueAt - b.dueAt;
  const open = lines.filter((l) => l.item.open).sort((a, b) => order(a.item, b.item));
  const picked = chosen !== null ? lines.find((l) => l.keys.includes(chosen) && l.item.open) : undefined;
  // plan 216: the open row a person waiting on you: its line leads, unless an item was chosen under it
  if (waiting) return { top: picked?.item ?? null, others: open.filter((l) => l !== picked).map((l) => l.item), targeted: false, chose: picked !== undefined, waiting: picked ? "also" : "top" };
  const top = picked ?? lines.find((l) => l.id === "target") ?? open[0];
  if (!top) return NONE;
  return { top: top.item, others: open.filter((l) => l !== top).map((l) => l.item), targeted: top.id === "target", chose: top === picked, waiting: null };
}

/**
 * Plan 216: the open waiting row's line, its when the feed row's own: "Lucas Fajardo is waiting on your reply · since Oct 21",
 * "… · back Fri 9:00 AM" (put off with Later).
 */
export const waitingLine = (name: string, when: string): string => t("whatMatters.waiting.line", { name, when });

/** The line's words: "Due Friday · Pay the electricity bill", "Due today · You told Jess you'd send the script". */
export function readerLine(item: ReaderItem, now = Date.now()): string {
  if (item.source === "dated") return item.open ? datedLine({ ...item.row, mailDay: mailDay(item.row) }, item.missed, now) : datedText(item.row);
  const words = followupLine(item.row, now, { short: true });
  const when = item.open ? promiseLineWhen(item.row, item.missed, now) : null;
  return when ? t("today.why.line", { when, text: words }) : words;
}

/**
 * An open promise's when, in the reader's words ("Due Sunday", "Was due Wednesday"), with what the feed's row says beside
 * its day (`promiseDayWords`): "You said Tue 20 (missed) · needed Sun", "Due Wednesday · needed Fri".
 */
function promiseLineWhen(row: NeedingPromise, missed: boolean, now: number): string | null {
  const day = promiseDay(row, now);
  const own = promiseWhen({ ...day, partOfDay: day.part }, missed, now);
  return own === null || missed ? own : promiseDayWords(day, day.dueAt, own, now).text;
}

/** What its buttons name it by: the task's own words ("Done: Pay the electricity bill"). */
export const readerText = (item: ReaderItem): string => (item.source === "dated" ? datedText(item.row) : item.row.text);

/**
 * The summary's To do, less what the reader's line already says (Codex revision 10): an item of the summary repeats one of
 * these when every word that carries its meaning is among the summary item's ("Send the script; a rough draft is
 * acceptable, by Friday" repeats "send Jess the script"). Names (a capital past the first word) needn't be there: a summary
 * often leaves out who. In this view only: the summary itself is never changed.
 */
export function repeatsItem(summaryText: string, itemTexts: readonly string[]): boolean {
  const theirs = meaningWords(summaryText);
  return itemTexts.some((text) => {
    const all = meaningWords(text);
    const named = meaningWords(text, true);
    const ours = named.length >= 2 ? named : all;
    return ours.length >= 2 && ours.every((w) => theirs.some((x) => sameWord(w, x)));
  });
}

/** Words that aren't there for grammar, in either language, lower-cased and without accents; `noNames`, without names too. */
function meaningWords(text: string, noNames = false): string[] {
  return text
    .split(/[^\p{L}\p{N}$€£.,]+/u)
    .map((w) => w.replace(/[.,]+$/, ""))
    .filter((w, i) => !noNames || i === 0 || !/^\p{Lu}/u.test(w))
    .map((w) => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase())
    .filter((w) => w.length >= 3 && !GRAMMAR.has(w));
}

/** "send" and "sending", "paper" and "papers": one word's forms, by a shared start of four letters or more. */
const sameWord = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

const GRAMMAR = new Set([
  "the", "and", "for", "you", "your", "yours", "with", "from", "that", "this", "these", "those", "about", "into", "onto", "before", "after", "will", "would", "can", "could", "should", "please", "them", "their", "his", "her", "its", "our", "out", "back", "by", "all", "any", "some", "one", "who", "what", "when", "which", "there", "here", "then", "than", "also", "just", "said", "told", "today", "tomorrow",
  "los", "las", "una", "uno", "unos", "unas", "del", "por", "para", "con", "que", "sus", "tus", "este", "esta", "estos", "estas", "ese", "esa", "antes", "despues", "hoy", "manana", "tambien", "dijiste", "ibas",
]);

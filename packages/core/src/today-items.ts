
/**
 * Plan 210 (iteration 2, the owner: "a row per item"): What matters' rows are items, each with its own identity, never a
 * conversation's. A dated item and a promise of yours are each an `ItemRef`; true duplicates share one canonical's (their
 * `sameAs`), and the row's id is that canonical's key. A conversation waiting on you and your reminder on one have their own
 * namespaces; the digest has one row. Never a date, a section, a revision or a position: the row's id is what the feed's
 * cursor, selection, held rows and scroll anchor keep across reloads.
 */

export type ItemSource = "dated" | "promise";

export interface ItemRef {
  source: ItemSource;
  id: number;
}

/** "dated:42", "promise:7": an item's key, what `sameAs` stores and a row's id is. */
export const refKey = (r: ItemRef): string => `${r.source}:${r.id}`;

export function parseRef(key: string): ItemRef | null {
  const m = /^(dated|promise):(\d+)$/.exec(key);
  return m ? { source: m[1] as ItemSource, id: Number(m[2]) } : null;
}

/** A feed row's identity: an item's key, `waiting:<thread>`, `reminder:<thread>`, or the digest's. */
export type FeedRowId = string;

export const waitingRowId = (threadId: number): FeedRowId => `waiting:${threadId}`;
export const reminderRowId = (threadId: number): FeedRowId => `reminder:${threadId}`;
export const DIGEST_FEED_ROW: FeedRowId = "digest";

/** An item with the revision it was seen at: what an act on a row names, each member of a merged one. */
export interface ItemSeen extends ItemRef {
  revision: number;
}

/**
 * An item's words ending in the mail's own time and zone, as the dated reader writes them (prompt v10): "(4:00 PM PT)",
 * "(18:00 hora de Ciudad de México)", "(5:00 PM Eastern)". Shared with `@terno/ai`, which keeps the note in step with a move.
 * Round 19 (Sam's "(9 credits minimum; or lose full-time status and funding)", read as the clock "9" in the zone "…full-time…"):
 * a note is a clock and a zone's name, never any words that hold "time": an abbreviation ("PT", "CET", "UTC+2"), a region's
 * ("Eastern", "Pacific Time"), a name ending in "Time" ("Central European Time") or "hora"/"horario" and its place ("hora del
 * centro"). A stake the reader wrote before it in the same bracket ("(late responses not considered; 5:00 PM Eastern)") is
 * `stake`, and stays with the words.
 */
export const ZONE_NOTE =
  /\s*\((?:(?<stake>[^()]*?)[;,]\s*)?(?<clock>\d{1,2}(?::\d{2})?)(?<meridiem>\s*[AaPp]\.?\s?[Mm]\.?)?\s+(?<zone>[A-Z]{2,5}(?:[+-]\d{1,2})?|(?:Eastern|Pacific|Central|Mountain|Atlantic)(?:\s+(?:Standard|Daylight))?(?:\s+[Tt]ime)?|(?:\p{Lu}[\p{L}.'’-]*\s+){1,3}[Tt]ime|(?:hora|horario)(?:\s+[^\s();,][^();,]*)?)\)\s*$/u;

/** Words with a matched note taken off, a stake before it kept in its own bracket ("Submit the RFP (late responses not considered)"). */
export const withoutZoneNote = (text: string, m: RegExpExecArray): string => {
  const bare = text.slice(0, m.index).trimEnd();
  const stake = m.groups?.stake?.trim();
  return stake ? `${bare} (${stake})` : bare;
};

/**
 * Plan 210 (iteration 2, one time per row): an item's words and the mail's own time in its zone, apart. The row's when column
 * says the time (the reader's, then this in brackets); its sentence never does. Words with no note come back as they are.
 */
export function splitZoneNote(text: string): { text: string; note: string | null } {
  const m = ZONE_NOTE.exec(text);
  if (!m) return { text, note: null };
  const g = m.groups!;
  return { text: withoutZoneNote(text, m), note: `${g.clock}${g.meridiem ?? ""} ${g.zone}`.replace(/\s+/gu, " ").trim() };
}

/** Zones a promise's words may name that read one way only (IST, CST and the like don't): their places. */
const ZONES: Readonly<Record<string, string>> = {
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver", mountain: "America/Denver",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", eastern: "America/New_York",
  utc: "UTC", gmt: "UTC",
};

/**
 * "at 4:00 PM", "at 4 pm PT", "a las 16:00", "a las 4 de la tarde" is not read (words, not a clock). The clock and where it
 * was found, so the sentence can leave it out.
 */
const CLOCK = /\s*\b(?:at|by|a las|antes de las)\s+(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?(?:\s+([A-Z]{1,3}T|UTC|pt|pst|pdt|mt|mst|mdt|ct|cst|cdt|et|est|edt|utc|gmt|ist|bst|Pacific|Mountain|Central|Eastern|Atlantic)(?:\s+[Tt]ime)?)?\b/u;

export interface StatedClock {
  /** "HH:MM" on the clock it was said on */
  time: string;
  /** the zone it named (a place), or null: the reader's own */
  zone: string | null;
  /** its words as written ("4:00 PM PT"), what the when column brackets when the zone isn't the reader's */
  note: string;
  /** the words without it */
  rest: string;
}

/**
 * Plan 210 (iteration 2, A7): the time a promise of yours states in its words, only a real clock ("at 4:00 PM", "a las
 * 16:00"), with a zone only where its name reads one way; never the scheduling default a promise without one gets. Null:
 * none, or one that isn't a time of day.
 */
export function statedClock(text: string): StatedClock | null {
  const m = CLOCK.exec(text);
  // an offset after the zone ("UTC+2") is a zone this doesn't read: no clock at all (Codex code review)
  if (!m || /^\s*[+-]\s?\d/u.test(text.slice(m.index + m[0].length))) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.replace(/[\s.]/gu, "").toLowerCase();
  // "at 4" with neither minutes nor am/pm is a number, not a time
  if (m[2] === undefined && !meridiem) return null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (meridiem.startsWith("p") ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  // a zone named that doesn't read one way (CST, IST, BST…): its time can't be placed, so the promise keeps its words, untimed
  const zone = m[4] ? (ZONES[m[4].toLowerCase()] ?? undefined) : null;
  if (zone === undefined) return null;
  const said = m[0].trim().replace(/^(?:at|by|a las|antes de las)\s+/iu, "");
  return { time: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`, zone, note: said, rest: `${text.slice(0, m.index)}${text.slice(m.index + m[0].length)}`.replace(/\s{2,}/gu, " ").trim() };
}

/**
 * Whether a moment is still the stated clock (Codex code review of iteration 2): a promise moved to another time keeps its
 * old words, whose time and zone then aren't the row's to say.
 */
export function clockHolds(ms: number, clock: Pick<StatedClock, "time" | "zone">): boolean {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(clock.zone ? { timeZone: clock.zone } : {}) }).format(ms) === clock.time;
  } catch {
    return false;
  }
}

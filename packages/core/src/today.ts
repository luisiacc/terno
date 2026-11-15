import type { AppSettings } from "./rpc/contract";
import type { ThreadSummary } from "./types";
import { aiReady } from "./ai-routing";
import { datedGroup, type DatedKind, type TodayGroupKind } from "./dated";
import { withoutQuotes } from "./text";

/** Plan 145: what needs you today, and newsletters folded into one digest. Local but for the digest, which is its own opt-in. */

export const DIGEST_CANDIDATES_MAX = 40;
export const DIGEST_WINDOW_MS = 3 * 86_400_000;
export const DIGEST_KEEP_DAYS = 14;
export const DIGEST_LINE_CHARS = 140;
/** the list's row for the digest: no thread has it */
export const DIGEST_ROW_ID = 0;
/** what a notice's click opens when it's the brief: no thread has it */
export const BRIEF_NOTICE_THREAD = -1;

export interface TodaySetting {
  show: boolean;
  /** HH:MM, local */
  prepareAt: string;
  notify: boolean;
  digest: boolean;
  /** plan 210 (the owner): the history ("Earlier") under the open part; off, only what's left, an inbox-zero feeling */
  finished: boolean;
}

export const DEFAULT_TODAY: TodaySetting = { show: true, prepareAt: "08:00", notify: false, digest: false, finished: true };

/**
 * Who sees Today: a provider set up, or (once plan 85's Pro exists) an active entitlement. One helper, so Pro joins in one
 * line.
 */
export function aiFeaturesAvailable(settings: Pick<AppSettings, "ai"> | null | undefined, entitlement?: { active: boolean } | null): boolean {
  if (entitlement?.active === true) return true;
  // plan 168: what can run, by the one rule (on keys, either usable one; elsewhere a model, its endpoint, its key)
  return aiReady(settings?.ai);
}

export interface TodayWhy {
  /** the sixth panel round (change 4): no nudge, what you wait on from others: What matters tracks your own promises */
  kind: "promise" | "waiting" | "reminder" | "dated";
  text?: string;
  dueAt?: number;
  personName?: string | null;
  /** the fourth panel round (revision 9): a promise's person, whom its row names and pictures */
  personEmail?: string | null;
  sentAt?: number;
  /** a waiting row: you've written in this conversation (else it's new, from someone you write to: `needsYou`'s two reasons) */
  wrote?: boolean;
  /** plan 204: its day is over and nothing was done (a dated item, or a dated promise of yours) */
  missed?: boolean;
  /** plan 204: a dated item, what the row's Done, Later and Undo act on */
  item?: { id: number; revision: number; kind: DatedKind; dueDay: string; timed: boolean; dated: boolean };
  /** plan 204 (Codex review): the promise this row shows, what D, Done and Remove act on (never the thread's most urgent) */
  promise?: { id: number; revision: number; /** it names a day (`FollowupRow.dated`): only then does its line say "Due …" */ dated?: boolean };
}

/**
 * Plan 210 (iteration 1, Codex's critique point 4): what a row is, inside a day, by what it costs to miss: a cutoff or
 * another task due (0), a promise of yours (1), a person waiting on you (2: their ask, a conversation waiting on your
 * answer), your reminder (3), then a plan or a delivery (4), which the feed draws quieter.
 */
export function dayTier(why: Pick<TodayWhy, "kind" | "item">): number {
  if (why.kind === "dated") return !why.item ? 0 : why.item.kind === "ask" ? 2 : datedGroup(why.item.kind) === "plans" ? 4 : 0;
  return why.kind === "promise" ? 1 : why.kind === "waiting" ? 2 : 3;
}

const timedWhy = (why: Pick<TodayWhy, "kind" | "item">): boolean => why.kind === "dated" && why.item?.timed === true;

/** A moment's time of day, in minutes. */
const minuteOfDay = (ms: number): number => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

type DayWhy = Pick<TodayWhy, "kind" | "item" | "dueAt">;

/** What `inDayOrder` compares of a row, read once: its tier, timed or not, its moment (or time of day), its moment. */
interface DayKey {
  tier: number;
  timed: boolean;
  at: number;
  dueAt: number;
}

function dayKey(why: DayWhy, clock: boolean): DayKey {
  const timed = timedWhy(why);
  const dueAt = why.dueAt ?? 0;
  return { tier: dayTier(why), timed, at: timed && clock ? minuteOfDay(dueAt) : dueAt, dueAt };
}

const byDayKey = (x: DayKey, y: DayKey): number => (x.tier !== y.tier || x.tier === 2 ? x.tier - y.tier : x.timed !== y.timed ? (x.timed ? -1 : 1) : x.at - y.at || x.dueAt - y.dueAt);

/**
 * Plan 210 (iteration 1): the one order inside a day, the backend's before each conversation's row is chosen and the
 * renderer's where Coming up joins a day: by `dayTier`, then the timed first, by their time, then the rest as they came
 * due. People waiting keep the order they came in (0: a stable sort keeps it). `clock`: a day ahead's timed rows go by
 * their time of day (put off, they may first have been due another day); Today's by their moment, so a Plan still on
 * from last night comes first.
 */
export const inDayOrder = (a: DayWhy, b: DayWhy, clock: boolean): number => byDayKey(dayKey(a, clock), dayKey(b, clock));

/**
 * The same order for a whole list, each row's key read once (the backend sorts up to the 1,000-item bound on every count):
 * by `day` first when given (a day ahead's and Coming up's rows, under their days), ties as they came.
 */
export function sortInDay<T>(rows: readonly T[], why: (row: T) => DayWhy, clock: boolean, day?: (row: T) => string): T[] {
  const keyed = rows.map((row, i) => ({ row, i, day: day?.(row) ?? "", key: dayKey(why(row), clock) }));
  keyed.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : byDayKey(a.key, b.key) || a.i - b.i));
  return keyed.map((k) => k.row);
}

/**
 * The fifth panel round (change 6): another open item of the row's conversation that would show in Today (not put off,
 * not over), the soonest, so a second date isn't hidden under the first: "Also Thu 9:00 AM · Board meeting".
 */
export interface TodayAlso {
  /** a dated item's kind, or a promise of yours */
  kind: DatedKind | "promise";
  text: string;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  /** false: it names no day (an ask, an alert that named none, a promise with no day): its words alone */
  dated: boolean;
}

export interface TodayItem {
  thread: ThreadSummary;
  why: TodayWhy;
  /** the stored summary's first sentence, only when it's current */
  summary?: string;
  /** a row with a task of its own: its conversation's next one (never what the row's D, Done and Later act on) */
  also?: TodayAlso;
}

/**
 * Plan 204: every row that's for today, each thread once, in `TODAY_GROUP_ORDER`; Coming up last, and never counted. Plan
 * 210 (by day): a day of its own and Coming up come as a section per day, in order, each with its `day` ("YYYY-MM-DD").
 */
export type TodaySection = { kind: TodayGroupKind; day?: string; items: TodayItem[] };

export interface DigestItem {
  threadId: number;
  messageId: number;
  /** a thread that moved since isn't what was listed */
  lastDate: number;
  messageCount: number;
  from: string;
  /** plan 166: the sender's address (what "Not a newsletter" keeps out); absent in a digest stored before it, and filled at read */
  fromEmail?: string;
  subject: string;
  /** null: no line, with the digest off */
  line: string | null;
}

/** Plan 166: a sender the user said isn't a newsletter. Kept on this machine, out of every digest and Automated mail. */
export interface NotNewsletter {
  /** this entry, never another's: what an Undo names (a time can repeat, Codex review) */
  id: string;
  email: string;
  name: string;
  /** when it was said: the list's order */
  at: number;
}

/** Plan 166: how much of a sender's name the list keeps. */
export const NOT_NEWSLETTER_NAME_MAX = 200;

/** Plan 166: the list keeps this many; past it, the oldest goes (and its Undo brings it back). */
export const NOT_NEWSLETTERS_MAX = 500;

/** Plan 166 (Codex review): how far Undos putting entries back may take the list past its cap; the next addition trims it. */
export const NOT_NEWSLETTERS_OVER = 10;

export type DigestState = "pending" | "ready" | "failed";

export interface DigestRow {
  day: string;
  state: DigestState;
  items: DigestItem[];
  /** with no digest: what's automated, unsorted: nothing here has said these are newsletters */
  automated: boolean;
  /** of `items`, those still in the Inbox and unread: the rest stay listed, muted */
  liveIds: number[];
  /** of `items`, those still in the Inbox but read (opened): plan 145 archives only unread mail, so they stay, and say so (plan 161) */
  readIds?: number[];
  /** the failure's kind, for its help line */
  errorKind?: string | null;
  model?: string | null;
  provider?: string | null;
}

export interface TodayList {
  sections: TodaySection[];
  digest: DigestRow | null;
  now: number;
  /** the open and checked rows no section holds any more: kept in place until the selection lets go (revision 9) */
  held: ThreadSummary[];
  /** plan 210: the history's first page (or down to the line asked for), when asked for (What matters drawn as the feed) */
  history?: TodayHistoryPage;
}

/**
 * Plan 210: a history line's place: when its item closed, then at the same moment a dated item (0) before a promise (1),
 * then the higher id. The history is newest first in this order; a page is taken strictly after a line's key.
 */
export interface HistoryKey {
  at: number;
  src: 0 | 1;
  id: number;
}

/** Negative: `a` comes first (newer). */
export const historyOrder = (a: HistoryKey, b: HistoryKey): number => b.at - a.at || a.src - b.src || b.id - a.id;

/**
 * A table's own key (`closed_at`, id) strictly after a history line: at the line's moment, dated items come before
 * promises, so the dated table takes none of that moment after a promise, and the promises' table all of it after a dated item.
 */
export function historyAfter(key: HistoryKey, src: 0 | 1): { at: number; id: number } {
  if (key.src === src) return { at: key.at, id: key.id };
  return { at: key.at, id: src === 0 ? 0 : Number.MAX_SAFE_INTEGER };
}

/** What happened to the item: done, removed (once "not a task"), settled by later mail, or over (retired when its time passed). */
export type HistoryOutcome = "done" | "dismissed" | "settled" | "over";

export interface TodayHistoryItem {
  thread: ThreadSummary;
  key: HistoryKey;
  outcome: HistoryOutcome;
  /** a dated item's kind, or a promise of yours */
  kind: DatedKind | "promise";
  /** its words, as the open part said them */
  text: string;
}

export interface TodayHistoryPage {
  items: TodayHistoryItem[];
  /** the last line's key, to ask for the page after it; null: nothing older */
  next: HistoryKey | null;
}

/** Plan 210: the history's lines a page. */
export const HISTORY_PAGE = 40;

/** A day's key, in the machine's own time. */
export function todayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** When "HH:MM" next comes round after `now`, local, through a DST change as a clock on the wall would. */
export function nextPrepareAt(prepareAt: string, now: number): number {
  const [h, m] = prepareAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  return at.getTime();
}

/** Today's "HH:MM", local. */
export function prepareTimeToday(prepareAt: string, now: number): number {
  const [h, m] = prepareAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  return at.getTime();
}

/**
 * Plan 204, the second panel round (plan 145's rule, tighter): a message that only acknowledges ("Thanks.", "Got it,
 * thanks!", "Gracias", "Perfecto 👍") isn't waiting on the reader. Conservative, by what it allows rather than what it
 * catches (Codex code reviews): the visible message (quotes off, inline answers kept, nothing after a sign-off), no
 * question and no request word, acknowledgments, whole phrases that add nothing ("for the update", "talk soon") and at
 * most a name signing it, at its end. "Thanks, review the contract today", "Thanks. Please reply." and "Perfecto.
 * Avísame." are kept. A body too long to read cheaply is kept too: the rule only ever takes conversations out.
 */
const ACK = /\b(thanks|thank you|thx|ty|got it|sounds good|great|perfect|ok|okay|noted|will do|cheers|appreciate it|gracias|muchas gracias|perfecto|listo|de acuerdo|vale|entendido|recibido|genial|excelente)\b|👍|🙏/iu;
const ACK_ONLY =
  /\b(thank you|thanks|thx|ty|many thanks|much appreciated|appreciate it|got it|sounds good|sounds great|great|perfect|ok|okay|noted|will do|cheers|awesome|all good|muchas gracias|mil gracias|gracias|perfecto|perfecta|listo|de acuerdo|vale|entendido|recibido|genial|excelente)\b|[👍🙏🙌😊🙂]/giu;
/** whole phrases that add nothing to a thanks: no task, no date, no thing */
const FILLER =
  /\b(for (the|your) (update|info|information|help|quick reply|reply|response|heads up|note)|so much|a lot|again|as always|talk soon|have a (great|good|nice) (day|weekend|one)|you too|hi|hello|hey|dear|por (la|tu|su) (información|info|ayuda|respuesta)|por el aviso|de nuevo|que tengas (un )?buen (día|fin de semana)|buen (día|fin de semana)|igualmente|nos vemos( pronto)?|un abrazo|saludos|hola)\b/giu;
/** a request, however it's dressed: never an acknowledgment */
const REQUEST = /\b(please|pls|let me know|can you|could you|would you|send|reply|update|review|sign|call|confirm|check|need|por favor|avísame|avisame|me avisas|mándame|mandame|envíame|enviame|revisa|firma|llama|confirma|necesito)\b/iu;
const SIGN_OFF = /^(--\s*$|sent from my|enviado desde|get outlook|best,?$|regards,?$|saludos,?$|un abrazo,?$|abrazo,?$|cheers,?$)/i;
/** past this, a body isn't read for it (the sidebar's count reads it): kept, as anything unsure is */
const ACK_MAX_CHARS = 20_000;

/** A message's own words: quotes off (an answer between them kept), nothing after a sign-off. */
function ownWords(text: string): string {
  const lines: string[] = [];
  for (const raw of withoutQuotes(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (SIGN_OFF.test(line)) break;
    lines.push(line);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export function isAcknowledgment(text: string | null | undefined): boolean {
  if (!text || text.length > ACK_MAX_CHARS) return false;
  const words = ownWords(text);
  // a few words (the cheap test first), no question, an acknowledgment
  if (!words || words.split(" ").length > 14 || /[?¿]/.test(words) || !ACK.test(words)) return false;
  // the phrases that add nothing off ("for the update"), then no request in what's left
  const plain = words.replace(FILLER, " ");
  if (REQUEST.test(plain)) return false;
  const rest = plain.replace(ACK_ONLY, " ").match(/[\p{L}\p{N}'’]+/gu) ?? [];
  // what's left is at most a name signing it: one or two capitalized words, the message's last
  if (rest.length > 2 || !rest.every((w) => /^\p{Lu}\p{Ll}+$/u.test(w))) return false;
  return !rest.length || words.replace(/[^\p{L}\p{N}'’]+$/u, "").endsWith(rest.at(-1)!);
}

/** The cheap screen first: a snippet that starts like an acknowledgment is worth reading the message for. */
export const looksLikeAcknowledgment = (snippet: string | null | undefined): boolean => !!snippet && snippet.length <= 200 && ACK.test(snippet.slice(0, 40));

/** Plan 202: summaries say who has to act from this prompt version on; an older one can't say the reader has nothing to do. */
/**
 * Plan 204, the fourth panel read: a message that says the reader needn't answer or act ("No action needed!", "No need to
 * reply now", "No hace falta que contestes") asks nothing of them: not an ask, and not Needs you's. Whole phrases only.
 */
const NO_REPLY = /\b(no (action|reply|response|answer) (is )?(needed|required|necessary)|no need to (reply|respond|answer|write back|get back to me|do anything)|nothing (is )?(needed|required) from you|you don'?t (need|have) to (reply|respond|answer|do anything)|no hace falta (que )?(respondas|contestes|responder|contestar|hacer nada)|no es necesario (que )?(respondas|contestes|responder|contestar)|no tienes que (responder|contestar|hacer nada)|sin necesidad de (responder|contestar)|no requiere (respuesta|acción))\b/iu;
export const saysNoReplyNeeded = (text: string | null | undefined): boolean => !!text && NO_REPLY.test(text.slice(0, ACK_MAX_CHARS));

export const SUMMARY_WHO_ACTS_SINCE = 7;

/** An acceptance answers an invitation: there's nothing to answer back. Lowercase, as the stores compare them. */
export const CALENDAR_ANSWER_PREFIXES = ["accepted:", "declined:", "tentative:", "aceptado:", "aceptada:", "rechazado:", "rechazada:", "provisional:", "nueva hora propuesta:", "new time proposed:"] as const;

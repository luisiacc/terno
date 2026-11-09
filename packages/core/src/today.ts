import type { AppSettings } from "./rpc/contract";
import type { ThreadSummary } from "./types";

/** Plan 145: what needs you today, and newsletters folded into one digest. Local but for the digest, which is its own opt-in. */

export const TODAY_NEEDS_MAX = 12;
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
}

export const DEFAULT_TODAY: TodaySetting = { show: true, prepareAt: "08:00", notify: false, digest: false };

/**
 * Who sees Today: a provider set up, or (once plan 85's Pro exists) an active entitlement. One helper, so Pro joins in one
 * line. It reads no provider's id but "none".
 */
export function aiFeaturesAvailable(settings: Pick<AppSettings, "ai"> | null | undefined, entitlement?: { active: boolean } | null): boolean {
  if (entitlement?.active === true) return true;
  const ai = settings?.ai;
  if (!ai || ai.provider === "none" || ai.keyUnreadable) return false;
  // a key removed leaves the provider chosen: without one, it can't run. A model here needs none.
  return !ai.needsKey || (ai.hasKey && ai.keyConfirmed);
}

type AiFields = AppSettings["ai"];

const LOCAL_PROVIDERS: readonly AppSettings["ai"]["provider"][] = ["ollama", "lmstudio", "fake"];

/**
 * The AI can really run: a provider and a model chosen, and its key saved (readable, for this endpoint) when it needs
 * one. AI features are offered only then; otherwise they could only fail.
 */
export function aiReady(ai: AiFields | null | undefined): ai is AiFields {
  if (!ai || ai.provider === "none" || !ai.model.trim() || ai.keyUnreadable) return false;
  const preset = ai.preset ?? "custom";
  // custom and Azure have no endpoint of their own: they need the one saved
  if (ai.provider === "compatible" && !ai.baseURL && (!ai.preset || preset === "custom" || preset === "azure")) return false;
  const keyed = ai.provider === "anthropic" || ai.provider === "openai" || (ai.provider === "compatible" && preset !== "custom");
  return !keyed || (ai.hasKey && ai.keyConfirmed);
}

/** A task's own choice can go: the backend never falls back from one to anything else. */
export const chosenTargetReady = (ai: AiFields, chosen: { provider: AiFields["provider"] }): boolean => chosen.provider !== "none" && (LOCAL_PROVIDERS.includes(chosen.provider) || chosen.provider === "compatible" || ai.keys[chosen.provider]?.hasKey === true);

/** Plan 157: where drafting can go, by `AiService.targetFor`'s rule. */
export function writingCanRun(ai: AiFields): boolean {
  const chosen = ai.tasks.writing;
  return chosen ? chosenTargetReady(ai, chosen) : aiReady(ai);
}

/**
 * Plan 157: whether summaries can run with no one asking, by `AiService.targetFor`'s rule. A paid provider nobody picked
 * for them isn't one (plan 132 §2): that's the question Settings asks.
 */
export function summaryCanRun(ai: AiFields): boolean {
  const chosen = ai.tasks.summary;
  if (chosen) return chosenTargetReady(ai, chosen);
  return ai.keys.openai?.hasKey === true || (ai.local && aiReady(ai));
}

export interface TodayWhy {
  kind: "promise" | "nudge" | "waiting" | "reminder";
  text?: string;
  dueAt?: number;
  personName?: string | null;
  sentAt?: number;
  /** a waiting row: you've written in this conversation (else it's new, from someone you write to: `needsYou`'s two reasons) */
  wrote?: boolean;
}

export interface TodayItem {
  thread: ThreadSummary;
  why: TodayWhy;
  /** the stored summary's first sentence, only when it's current */
  summary?: string;
}

export type TodaySection = { kind: "needsYou"; items: TodayItem[]; more: number } | { kind: "reminders"; items: TodayItem[] };

/**
 * Plan 166: Needs you's two groups. "Your turn": the conversation is yours to move (a promise or nudge due, or they
 * replied in one you've written in). "Waiting for your reply": a new one from someone you write to, not answered yet.
 */
export type NeedsGroup = "yourTurn" | "waitingForYou";

export const needsGroup = (why: TodayWhy): NeedsGroup => (why.kind === "waiting" && why.wrote === false ? "waitingForYou" : "yourTurn");

/** Plan 166: Your turn first: a conversation you're already in, or a promise you made, is the stronger call on you. */
export const NEEDS_GROUPS: readonly NeedsGroup[] = ["yourTurn", "waitingForYou"];

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
}

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

/** An acceptance answers an invitation: there's nothing to answer back. Lowercase, as the stores compare them. */
export const CALENDAR_ANSWER_PREFIXES = ["accepted:", "declined:", "tentative:", "aceptado:", "aceptada:", "rechazado:", "rechazada:", "provisional:", "nueva hora propuesta:", "new time proposed:"] as const;

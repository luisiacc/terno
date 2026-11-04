/**
 * Plan 131 revision 5 and plan 132: what AI work new mail asks for, and the summaries.
 *
 * - `ai_new_mail`: "this arrived as new mail", written in the ingest commit like `forward_eligible` (never later: a
 *   late body isn't news), whether or not its text is here or a classifier is ready. Each feature that wants the
 *   message holds a flag; a row goes when no feature wants it any more, and at 3 days.
 * - `ai_summaries`: one row a thread. `pending` is the queue; `ready` holds a result and the `source_stamp` of what it
 *   read, which the reader compares with the thread now, so any change of its sources hides it.
 */

/** Mail older than this at ingest isn't new, a marker older than this has lost its moment. */
export const NEW_MAIL_MS = 3 * 86_400_000;
/** The summaries kept; the oldest results go first. */
export const SUMMARY_MAX_ROWS = 5000;

export type NewMailWant = "summary" | "category";
/** What the features that care want of the mail an ingest inserts. */
export interface NewMailWants {
  summary?: boolean;
  category?: boolean;
}

export interface NewMailMark {
  messageId: number;
  threadId: number;
  arrivedAt: number;
  wantsSummary: boolean;
  wantsCategory: boolean;
}

export type AiSummaryState = "pending" | "ready" | "failed";

export interface AiSummaryRow {
  threadId: number;
  state: AiSummaryState;
  /** the newest message it should cover */
  throughMessageId: number;
  /** of the sources it read: compared with the thread before writing and before showing */
  sourceStamp: string | null;
  /** of the text actually sent, with the target it went to: the same again needs no request */
  contentHash: string | null;
  promptVersion: number | null;
  language: string | null;
  model: string | null;
  provider: string | null;
  endpoint: string | null;
  bodyJson: string | null;
  attempts: number;
  /** why the last attempt failed (an AiErrorKind) */
  errorKind: string | null;
  createdAt: number;
  generatedAt: number | null;
  failedAt: number | null;
}

/** One message of a thread as summaries see it: no body, only whether it's here. */
export interface SummarySourceMessage {
  id: number;
  fromName: string;
  fromEmail: string;
  date: number;
  snippet: string;
  subject: string;
  /** the user sent it, or it's from one of their addresses */
  own: boolean;
  trash: boolean;
  spam: boolean;
  bodyState: "none" | "partial" | "full";
  /** too big to keep: its text will never come (plan 106's size limit) */
  bodyUnavailable: boolean;
  /** when it arrived as new mail, while a marker says summaries want it */
  markedAt: number | null;
}

export interface SummarySources {
  threadId: number;
  accountId: number;
  subject: string;
  inInbox: boolean;
  inSpam: boolean;
  inTrash: boolean;
  /** any message is spam, wherever it is now: `rootRefs` only reports the earliest inbound message */
  hasSpam: boolean;
  /** threads.tab: 0 the Inbox (Primary), else Promotions or Social */
  tab: number;
  stamp: string;
  /** oldest first, without drafts */
  messages: SummarySourceMessage[];
}

export type SummaryWrite = {
  threadId: number;
  /** the stamp of the sources it read */
  stamp: string;
  /** the row's through_message_id when it read them (null: no row then) */
  expectThrough: number | null;
  now: number;
  /** `clearGeneration()` before it read anything: a clear since then means this write brings back what was cleared */
  clearGeneration: number;
} & (
  | {
      /** a stored result for the same text: it keeps its original provenance */
      reuse: true;
    }
  | {
      reuse?: false;
      contentHash: string;
      promptVersion: number;
      language: string;
      model: string;
      provider: string;
      endpoint: string | null;
      bodyJson: string;
    }
);

/** `moved`: the sources or the queue changed meanwhile, go again; `blocked`: spam or trash, nothing written; `gone`: no such thread, or everything was cleared since. */
export type SummaryWriteOutcome = "written" | "moved" | "blocked" | "gone";

/** The threads summaries never touch, by hand or not: Spam and Trash (revision 1: any spam message in the thread counts). */
export const summaryBlocked = (s: Pick<SummarySources, "hasSpam" | "inSpam" | "inTrash">): boolean => s.hasSpam || s.inSpam || s.inTrash;

/**
 * What a result depends on: each source's id and body version (`body_tail_norm` and the capture change with the body,
 * in both stores, without reading it), in id order. Drafts and trashed messages aren't sources; a spam one stops the
 * whole thread before this matters.
 */
export function sourceStamp(rows: Iterable<{ id: number; bodyState: string; capture: string | null | undefined; tail: string | null | undefined }>): string {
  let count = 0;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
    }
  };
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    count++;
    feed(`${r.id}|${r.bodyState}|${r.capture ?? ""}|${r.tail ?? ""}\n`);
  }
  return `${count}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

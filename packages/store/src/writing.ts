import type { Address, VoiceScope } from "@terno/core";
import type { SummarySourceMessage, SummarySources } from "./ai-summaries";
import { addressesOf } from "./autocomplete-source";

/**
 * Plan 133: what drafting reads and keeps. Reads of sent mail by date and by exact recipient, a bounded read of one
 * thread, the profiles and the provenance of what the model wrote. Not exported, not synced, not searched.
 *
 * - `writing_profiles`: one row a scope and language; `scope_key` is its identity in both stores.
 * - `writing_generations`: one row a draft until it's sent, then the message's. An unchanged send (`final` null) keeps
 *   that message out of the corpus, so past its text's bound it stays as a marker with no text.
 */

/** Newest sent mail read per account (§2). */
export const CORPUS_WINDOW = 3000;
export const CORPUS_PAGE_MAX = 500;
/** Bodies per `corpus.texts`. */
export const CORPUS_TEXTS_MAX = 64;
/** A recipient list longer than this is mass mail: not read, and no evidence of how someone writes to one person. */
export const RECIPIENTS_JSON_MAX = 16 * 1024;
/** More people than this on a message makes it bulk. */
export const BULK_RECIPIENTS = 20;
/** `sentTo`'s candidates looked at: the phrase also matches `x.tom@acme.com`, and a look-alike may hold thousands. */
export const SENT_TO_CANDIDATES = 5000;
export const SENT_TO_PAGE = 500;

export const PROFILES_MAX_ROWS = 2000;
export const PROFILES_MAX_BYTES = 4 * 1024 * 1024;
/** One row: what can't fit isn't a profile. */
export const PROFILE_MAX_BYTES = 16 * 1024;
export const GENERATIONS_MAX_ROWS = 200;
export const GENERATIONS_MAX_BYTES = 1024 * 1024;
/** The markers kept once a message's text is gone: more than a window's worth across accounts. */
export const GENERATION_MARKERS_MAX = 20_000;
/** One side of a generation: past what the model can write (`MAX_STREAM_CHARS` is a stream's own bound). */
export const GENERATION_TEXT_MAX_STORE = 64 * 1024;

export interface CorpusCursor {
  date: number;
  id: number;
}

/** A sent message, no body: enough to choose what to read. */
export interface CorpusHeader {
  id: number;
  threadId: number;
  accountId: number;
  date: number;
  subject: string;
  /** lowercased */
  to: string[];
  cc: string[];
  /** by address, lowercased, for greetings */
  names: Record<string, string>;
  isReply: boolean;
  bulk: boolean;
}

export interface CorpusText {
  id: number;
  text: string;
}

export interface SentRef {
  id: number;
  threadId: number;
  accountId: number;
  date: number;
  subject: string;
  to: string[];
  cc: string[];
  isReply: boolean;
}

export type SentToState = "none" | "found" | "unavailable";
export interface SentToResult {
  refs: SentRef[];
  state: SentToState;
}

export interface ThreadContextMessage extends SummarySourceMessage {
  to: Address[];
  cc: Address[];
  /** the start of its text, when the budget chose it; null otherwise */
  text: string | null;
}

export interface ThreadContext {
  threadId: number;
  accountId: number;
  subject: string;
  /** changes with any source: compared before re-using what was assembled */
  stamp: string;
  /** oldest first, without drafts; trashed and spam ones only when the thread itself is there */
  messages: ThreadContextMessage[];
  /** the newest message not from the user, if any */
  newestInbound: number | null;
}

export interface ThreadBudget {
  maxBodies: number;
  maxChars: number;
}

export interface WritingProfileRow {
  id: number;
  scope: VoiceScope;
  scopeKey: string;
  language: string;
  accountId: number | null;
  habitsJson: string;
  phrasesJson: string;
  judgmentJson: string | null;
  samples: number;
  newSince: number;
  sampleHash: string | null;
  edited: boolean;
  model: string | null;
  provider: string | null;
  promptVersion: number | null;
  updatedAt: number;
}

/** What a pass of counting knows: a judgment and an edit are never its to overwrite. */
export interface ProfileUpsert {
  scope: VoiceScope;
  scopeKey: string;
  language: string;
  accountId: number | null;
  habitsJson: string;
  phrasesJson: string;
  samples: number;
}

export interface ProfilesCommit {
  upserts: readonly ProfileUpsert[];
  /** the account's rows these upserts don't name went below their minimum: they go, unless edited */
  replaceAccount?: number;
  /** "you" is rebuilt from the accounts: its languages that no longer exist go */
  replaceYou?: boolean;
  /** settings written in the same commit: the learner's checkpoint */
  state: Readonly<Record<string, unknown>>;
  now: number;
}

export interface ProfileJudgmentWrite {
  scopeKey: string;
  language: string;
  judgmentJson: string;
  sampleHash: string;
  model: string;
  provider: string;
  promptVersion: number;
  now: number;
}

export interface ProfileEdit {
  scopeKey: string;
  language: string;
  habitsJson?: string;
  phrasesJson?: string;
  judgmentJson?: string | null;
  now: number;
}

export interface GenerationRow {
  id: number;
  accountId: number;
  draftId: number | null;
  draftGeneration: string | null;
  messageId: number | null;
  opId: string | null;
  address: string;
  generated: string;
  final: string | null;
  at: number;
}

export interface GenerationCommit {
  accountId: number;
  draftId: number;
  draftGeneration: string;
  address: string;
  /** canonical authored form (`canonicalAuthored`) */
  generated: string;
  now: number;
}

/** The send's side of provenance, in `compose.queueSend`'s transaction. */
export interface GenerationTransfer {
  /** canonical authored text of what's going, before signature and quotes; null when nobody said (an agent's send) */
  authored: string | null;
}

/** Lowercased addresses in a stored list, without parsing one too long to be about one person. */
export function recipientList(json: string | null | undefined): { addresses: string[]; names: Record<string, string>; tooLong: boolean } {
  if (json && json.length > RECIPIENTS_JSON_MAX) return { addresses: [], names: {}, tooLong: true };
  const addresses: string[] = [];
  const names: Record<string, string> = {};
  for (const a of addressesOf(json)) {
    const address = a.email.toLowerCase();
    addresses.push(address);
    if (a.name) names[address] = a.name;
  }
  return { addresses, names, tooLong: false };
}

export function rankSentRefs(refs: SentRef[], limit: number): SentRef[] {
  return refs.sort((a, b) => b.date - a.date || b.id - a.id).slice(0, limit);
}

/** The FTS phrase for any of these addresses in the recipients column. */
export const recipientsMatch = (addresses: readonly string[]): string => addresses.map((a) => `recipients : "${a.replace(/"/g, '""')}"`).join(" OR ");

/**
 * Plan 133 §6.2: a thread's headers first, then the start of the bodies the budget chooses, never every body. The
 * message being answered comes first and takes up to half, the rest newest first, sharing what's left.
 */
export async function readThreadContext(sources: SummarySources, recipients: ReadonlyMap<number, { to: Address[]; cc: Address[] }>, budget: ThreadBudget, text: (requests: readonly { messageId: number; limit: number }[]) => Promise<Map<number, string | null>>): Promise<ThreadContext> {
  const hidden = (m: SummarySourceMessage) => (m.trash && !sources.inTrash) || (m.spam && !sources.inSpam);
  const messages = sources.messages.filter((m) => !hidden(m));
  const inbound = [...messages].reverse().find((m) => !m.own) ?? null;
  const others = [...messages].reverse().filter((m) => m !== inbound).slice(0, Math.max(0, budget.maxBodies - (inbound ? 1 : 0)));
  const inboundShare = others.length ? Math.floor(budget.maxChars / 2) : budget.maxChars;
  const share = others.length ? Math.floor((budget.maxChars - (inbound ? inboundShare : 0)) / others.length) : 0;
  const requests = [...(inbound && budget.maxBodies > 0 ? [{ messageId: inbound.id, limit: inboundShare }] : []), ...others.map((m) => ({ messageId: m.id, limit: share }))];
  const bodies = requests.length ? await text(requests) : new Map<number, string | null>();
  return {
    threadId: sources.threadId,
    accountId: sources.accountId,
    subject: sources.subject,
    stamp: sources.stamp,
    newestInbound: inbound?.id ?? null,
    messages: messages.map((m) => ({ ...m, to: recipients.get(m.id)?.to ?? [], cc: recipients.get(m.id)?.cc ?? [], text: bodies.get(m.id) ?? null })),
  };
}

/** Whether a row with the given sizes stays within a profile's bound. */
export const profileFits = (u: { habitsJson: string; phrasesJson: string; judgmentJson?: string | null }): boolean => u.habitsJson.length + u.phrasesJson.length + (u.judgmentJson?.length ?? 0) <= PROFILE_MAX_BYTES;

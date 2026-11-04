import { estimateTokens } from "./types";

/**
 * Plan 133 §6.3. Budgets come from capacity, not from "cloud": reserve output and framing, keep a margin on the
 * estimate, then fill in priority order. The first group is never cut: if it doesn't fit, the request is impossible.
 */

export interface ThreadEntry {
  from: string;
  date: string;
  own: boolean;
  text: string;
  /** what's left of it with no room for the text */
  snippet: string;
}

export interface DraftParts {
  /** priority 1: never cut. Rules, instructions, sender, recipients, one-off instruction, the draft's words. */
  fixedTokens: number;
  /** priority 2 */
  inbound: string | null;
  /** priority 3 */
  voiceGeneral: readonly string[];
  /** priority 4 */
  voiceSpecific: readonly string[];
  /** priority 5, oldest first, without the newest inbound */
  thread: readonly ThreadEntry[];
  /** priority 6, best first */
  messagesToPerson: readonly string[];
  /** priority 7, best first */
  pastConversations: readonly string[];
}

export interface BudgetLimits {
  /** the effective context window */
  capacityTokens: number;
  /** output and thinking */
  outputTokens: number;
  framingTokens?: number;
}

export interface FittedDraft {
  inbound: string | null;
  voiceGeneral: string[];
  voiceSpecific: string[];
  thread: { from: string; date: string; own: boolean; text: string }[];
  messagesToPerson: string[];
  pastConversations: string[];
  /** room counted against, and what was spent */
  budget: number;
  used: number;
}

/** Thinks with the estimate 20% wrong. */
const ESTIMATE_MARGIN = 0.8;
const FRAMING_TOKENS = 200;
export const OUTPUT_TOKENS_LARGE = 8000;
export const UNKNOWN_LOCAL_CAPACITY = 4096;
const THREAD_OWN_TOKENS = 400;
const THREAD_OTHER_TOKENS = 300;
const THREAD_MAX_ENTRIES = 20;
const PERSON_MESSAGES = 4;
const PERSON_MESSAGES_MIN = 2;

export class DraftTooLargeError extends Error {
  constructor(readonly needed: number, readonly available: number) {
    super(`this draft needs about ${needed} tokens and the model has room for ${available}`);
    this.name = "DraftTooLargeError";
  }
}

const clip = (text: string, tokens: number) => {
  const chars = tokens * 4;
  return text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1)).trimEnd()}…`;
};

/** The start says what it's about, the end says what's being asked: a huge message keeps both. */
export function headAndTail(text: string, tokens: number): string {
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  const head = Math.floor(chars * 0.7);
  const tail = Math.max(0, chars - head - 3);
  return `${text.slice(0, head).trimEnd()}\n…\n${tail ? text.slice(-tail).trimStart() : ""}`.trimEnd();
}

export function fitDraftBudget(parts: DraftParts, limits: BudgetLimits): FittedDraft {
  const framing = limits.framingTokens ?? FRAMING_TOKENS;
  const budget = Math.floor((limits.capacityTokens - limits.outputTokens - framing) * ESTIMATE_MARGIN);
  if (parts.fixedTokens > budget) throw new DraftTooLargeError(parts.fixedTokens, Math.max(0, budget));
  let left = budget - parts.fixedTokens;
  const spend = (tokens: number) => {
    left -= tokens;
  };

  let inbound: string | null = null;
  if (parts.inbound !== null) {
    inbound = headAndTail(parts.inbound, Math.max(0, left));
    spend(estimateTokens(inbound));
  }

  /** whole items while they fit: half a profile, or half an old message, isn't what it was */
  const whole = (items: readonly string[]) => {
    const kept: string[] = [];
    for (const item of items) {
      const cost = estimateTokens(item);
      if (cost > left) break;
      kept.push(item);
      spend(cost);
    }
    return kept;
  };
  const voiceGeneral = whole(parts.voiceGeneral);
  const voiceSpecific = whole(parts.voiceSpecific);

  // newest first for the room, oldest first in the prompt; past the limit only who and when remain
  const thread: FittedDraft["thread"] = [];
  const entries = [...parts.thread].reverse();
  entries.forEach((m, i) => {
    const cap = m.own ? THREAD_OWN_TOKENS : THREAD_OTHER_TOKENS;
    const full = i < THREAD_MAX_ENTRIES ? clip(m.text, cap) : m.snippet;
    const text = estimateTokens(full) <= left ? full : estimateTokens(m.snippet) <= left ? m.snippet : "";
    spend(estimateTokens(text));
    thread.unshift({ from: m.from, date: m.date, own: m.own, text });
  });

  const person = parts.messagesToPerson.slice(0, PERSON_MESSAGES);
  const messagesToPerson: string[] = [];
  const costs = person.map(estimateTokens);
  let count = person.length;
  // all of them, or fewer, down to the two that still show a pattern; one alone would teach its own quirks
  while (count > 0 && costs.slice(0, count).reduce((a, b) => a + b, 0) > left) count = count > PERSON_MESSAGES_MIN ? count - 1 : 0;
  for (let i = 0; i < count; i++) {
    messagesToPerson.push(person[i]!);
    spend(costs[i]!);
  }

  const pastConversations = whole(parts.pastConversations);
  return { inbound, voiceGeneral, voiceSpecific, thread, messagesToPerson, pastConversations, budget, used: budget - left };
}

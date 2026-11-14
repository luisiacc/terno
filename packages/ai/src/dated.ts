import type { DatedKind } from "@terno/core";

/**
 * Plan 204 §3: what one message the user got says has a date that matters to them, and which of their open items it
 * settles. The prompt is frozen and versioned. Everything in the mail is material: an item must quote its words, and a
 * settlement must too, so an instruction in the mail can at worst add a row the user marks done.
 */
export const DATED_PROMPT_VERSION = 1;

export interface DatedInput {
  /** the message's visible text (plan 36), quotes stripped */
  text: string;
  subject: string;
  /** a name, never an address; `automated`: a list, bulk or no-reply sender */
  from: { name: string; automated: boolean };
  /** weekday, date and time, in the user's zone */
  receivedAt: string;
  /** this thread's and this sender's open items, labelled o1, o2…: what it could settle */
  open: readonly { label: string; kind: DatedKind; text: string }[];
  /** the app's: `text` in each item is for the reader */
  language: string;
  outputTokens?: number;
}

export interface DatedResult {
  items: { kind: DatedKind; text: string; quote: string; due: string | null; time: string | null }[];
  settled: { label: string; evidence: string }[];
}

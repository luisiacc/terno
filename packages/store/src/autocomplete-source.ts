import type { Address } from "@terno/core";
import type { Revision } from "./search";

/**
 * What autocomplete (plan 18) reads from a store: message headers and the
 * user's own sent text, from the same revisioned change log search follows,
 * so its models are rebuilt rarely and caught up cheaply. Never per keystroke.
 */

/** A message's headers. */
export interface ContactMessage {
  id: number;
  accountId: number;
  date: number;
  /** written by the user (Sent) */
  sent: boolean;
  spam: boolean;
  draft: boolean;
  from: Address;
  to: readonly Address[];
  cc: readonly Address[];
  bcc: readonly Address[];
  /** the body is stored (the phrase model learns from sent mail that has one) */
  hasBody: boolean;
}

/** Sent mail with its stored body (at most the first 64 KB). */
export interface SentText {
  id: number;
  accountId: number;
  date: number;
  fromName: string;
  to: readonly Address[];
  text: string;
}

export interface ContactBatch {
  from: Revision;
  to: Revision;
  /** the newest committed state of every message the batch touched */
  messages: ContactMessage[];
  /** messages the batch touched that are gone */
  removed: number[];
  /** senders of received mail in the touched conversations that are now in spam */
  spamSenders: string[];
}

export interface ContactBuild {
  /** the log is retained from here until release() */
  from: Revision;
  messages(): AsyncIterable<readonly ContactMessage[]>;
  release(): Promise<void>;
}

export interface AutocompleteSource {
  /** where the models' snapshots live (`<base>.contacts`, `<base>.phrases`); null: an in-memory database */
  readonly snapshotBase: string | null;
  /** the store kind and schema a snapshot must have been written for */
  readonly identity: string;
  head(): Promise<Revision>;
  /** batches in (after, through], oldest first; a gap or another epoch throws RevisionError (rebuild) */
  changes(after: Revision, through: Revision, maxCommits: number): Promise<ContactBatch[]>;
  beginBuild(): Promise<ContactBuild>;
  /** sent mail with a body after a message id, in id order (the phrase model's build); `next`: where the next page starts, null at the end */
  sentAfter(afterId: number, limit: number): Promise<{ texts: SentText[]; next: number | null }>;
  /** sent mail with a body among these ids */
  sentTexts(ids: readonly number[]): Promise<SentText[]>;
}

/** Address lists as stored (JSON), tolerant of anything malformed. */
export function addressesOf(json: string | null | undefined): Address[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    const out: Address[] = [];
    for (const a of v) if (a && typeof a === "object" && typeof (a as Address).email === "string") out.push({ name: typeof (a as Address).name === "string" ? (a as Address).name : "", email: (a as Address).email });
    return out;
  } catch {
    return [];
  }
}

/** Characters of sent text served per message: the phrase model keeps the first 4 KB of what the user wrote. */
export const SENT_TEXT_MAX = 65_536;
/** Sent messages larger than this (raw size, attachments included) aren't learned from: a forward or a file, and a body never read whole. */
export const SENT_SIZE_MAX = 512 * 1024;

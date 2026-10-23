import type { Address, FeatureSource, OpState, ThreadFeatures, ThreadSummary, TrainExample, View } from "@unica/core";

// ───────────────────────────── ingestion ─────────────────────────────

export interface IncomingAttachment {
  filename: string;
  mime: string;
  size: number;
  contentId?: string | null;
  providerRef?: string | null;
}

export interface IncomingLocation {
  mailbox: string;
  uidvalidity: number;
  uid: number;
  flags: string[];
}

export interface IncomingMessage {
  accountId: number;
  providerMsgId: string | null;
  /** Gmail threadId; when null, threading uses RFC headers */
  providerThreadId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  date: number;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyState: "none" | "partial" | "full";
  listId: string | null;
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  isSent: boolean;
  isDraft: boolean;
  isTrash: boolean;
  isSpam: boolean;
  hasAttachments: boolean;
  gmailLabels?: string[] | null;
  size: number;
  attachments?: IncomingAttachment[];
  locations?: IncomingLocation[];
}

export interface FlagUpdate {
  messageId: number;
  flags: Partial<{ isRead: boolean; isStarred: boolean; inInbox: boolean; isTrash: boolean; isSpam: boolean; isSent: boolean; isDraft: boolean }>;
}

// ───────────────────────────── lists ─────────────────────────────

export interface Cursor {
  lastDate: number;
  id: number;
}

export interface ListParams {
  view: View;
  accountId?: number;
  categoryId?: number;
  cursor?: Cursor;
  limit: number;
}

export interface Page {
  items: ThreadSummary[];
  nextCursor: Cursor | null;
}

// ───────────────────────────── categorization ─────────────────────────────

export type AddedBy = "user" | "filter" | "agent" | "suggestion" | "auto" | "bulk";

export type ExampleKey = readonly [threadId: number, categoryId: number];

/**
 * In-memory model changes a store command produced. The caller applies them
 * only after the command committed, so a rollback never leaves RAM ahead of
 * the database.
 */
export type ModelDelta =
  /** key: the example's (thread, category) row, so a paged rebuild knows whether it already read it */
  | { op: "train" | "untrain"; example: TrainExample; key: ExampleKey }
  /** the thread is categorized now: it stops being a background (weak negative) thread */
  | { op: "unbackground"; threadId: number }
  /** the thread is uncategorized again (removal, undo) and old enough: back to the background */
  | { op: "background"; threadId: number; features: Uint32Array };

export interface RootMessage {
  threadId: number;
  messageId: number;
  date: number;
  inInbox: boolean;
  spam: boolean;
  trash: boolean;
  draft: boolean;
  bodyComplete: boolean;
  source: FeatureSource;
}

export interface ThreadFeatureSet {
  root: RootMessage;
  features: ThreadFeatures;
  encoded: Uint32Array;
}

export interface ClassifyResult {
  deltas: ModelDelta[];
  /** threads auto-added, per category */
  auto: Map<number, number[]>;
  suggested: number;
  /** threads with a decision (for change notifications) */
  touched: Set<number>;
  /** uncertain band threads (0.5 ≤ p < auto threshold, no decision): candidates for the optional AI assist */
  uncertain: number[];
  /** old threads that arrived (backfill): background and suggestions are stale by this many */
  backfill: number;
}

export interface PendingSuggestion {
  threadId: number;
  categoryId: number;
  p: number;
  reasons: string[];
  at: number;
}

export type MovePhase = "training" | "done" | "restoring" | "undone" | "expired";

// ───────────────────────────── ops, owner, drafts ─────────────────────────────

export interface OpRow {
  id: string;
  seq: number;
  account_id: number;
  kind: string;
  target_json: string;
  payload_json: string;
  state: OpState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}

/**
 * The owner is the person this install belongs to (the future "Única account"),
 * separate from mailboxes: removing its mailbox only clears account_id.
 */
export interface OwnerClaim {
  email: string;
  displayName: string;
  provider: "gmail" | "imap";
  verifiedBy: "google_oauth" | "imap_login";
  /** {googleSub, emailVerified} | {imapHost, loginUser, emailMatchesLogin}; never leaves the backend */
  evidence: Record<string, unknown>;
  accountId: number;
}

export interface DraftRow {
  id: number;
  account_id: number;
  to_json: string;
  cc_json: string;
  subject: string;
  body_text: string;
  in_reply_to_message_id: number | null;
  updated_at: number;
}

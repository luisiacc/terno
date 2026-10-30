import type { Address, FeatureSource, ListFilter, OpState, Reason, ThreadFeatures, ThreadSummary, TrainExample, View } from "@terno/core";

// ───────────────────────────── ingestion ─────────────────────────────

export interface IncomingAttachment {
  filename: string;
  mime: string;
  size: number;
  contentId?: string | null;
  providerRef?: string | null;
  assetId?: string;
  /** Decoded MIME bytes, staged before the message transaction. */
  bytes?: Uint8Array;
}

/** plan 68: a folder as its provider lists it (its account is the sync's) */
export type ProviderFolder = Omit<import("@terno/core").Folder, "accountId">;

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
  /** Absent on partial/legacy ingestion; an empty list explicitly clears Reply-To. */
  replyTo?: Address[];
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
  /** plan 17: bulk headers (List-Unsubscribe, Precedence bulk/list/junk, Auto-Submitted); absent: none seen */
  bulk?: boolean;
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
  captureUnavailable?: "size";
  locations?: IncomingLocation[];
}

/** A message's state an action may change: what an undo puts back, exactly. */
export interface MessageState {
  id: number;
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  isTrash: boolean;
  isSpam: boolean;
}

export interface FlagUpdate {
  messageId: number;
  expectedProviderMsgId?: string;
  /** Complete locator set verified by a real IMAP FLAGS read; compared inside the write transaction. */
  expectedImapLocations?: readonly { mailbox: string; uidvalidity: number; uid: number }[];
  flags: Partial<{ isRead: boolean; isStarred: boolean; inInbox: boolean; isTrash: boolean; isSpam: boolean; isSent: boolean; isDraft: boolean }>;
  /** Gmail: the message's labels now (its category decides who it's from, plan 17); absent: unchanged */
  gmailLabels?: string[];
}

export interface FlagObservation {
  accountId: number;
  protocolId: string;
  epoch: number;
}

export interface FlagObservationOptions {
  authoritativeFlags: boolean;
  signal?: { readonly aborted: boolean; readonly reason?: unknown };
}

export interface FlagReconciliation {
  flagReconcileAccounts?: number[];
}

export interface FlagSnapshotRequest {
  afterMessageId?: number;
  throughMessageId?: number;
  limit: number;
}

export interface FlagSnapshotPage {
  items: { id: number; providerMsgId: string }[];
  throughMessageId: number;
  hasMore: boolean;
}

// ───────────────────────────── lists ─────────────────────────────

export interface Cursor {
  lastDate: number;
  id: number;
}

/** A whole view (account/category optional), for "select all N": ids or a count, never display rows. */
export interface ScopeParams {
  view: View;
  accountId?: number;
  categoryId?: number;
  /** plan 68: one of the account's own folders (with accountId; never with a category) */
  folder?: string;
  /** only threads with something unread (the list's unread filter; `filter: "unread"` since plan 15) */
  unreadOnly?: boolean;
  /** the list's quick filter (wins over unreadOnly) */
  filter?: ListFilter;
  /** the clock the Waiting filter reads its window from (plan 17; the backend passes its own) */
  now?: number;
}

export interface ListParams {
  view: View;
  accountId?: number;
  categoryId?: number;
  /** plan 68: one of the account's own folders (with accountId; never with a category) */
  folder?: string;
  /** only threads with something unread (the list's unread filter; `filter: "unread"` since plan 15) */
  unreadOnly?: boolean;
  /** the list's quick filter (wins over unreadOnly) */
  filter?: ListFilter;
  /** the clock the Waiting filter reads its window from (plan 17; the backend passes its own) */
  now?: number;
  /** with a filter: these threads too while they are in the view, read or not (the open and checked ones stay put; see keepInPage) */
  keepIds?: readonly number[];
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
  reasons: Reason[];
  at: number;
}

export type MovePhase = "moving" | "training" | "done" | "unmoving" | "restoring" | "undone" | "expired";

// ───────────────────────────── ops, owner, drafts ─────────────────────────────

/**
 * next_attempt_at of a queued op that waits for the user to sign in again
 * (expired or revoked authorization): never ready on its own, never counted
 * as an attempt, resumed by ops.resumeAuth when the account works again.
 */
export const AWAITING_AUTH = 8_640_000_000_000_000;

/**
 * next_attempt_at of a queued op that couldn't reach its server (plan 20): never
 * ready on its own (no timer spins on it), resumed by ops.resumeNetwork when the
 * network is back (its account synced, the network changed, the user asked).
 */
export const AWAITING_NETWORK = AWAITING_AUTH - 1;

/** ops.fail's network case: wait for the network; an outage gives the claim's attempt back */
export type OpPark = { network: true; keepAttempt: boolean } | { identity: true; keepAttempt: true };

/** Identity holds resume only after trusted locator evidence, never a network/auth event or timer. */
export const AWAITING_IDENTITY = AWAITING_NETWORK - 1;

export interface OpRow {
  sent_copy?: import("@terno/core").SentCopyState;
  send_partial?: boolean;
  send_recipient_unknown?: boolean;
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
 * The owner is the person this install belongs to (the future "Terno account"),
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
  /** Immutable target fence; empty/omitted only for drafts created before schema 20. */
  generation?: string;
  account_id: number;
  /** the conversation (null: new message, or the conversation is gone) */
  thread_id: number | null;
  /** 1: before v9, bodyText holds everything; 2: the quote is apart */
  format: number;
  mode: "new" | "reply" | "replyAll" | "forward";
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  subject_edited: number;
  body_text: string;
  /** plan 16: the written part as mail HTML ('' = a plain draft) */
  body_html: string;
  attachments_json: string;
  quoted_text: string;
  include_quote: number;
  reply_context_json?: string | null;
  in_reply_to_message_id: number | null;
  forward_of_message_id: number | null;
  show_source_context?: number;
  presentation_thread_id?: number | null;
  ui_state: "open" | "collapsed";
  revision: number;
  updated_at: number;
}

/** What drafts.save writes. Omitted fields keep their stored value on an update, their default on an insert. */
export interface DraftInput {
  id?: number;
  /** Immutable target fence; empty/omitted only for drafts created before schema 20. */
  generation?: string;
  /** the revision this edit was made on: a different stored one means another writer, so this becomes a new draft */
  baseRevision?: number;
  accountId: number;
  /** undefined: derived from inReplyToMessageId's conversation */
  threadId?: number | null;
  /** undefined: "reply" with inReplyToMessageId, else "new" */
  mode?: DraftRow["mode"];
  to: unknown[];
  cc: unknown[];
  bcc?: unknown[];
  subject: string;
  subjectEdited?: boolean;
  bodyText: string;
  /** omitted: '' (a plain draft; the body is rewritten on every save) */
  bodyHtml?: string;
  attachments?: import("@terno/core").AttachmentRef[];
  quotedText?: string;
  includeQuote?: boolean;
  replyContext?: import("@terno/core/rpc").ReplyContext | null;
  inReplyToMessageId?: number | null;
  forwardOfMessageId?: number | null;
  showSourceContext?: boolean;
  uiState?: "open" | "collapsed";
}

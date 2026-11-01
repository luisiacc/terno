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
  repair?: import("@terno/core").CaptureTicket;
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
  /** plan 96: how the sender says to stop their mail (List-Unsubscribe); absent or null: none seen */
  unsubscribe?: import("@terno/core").Unsubscribe | null;
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
  /** plan 86: the Gmail category (MessageCategory); null or absent: not Gmail, or a snapshot from before plan 86 */
  category?: number | null;
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
  /** plan 86: a Gmail tab of the account's Inbox (with accountId, view "inbox") */
  tab?: "promotions" | "social";
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
  /** plan 86: a Gmail tab of the account's Inbox (with accountId, view "inbox") */
  tab?: "promotions" | "social";
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
export type OpPark = { retryAt: number; keepAttempt?: false } | { network: true; keepAttempt: boolean } | { identity: true; keepAttempt: true } | { deferred: true; keepAttempt?: false };

/** How long an op the server keeps deferring (SMTP 4xx, IMAP throttling) is retried, from its creation. */
export const DEFERRED_RETRY_MS = 24 * 60 * 60_000;

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

/** Plan 94: a draft scheduled to send, as listed (its draft's recipients and subject; no params). */
export interface ScheduledSend {
  draftId: number;
  sendAt: number;
  setAt: number;
  accountId: number;
  threadId: number | null;
  mode: DraftRow["mode"];
  to: unknown[];
  subject: string;
  /** why the last try didn't go (null: none failed) */
  error: string | null;
  /** when it is tried again after that (null: at sendAt) */
  retryAt: number | null;
}

/** Plan 94: a scheduled send as stored: the exact compose.send parameters, as JSON. */
export interface ScheduledRow {
  draftId: number;
  sendAt: number;
  setAt: number;
  paramsJson: string;
  error: string | null;
  retryAt: number | null;
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

/** Plan 107: what an .mbox export reads: an account's own folder (`folder`: its key) or one of its standard rows */
/**
 * `aliases`: mailboxes whose locations are the folder's too: the old paths of an IMAP rename made here that no pass has
 * reconciled yet (its threads were carried to the new key, its locations weren't: Codex code review round 5 #2), each
 * by the UIDVALIDITY it had; `except`: the UIDVALIDITYs of the folder's own path that are such a renamed folder's,
 * cached under a path made again since (Codex code review round 6 #2)
 */
export type FolderExportTarget = { accountId: number; folder: string; aliases?: readonly FolderGeneration[]; except?: readonly number[]; view?: undefined } | { accountId: number; view: import("@terno/core").FolderView; folder?: undefined };

/** Plan 107: a mailbox's locations under one UIDVALIDITY */
export interface FolderGeneration {
  mailbox: string;
  uidvalidity: number;
}

/**
 * Plan 107: a place a count reads: a folder's key (its locations and its rows), with `except` the UIDVALIDITYs under
 * its path that are another folder's; or a renamed folder's old path under one UIDVALIDITY (`uidvalidity`: its
 * locations only, no rows). Codex code review round 6 #2: a path made again after a rename here is another folder.
 */
export type FolderPlace = string | { mailbox: string; except: readonly number[] } | FolderGeneration;

/**
 * Plan 107: where an export's id walk goes on: past thread `thread`, or inside it past `message` (a long conversation
 * is read a stretch at a time, in the store's own order). Given back as the store returned it.
 */
export interface FolderExportCursor {
  thread: number;
  message?: { id: number; date: number };
}

/**
 * Plan 107: where a folder count goes on: in the `key`-th folder, past one of its places (`places`: its locations, in
 * the store's own order) or past a thread of its rows (and inside it, past a message). Given back as the store returned it.
 */
export interface FolderCountCursor {
  key: number;
  places: boolean;
  after: number[];
  /** the count's own walk of the places, where the store keeps one between slices (Codex code review round 17 #3) */
  walk?: number;
}

/** Plan 107: a message as the .mbox export writes it, from this computer's copy */
export interface ExportMessage {
  id: number;
  accountId: number;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  date: number;
  subject: string;
  listId: string | null;
  /** which body parts are stored: read a stretch at a time by `folderExport.body` (Codex code review round 6 #4) */
  hasText: boolean;
  hasHtml: boolean;
  bodyState: "none" | "partial" | "full";
  /** `assetId`: its bytes are here (a complete stored asset); null: they aren't */
  attachments: { filename: string; mime: string; size: number; contentId: string | null; assetId: string | null }[];
}

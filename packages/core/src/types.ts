import type { TextKey } from "@terno/i18n";

export type AccountId = number;
export type ThreadId = number;
export type MessageId = number;
export type CategoryId = number;
export type FilterId = number;

export type AccountKind = "imap" | "gmail";

export interface Account {
  id: AccountId;
  kind: AccountKind;
  email: string;
  /** what Terno shows (sidebar, lists) */
  displayName: string;
  color: string;
  /** the name on mail sent from it (From:) */
  senderName: string;
  /** added below what is written when sending from it ("-- \n" + signature); empty: none */
  signature: string;
  /** days of mail its first sync downloads; null: the general setting */
  syncWindowDays: number | null;
  syncState: AccountSyncState;
}

/** What the user can change about an account (accounts.update). */
export interface AccountPatch {
  displayName?: string;
  color?: CategoryColor;
  senderName?: string;
  signature?: string;
  syncWindowDays?: number | null;
}

/** The account preferences kept in its provider config, beside what the provider stores there. */
export interface AccountPrefs {
  senderName?: string;
  signature?: string;
  syncWindowDays?: number | null;
}

/** An account's preferences as the renderer sees them, from its stored config. */
export function accountPrefs(config: AccountPrefs, displayName: string): Pick<Account, "senderName" | "signature" | "syncWindowDays"> {
  return { senderName: config.senderName || displayName, signature: config.signature ?? "", syncWindowDays: config.syncWindowDays ?? null };
}

/** The config with a patch's preferences applied (the rest of the patch lives in columns). */
export function withAccountPrefs<T extends AccountPrefs>(config: T, patch: AccountPatch): T {
  const next = { ...config };
  if (patch.senderName !== undefined) next.senderName = patch.senderName;
  if (patch.signature !== undefined) next.signature = patch.signature;
  if (patch.syncWindowDays !== undefined) {
    if (patch.syncWindowDays === null) delete next.syncWindowDays;
    else next.syncWindowDays = patch.syncWindowDays;
  }
  return next;
}

export interface AccountSyncState {
  status: "idle" | "syncing" | "error" | "offline";
  /** Oldest message date we have synced (ms). Search completeness indicator. */
  syncedSince: number | null;
  bodiesPending: number;
  lastError: string | null;
  /** lastError as a catalog message (when it is one of Terno's): the renderer shows it in the user's language */
  lastErrorI18n?: { key: string; params?: Readonly<Record<string, string | number>> } | null;
  lastSyncAt: number | null;
  /**
   * Plan 20: the account can't reach its server (after two failures in a row, or at once while the
   * device is offline): "offline" until the next retry at `retryAt`, "reconnecting" while it runs.
   * Null (or absent, in rows written before) while the connection is fine or a blip is retried quietly.
   */
  connection?: { state: "offline" | "reconnecting"; retryAt: number | null } | null;
  /** the provider wants the user to sign in again (a revoked or expired grant); cleared by a success */
  authRequired?: boolean;
  /**
   * Plan 25: what the refused sign-in covers. "send": only sending (an IMAP account's SMTP refused it while IMAP
   * works: a sync doesn't prove it, so only signing in again clears it). Absent: the whole account.
   */
  authScope?: "send" | null;
}

export const VIEWS = ["inbox", "starred", "sent", "archive", "spam", "trash", "all"] as const;
export type View = (typeof VIEWS)[number];

export interface Address {
  name: string;
  email: string;
}

/** Minimal row payload for the thread list. Keep small: it crosses the RPC boundary per row. */
export interface ThreadSummary {
  id: ThreadId;
  accountId: AccountId;
  subject: string;
  snippet: string;
  lastDate: number;
  fromName: string;
  fromEmail: string;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  categoryIds: CategoryId[];
  /** plan 17: the newest inbound message is from a person (absent from an older backend) */
  person?: boolean;
  /** plan 17: the date of the message waiting for your reply, or null (the window is applied by whoever reads it) */
  waitingSince?: number | null;
  /** plan 64: where it lives (a search looks everywhere; absent from an older backend) */
  inInbox?: boolean;
  inSpam?: boolean;
  inTrash?: boolean;
  /** a message of it is spam, wherever it is now (trashed spam too): never a sender icon (plan 22) */
  hasSpam?: boolean;
  /** renderer only: it was spam a moment ago (Not spam, not yet confirmed): still no sender icon */
  spamHeld?: boolean;
}

export interface MessageDetail {
  id: MessageId;
  threadId: ThreadId;
  accountId: AccountId;
  from: Address;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  date: number;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyState: "none" | "partial" | "full";
  bodyUnavailable?: "size";
  /** Independent of body completeness; absent legacy projections are unknown. */
  attachmentState?: "pending" | "complete" | "unavailable";
  isRead: boolean;
  isStarred: boolean;
  isSent: boolean;
  hasAttachments: boolean;
  rfcMessageId: string | null;
  references: string[];
  listId: string | null;
  attachments: AttachmentInfo[];
}

export interface AttachmentInfo {
  id: number;
  assetId?: string;
  contentId?: string | null;
  filename: string;
  mime: string;
  size: number;
}

export interface ThreadDetail {
  thread: ThreadSummary & { inInbox: boolean; inTrash: boolean; inSpam: boolean };
  messages: MessageDetail[];
  /** what the categorization engine did or suggests here, with its reasons */
  categorization?: {
    auto: { categoryId: CategoryId; reasons: Reason[] }[];
    suggestions: { categoryId: CategoryId; p: number; reasons: Reason[] }[];
  };
}

/**
 * Why the categorization engine filed or suggests a conversation. A catalog
 * descriptor (key + params) that the reader renders in the user's language;
 * a plain string is a reason persisted before reasons were localized, shown
 * as it is.
 */
export type Reason = string | { k: TextKey; p?: Record<string, string | number> };

export interface Category {
  id: CategoryId;
  name: string;
  color: CategoryColor;
  position: number;
  /** the engine may add new mail to it on its own (otherwise it only suggests) */
  autoApply: boolean;
}

export const CATEGORY_COLORS = [
  "rose",
  "amber",
  "lime",
  "emerald",
  "cyan",
  "indigo",
  "violet",
  "slate",
] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];

export interface Counts {
  /** unread THREADS per view (only inbox is tracked as unread count) */
  inboxUnread: number;
  inboxUnreadByAccount: Record<AccountId, number>;
  categoryUnread: Record<CategoryId, number>;
  categoryTotal: Record<CategoryId, number>;
  /** suggestions waiting for an answer ("Revisar") */
  categorySuggestions: Record<CategoryId, number>;
  /** plan 17: inbox threads waiting for your reply (inside the window); null until the store's facts are complete, absent from an older backend */
  inboxWaiting?: number | null;
  inboxWaitingByAccount?: Record<AccountId, number>;
}

export type ThreadAction =
  | "archive"
  | "trash"
  | "spam"
  | "notSpam"
  | "moveToInbox"
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar";

export type UserActionKind = "archive" | "trash" | "spam" | "star" | "reply" | "markImportant" | "read";

export type OpState = "queued" | "running" | "succeeded" | "failed" | "unknown";

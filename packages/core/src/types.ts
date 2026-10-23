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
  displayName: string;
  color: string;
  syncState: AccountSyncState;
}

export interface AccountSyncState {
  status: "idle" | "syncing" | "error" | "offline";
  /** Oldest message date we have synced (ms). Search completeness indicator. */
  syncedSince: number | null;
  bodiesPending: number;
  lastError: string | null;
  lastSyncAt: number | null;
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
}

export interface MessageDetail {
  id: MessageId;
  threadId: ThreadId;
  accountId: AccountId;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: number;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyState: "none" | "partial" | "full";
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
  filename: string;
  mime: string;
  size: number;
}

export interface ThreadDetail {
  thread: ThreadSummary & { inInbox: boolean; inTrash: boolean; inSpam: boolean };
  messages: MessageDetail[];
}

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

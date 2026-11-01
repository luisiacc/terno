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
  /** plan 101: older mail is downloading back to this (ms); null: nothing pending */
  backfillSince?: number | null;
  /** plan 86 (Gmail): Promotions and Social live under the account, out of the Inbox; on unless turned off (absent: on) */
  separateTabs?: boolean;
  syncState: AccountSyncState;
}

/** What the user can change about an account (accounts.update). */
export interface AccountPatch {
  displayName?: string;
  color?: CategoryColor;
  senderName?: string;
  signature?: string;
  syncWindowDays?: number | null;
  separateTabs?: boolean;
  /**
   * plan 101: backend only (never in the RPC schema), applied inside the store's update transaction so concurrent
   * changes never lose one another: `merge` a widening into the pending span (their union), `clearIf` it's done
   * (only that exact request: a wider one recorded meanwhile stays), null cancels.
   */
  backfill?: { merge: BackfillRequest } | { clearIf: BackfillRequest } | null;
}

/** Plan 101: the span of older mail to download (ms), recorded when an account's window widens. */
export interface BackfillRequest {
  since: number;
  until: number;
}

/** The account preferences kept in its provider config, beside what the provider stores there. */
export interface AccountPrefs {
  senderName?: string;
  signature?: string;
  syncWindowDays?: number | null;
  /** plan 86: absent: on */
  separateTabs?: boolean;
  /** plan 101: older mail still to download */
  backfill?: BackfillRequest;
}

/** An account's preferences as the renderer sees them, from its stored config. */
export function accountPrefs(config: AccountPrefs, displayName: string): Pick<Account, "senderName" | "signature" | "syncWindowDays" | "separateTabs" | "backfillSince"> {
  return { senderName: config.senderName || displayName, signature: config.signature ?? "", syncWindowDays: config.syncWindowDays ?? null, separateTabs: config.separateTabs !== false, backfillSince: config.backfill?.since ?? null };
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
  if (patch.separateTabs !== undefined) {
    if (patch.separateTabs) delete next.separateTabs;
    else next.separateTabs = false;
  }
  if (patch.backfill === null) delete next.backfill;
  else if (patch.backfill && "merge" in patch.backfill) {
    const add = patch.backfill.merge, was = next.backfill;
    next.backfill = was ? { since: Math.min(was.since, add.since), until: Math.max(was.until, add.until) } : { since: add.since, until: add.until };
  } else if (patch.backfill && "clearIf" in patch.backfill) {
    if (next.backfill?.since === patch.backfill.clearIf.since && next.backfill.until === patch.backfill.clearIf.until) delete next.backfill;
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
  /**
   * plan 103: how far a first sync (or a backfill, plan 101) has got, for the sidebar's card: messages done of a
   * total when the provider can say (Gmail's estimate, IMAP's folders), and the oldest date it has reached
   * (newest first: what's left is the days between it and the window's start). null: nothing running.
   */
  progress?: SyncProgress | null;
}

/** Plan 103: a long sync's progress, as its provider can tell it. */
export interface SyncProgress {
  done?: number;
  total?: number;
  /** what done/total count */
  unit?: "messages" | "folders";
  /** the oldest received date downloaded so far (ms) */
  reachedAt?: number;
  /** all downloaded; the rest is checking what's here */
  finishing?: boolean;
  /** plan 104: where the listing stops (ms): what "days left" counts to (absent: the account's window) */
  since?: number;
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
  /** plan 86: the Gmail tab it's in (0 or absent: none; whether it's shown apart is the account's setting) */
  tab?: number;
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
  /** plan 83: its mail shows in the Inbox (off: the Inbox, its counts and notifications leave it out) */
  showInInbox: boolean;
}

/**
 * Plan 68: a folder of the account's own: an IMAP mailbox that holds no role, a Gmail user label. Standard
 * folders (Inbox, Sent…) are views, never folders.
 */
export interface Folder {
  accountId: AccountId;
  /** IMAP: the mailbox path; Gmail: the label id */
  key: string;
  /** the names from the top, the last one shown ("Work", "Clients") */
  path: string[];
  /** false: it only groups the folders under it (an IMAP \Noselect parent) */
  selectable: boolean;
  /**
   * plan 107 (IMAP): UIDVALIDITYs cached under this path that are another folder's: a generation a rename or delete
   * made here took away, the path made again since (Codex code review round 8 #1). Their places make no membership
   * here, and a count or export of it leaves them out. Absent: none.
   */
  except?: number[];
}

/** Plan 107: an account's standard places a favorite can point at (the rows under an open account). */
export const FOLDER_VIEWS = ["inbox", "sent", "archive", "spam", "trash"] as const;
export type FolderView = (typeof FOLDER_VIEWS)[number];
/** Plan 107: a folder shown below Starred: one of an account's own (`folder`: its key) or a standard row (`view`) */
export interface FavoriteFolder {
  accountId: AccountId;
  folder: string | null;
  view: FolderView | null;
}
export const FAVORITES_MAX = 50;
/** Plan 107: a folder an account's change renamed (IMAP: a new key; Gmail: the same key, a new name) */
export interface FolderRename {
  accountId: AccountId;
  from: string;
  to: string;
}

/** Folder names (Gmail's own limit) and how many an account lists (plan 68: a catalog is bounded) */
export const FOLDER_NAME_MAX = 225;
export const FOLDERS_PER_ACCOUNT_MAX = 10_000;
/** A folder's place in counts: "accountId:key" */
export const folderRef = (accountId: AccountId, key: string) => `${accountId}:${key}`;
/** A Gmail tab's place in counts: "accountId:promotions" (plan 86) */
export const tabRef = (accountId: AccountId, tab: "promotions" | "social") => `${accountId}:${tab}`;
/**
 * The standard folders whose unread threads the sidebar counts besides the Inbox: Sent's would only repeat it, and
 * Trash has none (a trashed message is never unread).
 */
export const COUNTED_VIEWS = ["archive", "spam"] as const;
export type CountedView = (typeof COUNTED_VIEWS)[number];
/** A counted folder's place in counts: "accountId:archive" */
export const viewRef = (accountId: AccountId, view: CountedView) => `${accountId}:${view}`;

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
  /** plan 68: unread threads per folder, by folderRef (listed folders only; absent from an older backend) */
  folderUnread?: Record<string, number>;
  /** plan 86: unread threads per Gmail tab, by tabRef (accounts that separate them; absent from an older backend) */
  tabUnread?: Record<string, number>;
  /** unread threads in each account's Archive and Spam, by viewRef (absent from an older backend) */
  viewUnread?: Record<string, number>;
}

/** Plan 87: "always" comes back at its time; "noReply" only if nobody but you wrote in the thread since it was set. */
export const REMINDER_KINDS = ["always", "noReply"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Plan 87: a thread's reminder. Local: no provider keeps them (they don't sync, a backup doesn't carry them). */
export interface Reminder {
  threadId: ThreadId;
  dueAt: number;
  kind: ReminderKind;
  /** when it was set: a "noReply" one counts only answers after it */
  setAt: number;
}

/** Plan 87: how many reminders a mailbox holds at once (bounds every read of them) */
export const REMINDERS_MAX = 1000;

/** Plan 94: how many sends can be scheduled at once, and how much their prepared messages may hold together (UTF-16 units) */
export const SCHEDULED_MAX = 100;
export const SCHEDULED_BYTES_MAX = 64 * 1024 * 1024;
/** Plan 94: the "Tomorrow" choice's hour */
export const SEND_LATER_MORNING = 8;

export type ThreadAction =
  | "archive"
  | "trash"
  | "spam"
  | "notSpam"
  | "moveToInbox"
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar"
  // plan 86: a Gmail message's category (toPrimary moves it out of a tab; the others are undo's)
  | "toPrimary"
  | "toPromotions"
  | "toSocial"
  | "toUpdates"
  | "toForums"
  | "toNoCategory";

export type UserActionKind = "archive" | "trash" | "spam" | "star" | "reply" | "markImportant" | "read";

export type OpState = "queued" | "running" | "succeeded" | "failed" | "unknown";

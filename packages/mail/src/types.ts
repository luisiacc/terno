import type { Account, AccountSyncState, Address } from "@unica/core";
import type { Db, IncomingMessage } from "@unica/db";

export interface SendPayload {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  /** RFC Message-ID we generated, without angle brackets */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  providerThreadId: string | null;
}

export interface ProviderOp {
  id: string;
  kind: string;
  target: { messageIds?: number[] };
  payload: unknown;
}

/**
 * retryable: transient (network, 5xx, 429) → backoff and retry.
 * ambiguous: the outcome is unknown (e.g. connection lost after SMTP DATA) → never retried.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Where providers deliver synced data. The backend implements it (chunking, filters, events). */
export interface SyncSink {
  ingest(messages: IncomingMessage[]): Promise<void>;
  setBody(messageId: number, text: string | null, html: string | null): Promise<void>;
  removeMessages(messageIds: number[]): Promise<void>;
  /** Applies provider-side state to existing messages (skips messages with pending local ops). */
  updateFlags(updates: FlagUpdate[]): Promise<void>;
  /** Sync window start (ms): only mail newer than this is downloaded initially. */
  windowStart: number;
  /** message ids with unsettled local ops: don't overwrite their flags */
  pendingMessageIds(): Set<number>;
  setSyncState(patch: Partial<AccountSyncState>): void;
  signal: AbortSignal;
}

export interface FlagUpdate {
  messageId: number;
  flags: Partial<{ isRead: boolean; isStarred: boolean; inInbox: boolean; isTrash: boolean; isSpam: boolean; isSent: boolean; isDraft: boolean }>;
}

export interface ProviderContext {
  db: Db;
  account: Account;
  config: Record<string, unknown>;
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  /** app-wide secrets (e.g. the Gmail OAuth client secret) */
  getAppSecret(name: string): Promise<string | null>;
  /** persistent provider sync cursor (stored on the account) */
  loadCursor<T>(): T | null;
  saveCursor(cursor: unknown): void;
  /** every HTTP request a provider makes goes through this (the backend's network policy, purpose "mail") */
  fetch: typeof fetch;
}

export interface MailProvider {
  verify(): Promise<void>;
  sync(sink: SyncSink): Promise<void>;
  /** Executes a queued op. For `send`, returns the provider's id of the sent message when known. */
  execute(op: ProviderOp): Promise<{ providerMsgId?: string; providerThreadId?: string; warning?: string } | void>;
  /** Push notifications (IMAP IDLE, Gmail push). Calls onChange when a sync is worthwhile. */
  watch?(onChange: () => void): () => void;
  close(): Promise<void>;
}

export interface ImapAccountConfig {
  imap: { host: string; port: number; secure: boolean; user: string };
  smtp: { host: string; port: number; secure: boolean; user: string };
  senderName: string;
  /** whether to APPEND sent mail to the Sent folder (most generic IMAP servers need it) */
  appendToSent: boolean;
}

export interface GmailAccountConfig {
  senderName: string;
}

export interface GmailConnectResult {
  email: string;
  name: string;
  refreshToken: string;
}

export interface ProviderRegistry {
  create(ctx: ProviderContext): MailProvider;
  verifyImap(config: ImapAccountConfig, password: string): Promise<void>;
  connectGmail(options: { clientId: string; clientSecret: string | null; openExternal: (url: string) => Promise<void>; signal?: AbortSignal; fetch: typeof fetch }): Promise<GmailConnectResult>;
}

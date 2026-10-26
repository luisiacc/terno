import { textRef, type Account, type AccountSyncState, type Address, type TextRef } from "@terno/core";
import type { Localized } from "@terno/i18n";
import type { FlagUpdate, IncomingMessage, ProviderStore } from "@terno/store";

export type { FlagUpdate } from "@terno/store";

export interface SendPayload {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  /** plan 16: the text/html alternative (a rich draft); absent: a single text/plain part, as before */
  html?: string;
  /** Persisted as immutable refs; dispatch resolves dataBase64 before submission. */
  attachments?: (import("@terno/core").AttachmentRef & { dataBase64?: string })[];
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
 * network: the server couldn't be reached at all (DNS, refused, reset, unreachable, timed out):
 * retryable, never ambiguous; ops wait for the network instead of spending attempts (plan 20).
 */
export class ProviderError extends Error {
  /** set when the message is a catalog message (L()): the renderer translates it */
  readonly i18n?: TextRef;
  constructor(
    message: string | Localized,
    readonly retryable: boolean,
    readonly ambiguous = false,
    readonly network = false,
  ) {
    super(typeof message === "string" ? message : message.message);
    this.name = "ProviderError";
    const i18n = textRef(message);
    if (i18n) this.i18n = i18n;
  }

  /** the server couldn't be reached: retryable, and the network is the likely cause */
  static network(message: string | Localized): ProviderError {
    return new ProviderError(message, true, false, true);
  }

  /** transient (offline, 5xx, 429) or unknowable: the provider classified it, not our bug */
  get expected(): boolean {
    return this.retryable || this.ambiguous;
  }
}

/**
 * The user has to sign in again (expired or revoked authorization). Ops
 * wait for it without spending attempts and resume when the account works
 * again (a successful sync, a reconnect).
 */
export class ProviderAuthError extends ProviderError {
  constructor(message: string | Localized) {
    super(message, false);
    this.name = "ProviderAuthError";
  }

  override get expected(): boolean {
    return true;
  }
}

/** Where providers deliver synced data. The backend implements it (chunking, filters, events). */
export interface SyncSink {
  ingest(messages: IncomingMessage[]): Promise<void>;
  setBody(messageId: number, text: string | null, html: string | null, attachments?: import("@terno/store").IncomingAttachment[]): Promise<void>;
  removeMessages(messageIds: number[]): Promise<void>;
  /** Applies provider-side state to existing messages (skips messages with pending local ops). */
  updateFlags(updates: FlagUpdate[]): Promise<void>;
  /** Sync window start (ms): only mail newer than this is downloaded initially. */
  windowStart: number;
  /** message ids with unsettled local ops: don't overwrite their flags */
  pendingMessageIds(): Promise<Set<number>>;
  setSyncState(patch: Partial<AccountSyncState>): Promise<void>;
  signal: AbortSignal;
}


export interface ProviderContext {
  /** the provider's reads and IMAP identity (never the database itself) */
  store: ProviderStore;
  account: Account;
  config: Record<string, unknown>;
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  /** app-wide secrets (e.g. the Gmail OAuth client secret) */
  getAppSecret(name: string): Promise<string | null>;
  /** persistent provider sync cursor (stored on the account) */
  loadCursor<T>(): Promise<T | null>;
  saveCursor(cursor: unknown): Promise<void>;
  /** every HTTP request a provider makes goes through this (the backend's network policy, purpose "mail") */
  fetch: typeof fetch;
  /** plan 20: push stopped or came back (diagnostics; counts and durations only) */
  event?(code: "push.lost" | "push.restored", fields?: { durationMs?: number }): void;
}

export interface MailProvider {
  verify(): Promise<void>;
  sync(sink: SyncSink): Promise<void>;
  /** Executes a queued op. For `send`, returns the provider's id of the sent message when known. */
  execute(op: ProviderOp): Promise<{ providerMsgId?: string; providerThreadId?: string; warning?: string | Localized } | void>;
  /** Push notifications (IMAP IDLE, Gmail push). Calls onChange when a sync is worthwhile. */
  watch?(onChange: () => void): () => void;
  /**
   * The network changed (plan 20): every socket the provider holds is presumed dead. Drop them
   * now without waiting on them; requests safe to repeat fail fast (retryable), a send in flight
   * is left alone; push reconnects at once.
   */
  reset?(): void;
  /** plan 20: the sync tick asks push whether it still hears the server (a dead session reconnects) */
  heartbeat?(): void;
  /** plan 22 (Gmail): the account's own picture and its contacts' photos, as far as the grant allows */
  photos?(want: import("./google-photos").PhotoWant, signal?: AbortSignal): Promise<import("./google-photos").GooglePhotos>;
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
  /** OpenID subject: Google's stable id for the person (evidence for owner identity) */
  sub: string | null;
  emailVerified: boolean;
  /** effective grant; omitted token-response scope means the originally requested scopes */
  grantedScopes?: string[];
}

/** The web's Gmail sign-in: short-lived access tokens from Google's token model, kept in memory. */
export interface GmailTokenBroker {
  /** whose mailbox the token opens (Gmail profile + OpenID userinfo) */
  inspect(accessToken: string, netFetch: typeof fetch, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Omit<GmailConnectResult, "refreshToken">>;
  /** hands the token to that account's provider until it expires */
  set(accountId: number, accessToken: string, expiresAt: number): void;
  /** release the removed account's in-memory credential */
  forget?(accountId: number): void;
}

export interface ProviderRegistry {
  /** demo registries never verify anything, so they never establish an owner */
  readonly kind?: "demo";
  /** web: Gmail connects through the page's Google sign-in instead of connectGmail */
  readonly gmailTokens?: GmailTokenBroker;
  create(ctx: ProviderContext): MailProvider;
  verifyImap(config: ImapAccountConfig, password: string): Promise<void>;
  connectGmail(options: { clientId: string; clientSecret: string | null; openExternal: (url: string) => Promise<void>; signal?: AbortSignal; fetch: typeof fetch; loginHint?: string; scopes?: string[] }): Promise<GmailConnectResult>;
}

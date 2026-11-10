import type { IncomingReadAdmission } from "./incoming";
import type { IncomingProcessor } from "./incoming-processing";
import { textRef, type Account, type AccountSyncState, type Address, type TextRef } from "@terno/core";
import type { Localized } from "@terno/i18n";
import type { FlagUpdate, IncomingMessage, ProviderFolder, ProviderStore } from "@terno/store";

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
  requestRun?: RequestRun;
  submissionAccepted?(): void;
  recipientOutcomes?(outcomes: import("./smtp").RecipientOutcome[]): void;
  submissionWarning?(warning: Localized | undefined): void;
  recovery?: { raw: Uint8Array; envelope: { from: string; to: string[] } };
  beforeSubmission?(): Promise<void>;
  sentCopy?: import("./sent-copy").SentCopyHooks;
  sentCopyRequested?: boolean;
}

export type HttpRequestContext =
  | { readonly endpoint: "gmail-api"; readonly purpose: "mail" | "identity-proof" }
  | { readonly endpoint: "oauth-token"; readonly purpose: "refresh" | "authorization-code" }
  | { readonly endpoint: "google-people"; readonly purpose: "photos" | "grant-proof" }
  | { readonly endpoint: "google-userinfo"; readonly purpose: "photos" | "identity-proof" }
  | { readonly endpoint: "unknown"; readonly purpose: "unknown" };

export type BoundedHttpHeader =
  | { readonly kind: "not-visible" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "too-long" };

export type HttpReceipt =
  | { readonly source: "date-now"; readonly kind: "wall"; readonly wallMs: number }
  | { readonly source: "date-now"; readonly kind: "invalid" };

export interface HttpResponseEvidence {
  readonly source: "http-response";
  readonly request: HttpRequestContext;
  readonly status: number;
  readonly quotaScope: "unknown";
  readonly received: HttpReceipt;
  readonly retryAfter: BoundedHttpHeader;
  readonly serverDate: BoundedHttpHeader;
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
  /** Local evidence only: raw response fields must never enter error projections. */
  declare readonly httpResponse?: HttpResponseEvidence;
  constructor(
    message: string | Localized,
    readonly retryable: boolean,
    readonly ambiguous = false,
    readonly network = false,
    httpResponse?: HttpResponseEvidence,
  ) {
    super(typeof message === "string" ? message : message.message);
    this.name = "ProviderError";
    const i18n = textRef(message);
    if (i18n) this.i18n = i18n;
    if (httpResponse) Object.defineProperty(this, "httpResponse", { value: httpResponse });
  }

  /** the server couldn't be reached: retryable, and the network is the likely cause */
  static network(message: string | Localized): ProviderError {
    return new ProviderError(message, true, false, true);
  }

  /** set by deferred(): the server answered "later" (SMTP 4xx, a throttled IMAP command) */
  declare readonly deferred?: true;
  /** The server answered "not now": retried far longer than a fault (servers defer for minutes to hours). */
  static deferred(message: string | Localized): ProviderError {
    const error = new ProviderError(message, true);
    Object.defineProperty(error, "deferred", { value: true });
    return error;
  }

  /** transient (offline, 5xx, 429) or unknowable: the provider classified it, not our bug */
  get expected(): boolean {
    return this.retryable || this.ambiguous;
  }
}

/** The target has no proven IMAP identity; keep its intent parked until trusted evidence arrives. */
export class ProviderIdentityError extends ProviderError {
  constructor(message: string | Localized) { super(message, false); }
}

/**
 * The user has to sign in again (expired or revoked authorization). Ops
 * wait for it without spending attempts and resume when the account works
 * again (a successful sync, a reconnect).
 */
export class ProviderAuthError extends ProviderError {
  constructor(message: string | Localized, httpResponse?: HttpResponseEvidence) {
    super(message, false, false, false, httpResponse);
    this.name = "ProviderAuthError";
  }

  override get expected(): boolean {
    return true;
  }
}

/** Where providers deliver synced data. The backend implements it (chunking, filters, events). */
/** plan 101: a pass's share of older mail; then another pass (new mail and its notices are never more than this behind) */
export const BACKFILL_CHUNK_MS = 30_000;

export interface SyncSink {
  captureRetry?: { locator: import("@terno/core").CaptureLocator; revision: number };
  blockCapture?(locator: import("@terno/core").CaptureLocator, reason: import("@terno/core").CaptureReason, revision: number): Promise<void>;
  retireCapture?(locator: import("@terno/core").CaptureLocator): Promise<void>;
  /**
   * `live` (plan 41): the server says these are new since the last cursor (Gmail's history, IMAP's
   * UIDs past a known uidnext), not a first sync, a resync or a re-fetch. Only live mail may notify.
   */
  ingest(messages: IncomingMessage[], o?: { live?: boolean }): Promise<void>;
  setBody(messageId: number, text: string | null, html: string | null, attachments?: import("@terno/store").IncomingAttachment[], capture?: { signal?: AbortSignal; bodyParts?: import("@terno/core").ExactBodyParts; preparedBodyTokens?: Uint16Array[]; captureUnavailable?: "size"; repair?: import("@terno/core").CaptureTicket }): Promise<void>;
  removeMessages(messageIds: number[]): Promise<void>;
  /** Applies provider state, preserving fields affected by queued/running local operations. */
  updateFlags(updates: FlagUpdate[], o?: { authoritative?: false }): Promise<void>;
  /** Sync window start (ms): only mail newer than this is downloaded initially. */
  windowStart: number;
  /** Effective configured window; stable across retries even as windowStart advances with the clock. */
  windowDays?: number;
  /**
   * Plan 101: older mail a widened window asks for (ms), downloaded after the pass's own work, a bounded chunk a
   * pass: `backfillMore()` asks for another pass soon, `backfillDone(request)` says the span is all here.
   */
  backfill?: import("@terno/core").BackfillRequest;
  backfillMore?(): void;
  /** plan 102: more of this account's sync remains (a first sync's next chunk): another pass soon */
  again?(): void;
  /**
   * Plan 176: a quick check (only to a provider with `quickChecks`): new mail and changes since the cursor, nothing
   * else. Repairs, flag snapshots, attachment captures, backfill and a first sync or catch-up wait for an ordinary
   * pass; one that can't go on from its cursor (history expired) asks for one with `again()` and stops.
   */
  quick?: true;
  /** plan 103: how far a first sync or a backfill has got (the host throttles what it writes) */
  progress?(progress: import("@terno/core").SyncProgress): void;
  backfillDone?(request: import("@terno/core").BackfillRequest): Promise<void>;
  /** Message ids with queued/running local operations; field protection is applied by updateFlags. */
  pendingMessageIds(): Promise<Set<number>>;
  setSyncState(patch: Partial<AccountSyncState>): Promise<void>;
  /**
   * plan 68: the account's own folders now (the store compares; an unchanged list writes nothing). The backend's sink
   * has it; a bare test sink may not. plan 107: `renamed`, renames made here that this list shows done and that the
   * backend hasn't followed (Codex code review round 15 #2: the provider's acknowledgement decides); `deleted`,
   * paths deleted here that this list shows done and that nothing announced yet (their answer was lost); `unproven`,
   * new keys of renames this pass retired whose carried rows no read proved (the new path read as another generation):
   * cleared and derived again from their places (Codex code review round 25 #1)
   */
  setFolders?(folders: readonly ProviderFolder[], renamed?: readonly FolderMove[], deleted?: readonly string[], unproven?: readonly string[]): Promise<void>;
  signal: AbortSignal;
}


export type MailAdmission = "background" | "send" | "reader";

export interface GoogleRequests {
  generation(): number;
  check(request: HttpRequestContext, admission?: MailAdmission): void;
  request(descriptor: RequestDescriptor, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response>;
  /** The host invokes read with a generation-fenced, shared proof starter. */
  prove(read: () => Promise<string>, admission?: MailAdmission): Promise<void>;
  tokenUnavailable(): void;
  accessAvailable(): void;
}

export interface ProviderContext {
  /** Give interactive work a turn after a page that produced no sliced effects. */
  yield?(): Promise<void>;
  /** Installed by BackendCore for every saved Gmail account; standalone transports own their policy. */
  google?: GoogleRequests;
  /** One result from the shared refresh, qualified to its issuing credentials. */
  tokenResult?(generation: number, error?: ProviderAuthError): void | Promise<void>;
  /** The backend owns durable flag observations and committed snapshot paging. */
  flagObservation?: true;
  /** Shared by this backend; standalone provider callers may retain their own read limit. */
  incoming?: IncomingReadAdmission;
  incomingProcessor?: Pick<IncomingProcessor, "run">;
  /** the provider's reads and IMAP identity (never the database itself) */
  store: ProviderStore;
  account: Account;
  config: Record<string, unknown>;
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  /** Durable encrypted CAS for this lifetime/mailbox. False means missing or changed credentials; failures throw.
   * Equal plaintext asserts ownership without rewriting. After an uncertain commit, next→next can confirm it.
   * Success is checked again after persistence; a closed lifetime never publishes success.
   */
  replaceSecret(name: string, expectedPlaintext: string, nextPlaintext: string): Promise<boolean>;
  /** app-wide secrets (e.g. the Gmail OAuth client secret) */
  getAppSecret(name: string): Promise<string | null>;
  /** plan 99: the Google OAuth client this account's refresh token belongs to (null: it isn't here any more) */
  googleClient?(): Promise<{ clientId: string; clientSecret: string | null } | null>;
  /** persistent provider sync cursor (stored on the account) */
  loadCursor<T>(): Promise<T | null>;
  saveCursor(cursor: unknown, check?: () => void): Promise<void>;
  /** every HTTP request a provider makes goes through this (the backend's network policy, purpose "mail") */
  fetch: typeof fetch;
  /** plan 20: push stopped or came back (diagnostics; counts and durations only) */
  event?(code: "push.lost" | "push.restored", fields?: { durationMs?: number }): void;
}

/** Plan 107: an account's own folders after a change, as its server lists them now. */
/**
 * Plan 107: a folder that moved (a rename). `stale`: the store's rows under `from` are another generation of that
 * path than the one that moved (made again since, nothing of the moved one cached): announced, never carried (Codex
 * code review round 8).
 */
export interface FolderMove {
  from: string;
  to: string;
  stale?: true;
}

export interface FolderChange {
  folders: ProviderFolder[];
  /** part of it didn't happen (a refusal midway): what to tell; `folders` and the keys say what did */
  partial?: ProviderError;
}

/** Plan 141: what a server search looks for, as Ask's plan validated it. */
export interface ProviderQuery {
  /** all of them */
  terms: string[];
  /** one of each group */
  anyOf?: string[][];
  from?: string;
  to?: string;
  subject?: string;
  /** ms */
  after?: number;
  before?: number;
  hasAttachment?: boolean;
}

/** One message a server found: only what it takes to fetch it and to put it in date order. */
export interface ProviderHit {
  id: string;
  /** ms */
  date: number;
  /** IMAP: where it is */
  place?: { mailbox: string; uidvalidity: number; uid: number };
}

export interface MailProvider {
  /**
   * Plan 141: asks the server, on a person's click, which older messages match. Reads no body and stores nothing.
   * `partial`: part of the mailbox wasn't searched (a deadline, a folder that refused).
   */
  search?(input: { queries: readonly ProviderQuery[]; before: number; limit: number; signal: AbortSignal }): Promise<{ hits: ProviderHit[]; partial: boolean }>;
  /** Plan 141: downloads these and ingests them as old mail (`live: false`). */
  fetchHits?(hits: readonly ProviderHit[], sink: SyncSink): Promise<void>;
  /** This provider can supply fresh authoritative evidence for all user-controlled flags. */
  flagSnapshots?: true;
  /** Envelopes describe a single location and cannot confirm all-location state. */
  flagSnapshotSource?: "locations";
  verify(): Promise<void>;
  sync(sink: SyncSink): Promise<void>;
  /** Explicit cached-message body read; never enumerates mail or loads embedded resources. */
  readBody?(target: { id: number; providerMsgId: string }, signal: AbortSignal): Promise<{ parsed: import("./mime").ParsedMessage; release(): void } | null>;
  /**
   * Plan 68: after a pass that worked, the account's own folders when the provider keeps them apart from its
   * mail (Gmail's /labels: read when unknown, stale or met in the pass; otherwise nothing). IMAP lists them in sync.
   */
  folders?(sink: SyncSink): Promise<void>;
  /**
   * Executes a queued op. For `send`, returns the provider's id of the sent message when known.
   *
   * `send` is every message Terno sends: the composer's, a scheduled one (plan 94) and an automatic forward
   * (plan 116) all arrive here as the same SendPayload, files included, and nothing else is asked of a provider
   * for them. A new provider (Outlook) proves it in packages/backend/src/forwarding-delivery.int.test.ts:
   * add a harness for its server to DELIVERIES.
   */
  execute(op: ProviderOp): Promise<{ providerMsgId?: string; providerThreadId?: string; warning?: string | Localized } | void>;
  /** Deliberate copy-only recovery. Never submits a message to SMTP. */
  repairSentCopy?(input: { raw: Uint8Array; messageId: string; mailbox: string | null }, hooks: import("./sent-copy").SentCopyHooks): Promise<void>;
  /** Push notifications (IMAP IDLE). Calls onChange when a sync is worthwhile. */
  watch?(onChange: () => void): () => void;
  /**
   * Plan 176: the provider honours `SyncSink.quick`, and a quick pass with nothing new is one small request (Gmail:
   * one /history read, 2 of its 6,000 quota units a minute). Such an account is checked every 5 s for a minute after
   * a Terno window gains focus, since someone coming to Terno is often waiting for a code or a link. A provider with
   * push (`watch`) hears of new mail anyway and leaves it unset. A new provider without push (Outlook over Microsoft
   * Graph, whose change notifications need a public webhook) sets it once its quick pass is that cheap (Graph: a
   * delta query on the Inbox); until then it is only polled. docs/plans/176-quick-checks-on-focus.md.
   */
  readonly quickChecks?: true;
  /**
   * The network changed (plan 20): every socket the provider holds is presumed dead. Drop them
   * now without waiting on them; requests safe to repeat fail fast (retryable), a send in flight
   * is left alone; push reconnects at once.
   */
  reset?(): void;
  /** plan 20: the sync tick asks push whether it still hears the server (a dead session reconnects) */
  heartbeat?(): void;
  /**
   * Plan 107: the account's own folders changed on its server (IMAP mailboxes, Gmail labels), checked against its
   * catalog first. `folders`: the account's list as stored, for a provider with no catalog of its own (the demo).
   * Each answers with the list as the server has it now; the host holds the account's sync and ops meanwhile.
   */
  createFolder?(input: { parent: string | null; name: string; folders: readonly ProviderFolder[] }): Promise<FolderChange & { key: string }>;
  /** Plan 107: its subfolders follow; `renamed`: where each went (Gmail: the same keys) */
  renameFolder?(input: { key: string; name: string; folders: readonly ProviderFolder[] }): Promise<FolderChange & { renamed: FolderMove[] }>;
  /** Plan 107: with its subfolders (IMAP: and their mail, which the next sync forgets here); `deleted`: the keys that went */
  deleteFolder?(input: { key: string; folders: readonly ProviderFolder[] }): Promise<FolderChange & { deleted: string[] }>;
  /**
   * Plan 107: the host has persisted what followed these deletions (their favorites went), so no pass announces them
   * again. Called only after that write: a change that failed before it (a LIST after the DELETE) leaves them for the
   * pass that shows them gone (Codex code review round 13 #1).
   */
  deletionsFollowed?(deleted: readonly string[]): Promise<void>;
  /**
   * Plan 107: the host has stored and announced these moves and followed them (favorites), so a pass never holds them
   * back. Called only after that write: a change that failed before it (a LIST after the RENAME) leaves them for a
   * pass to settle (Codex code review round 14 #1).
   */
  renamesFollowed?(renamed: readonly FolderMove[]): Promise<void>;
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
  /** Verified on explicit consent only; never inferred from the mailbox. */
  googleSubject?: string;
  /** plan 99: the OAuth client that issued the refresh token (it works with no other) */
  googleClientId?: string;
  senderName: string;
}

export interface GmailConnectResult {
  email: string;
  name: string;
  refreshToken: string | null;
  /** OpenID subject: Google's stable id for the person (evidence for owner identity) */
  sub: string | null;
  emailVerified: boolean;
  /** effective grant; omitted token-response scope means the originally requested scopes */
  grantedScopes?: string[];
}

/** The web's Gmail sign-in: short-lived access tokens from Google's token model, kept in memory. */
export interface GmailTokenBroker {
  /** whose mailbox the token opens (Gmail profile + OpenID userinfo) */
  inspect(accessToken: string, netFetch: typeof fetch, options?: { signal?: AbortSignal; timeoutMs?: number; google?: Pick<GoogleRequests, "request"> }): Promise<Omit<GmailConnectResult, "refreshToken">>;
  /** hands the token to that account's provider until it expires */
  set(accountId: number, accessToken: string, expiresAt: number): void;
  /** release the removed account's in-memory credential */
  forget?(accountId: number): void;
}

export interface GmailRenewalProof {
  readonly scopeSource: "refresh-response" | "resource-proof";
  readonly grantedScopes?: readonly string[];
  readonly refreshToken: string;
  readonly expiresAt: number;
  /** Uses this forced refresh's access, never a cached or newly consented token. */
  inspect(signal?: AbortSignal): Promise<Omit<GmailConnectResult, "refreshToken">>;
  provePhotos(scopes: readonly string[], signal?: AbortSignal): Promise<string[]>;
}

export interface GmailRenewalOptions {
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

export interface ProviderRegistry {
  /** demo registries never verify anything, so they never establish an owner */
  readonly kind?: "demo";
  /** web: Gmail connects through the page's Google sign-in instead of connectGmail */
  readonly gmailTokens?: GmailTokenBroker;
  create(ctx: ProviderContext): MailProvider;
  verifyImap(config: ImapAccountConfig, password: string): Promise<void>;
  connectGmail(options: { clientId: string; clientSecret: string | null; openExternal: (url: string) => Promise<void>; signal?: AbortSignal; fetch: typeof fetch; google?: Pick<GoogleRequests, "request">; loginHint?: string; scopes?: string[]; allowOmittedRefreshToken?: boolean }): Promise<GmailConnectResult>;
  /** Cold proof is optional: custom registries without it must refuse omitted renewal credentials. */
  beginGmailRenewal?(options: GmailRenewalOptions): Promise<GmailRenewalProof>;
  /** plan 125: withdraw a removed account's Google grant (desktop only: the endpoint has no CORS; absent in test and
   * demo registries, which never try) */
  revokeGoogle?(token: string, netFetch: typeof fetch, signal: AbortSignal): Promise<"revoked" | "failed">;
}

export interface RequestRun { markDispatched(): void; markSubmissionDispatched?(): void }
export interface RequestDescriptor {
  readonly admission?: MailAdmission;
  readonly request: HttpRequestContext;
  readonly run?: RequestRun;
  readonly generation?: number;
  /** Host-owned synchronous status capture; no I/O, throw or await. */
  /** Gmail hands back one bounded-body classification; the ticket stays owned until settlement. */
  readonly onForbidden?: (settle: (kind: "quota" | "policy" | "none", policyError?: ProviderError) => Promise<void>) => void;
  readonly onHeaders?: (status: number, evidence?: HttpResponseEvidence) => void;
}
export interface Observation429 {
  readonly received: HttpReceipt;
  readonly minimum: import("./retry-after-deadline").RetryMinimum;
}
export interface RequestTicket {
  readonly request: HttpRequestContext;
  dispatch(transport: () => Promise<Response>): Promise<Response>;
  headers429(observation: Observation429): Promise<"committed" | "unconfirmed">;
  headers(status: number): void;
  release(): void;
}
export interface ProviderRequests {
  check(descriptor: RequestDescriptor): void;
  reserve(descriptor: RequestDescriptor): RequestTicket;
  accessAvailable(): void;
  tokenUnavailable(): void;
  close(): void;
}

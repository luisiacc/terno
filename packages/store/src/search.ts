import type { ResolvedSearch, ThreadSummary } from "@terno/core";

export type { ResolvedSearch } from "@terno/core";

/** A point in the store's write history: `seq` counts committed batches within one database `epoch`. */
export interface Revision {
  epoch: string;
  seq: number;
}

/**
 * Keyset position in one query's results, (lastDate DESC, id DESC), valid only
 * at the revision it was minted at: after any commit a thread may have moved
 * above it, so continuing would skip it. Engines refuse it (StaleCursorError).
 */
export interface SearchCursor {
  revision: Revision;
  queryKey: string;
  lastDate: number;
  id: number;
}

export interface SearchRequest {
  search: ResolvedSearch;
  cursor?: SearchCursor;
  limit: number;
}

export interface SearchIdsPage {
  /** newest first, (lastDate DESC, id DESC); at most `limit` */
  threadIds: number[];
  nextCursor: SearchCursor | null;
  revision: Revision;
  strategy: string;
}

/**
 * Evaluates message predicates (all on the same message), deduplicates
 * threads, applies every thread predicate, orders and pages. Exact over the
 * locally stored text, for every supported operator.
 */
export interface SearchEngine {
  readonly id: string;
  query(req: SearchRequest, at: Revision): Promise<SearchIdsPage>;
}

/** The message projection an engine indexes: field text exactly as FTS5 sees it. */
export interface SearchMessageDoc {
  messageId: number;
  threadId: number;
  accountId: number;
  date: number;
  subject: string;
  /** "from_name from_email" */
  fromText: string;
  /** normalized address: from:a@b.c matches it exactly */
  fromEmail: string;
  recipients: string;
  body: string;
  hasAttachments: boolean;
  bodyState: "none" | "partial" | "full";
}

export interface SearchThreadDoc {
  threadId: number;
  accountId: number;
  lastDate: number;
  inInbox: boolean;
  hasSent: boolean;
  inTrash: boolean;
  inSpam: boolean;
  isStarred: boolean;
  unreadCount: number;
  categoryIds: readonly number[];
  /** plan 17: the newest inbound message is from a person (absent in a batch served before v14: false) */
  person?: boolean;
  /** plan 17: waiting for your reply since (absent or null: not waiting) */
  waitingSince?: number | null;
}

export type IndexChange =
  | { kind: "upsertMessage"; doc: SearchMessageDoc }
  | { kind: "removeMessage"; messageId: number }
  | { kind: "upsertThread"; doc: SearchThreadDoc }
  | { kind: "removeThread"; threadId: number };

export interface IndexBatch {
  from: Revision;
  to: Revision;
  /**
   * Absolute projections or deletion tombstones of every id the commits in
   * (from, to] touched, read when served: the newest committed state of each
   * id, never older than `to`. A later change to an id always comes with a
   * later batch, so applying batches in order converges on the store.
   */
  changes: readonly IndexChange[];
}

export interface CachedSearchEngine extends SearchEngine {
  status(): {
    revision: Revision | null;
    state: "building" | "ready" | "stale" | "disabled";
    allocatedBytes: number;
  };
  apply(batch: IndexBatch): Promise<void>;
  snapshot(): Promise<Uint8Array>;
  restore(bytes: Uint8Array): Promise<boolean>;
}

export interface SearchBuild {
  /** the log is retained from here until release() */
  from: Revision;
  messages(): AsyncIterable<readonly SearchMessageDoc[]>;
  threads(): AsyncIterable<readonly SearchThreadDoc[]>;
  release(): Promise<void>;
}

export interface SearchFeed {
  head(): Promise<Revision>;
  changes(after: Revision, through: Revision, maxCommits: number): Promise<readonly IndexBatch[]>;
  beginBuild(): Promise<SearchBuild>;
}

export interface StoreSearchPage {
  items: ThreadSummary[];
  nextCursor: SearchCursor | null;
  revision: Revision;
  strategy: string;
  /** the answer is exact for the revision (a fresh FTS5 answer is complete even while RAM warms up) */
  complete: boolean;
  /** messages whose body is not stored yet: what search can't see, independent of `complete` */
  pendingBodies: number;
}

export interface MailStoreSearch {
  search(req: SearchRequest): Promise<StoreSearchPage>;
}

/**
 * The cursor can't continue this answer: another query, another database, or
 * the store moved on since it was minted (results above it may have changed).
 * Callers restart from the top and reconcile what they show.
 */
export class StaleCursorError extends Error {
  constructor(readonly reason: "query" | "epoch" | "revision") {
    super(reason === "query" ? "The search cursor belongs to another query" : reason === "epoch" ? "The search cursor belongs to another database" : "The mailbox changed since this page");
    this.name = "StaleCursorError";
  }
}

/** A newer search from the same client superseded this one before it finished (slow paths stop early). */
export class SearchCancelledError extends Error {
  constructor() {
    super("Superseded by a newer search");
    this.name = "SearchCancelledError";
  }
}

/** The feed can't serve that range: another database (epoch), a pruned log (gap) or a revision not committed yet (ahead). An engine rebuilds. */
export class RevisionError extends Error {
  constructor(
    readonly reason: "epoch" | "gap" | "ahead",
    message: string,
  ) {
    super(message);
    this.name = "RevisionError";
  }
}

export function sameRevision(a: Revision | null | undefined, b: Revision | null | undefined): boolean {
  return !!a && !!b && a.epoch === b.epoch && a.seq === b.seq;
}

/** Cursors minted before revisions existed (older renderers) carry this one. */
export const UNVERSIONED: Revision = { epoch: "unversioned", seq: 0 };

// Plan 259 stage 2a: Outlook's mail over Microsoft Graph, the read side. Every call goes to Graph's v1.0 `/me`, with
// `Prefer: IdType="ImmutableId"` (an id survives a move between folders: learn.microsoft.com/graph/outlook-immutable-id),
// at most four at a time (Outlook's "Four concurrent requests" per app and mailbox: learn.microsoft.com/graph/
// throttling-limits), paced under its 10,000 requests in ten minutes, and redirects refused. Each synced folder keeps a
// delta cursor (learn.microsoft.com/graph/delta-query-messages): a first sync lists the window newest first, then starts
// the folder's delta; `@removed` only says a message left that folder. Bodies are `$value` MIME through the incoming
// pool, as Gmail's are. Writes (flags, moves, folders, send) are stage 2b's, in graph-writes.ts.
import { CAT_OTHER, CAT_PERSONAL, FOLDER_NAME_MAX, FOLDERS_PER_ACCOUNT_MAX, MAX_INCOMING_MIME_BYTES, isValidEmail, type MessageCategory } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { FlagUpdate, IncomingMessage, ProviderFolder } from "@terno/store";
import { createQuotaPacer, type QuotaPacer } from "./gmail-quota";
import { cancelResponse, readResponseText, ResponseBodyLimitError, untilAborted } from "./http-body";
import { captureHttpResponseEvidence } from "./http-response-evidence";
import { readIncomingBody, type IncomingBody } from "./incoming-body";
import { IncomingProcessingError } from "./incoming-processing";
import { retainedIncomingBytes } from "./incoming-size";
import { createMicrosoftSession, MICROSOFT_ENDPOINTS, type MicrosoftEndpoints } from "./microsoft";
import { codesOf, IMMUTABLE, isRecord, mailboxRefusedCodes, ROLES, type Call, type Catalog, type Role, type SyncedFolder } from "./graph-shared";
import { createGraphWrites } from "./graph-writes";
import { parseRaw, type ParsedMessage } from "./mime";
import { failedBeforeRequest, isFetchNetworkFailure, RequestNotDispatchedError } from "./net-errors";
import { throttled } from "./provider-http";
import { deadlineSignal, download, inlineCandidate, IncomingCaptureRefusal, IncomingResourceError, MESSAGE_FAILURES, NEVER, processingError, READ_TIMEOUT_MS, SEND_TIMEOUT_MS, type Held, type RequestDeadline } from "./rest-provider";
import { resolveRetryMinimum, type RetryMinimum } from "./retry-after-deadline";
import { BACKFILL_CHUNK_MS, ProviderAuthError, ProviderError, type BoundedHttpHeader, type HttpReceipt, type HttpRequestContext, type HttpResponseEvidence, type MailAdmission, type MailProvider, type Observation429, type ProviderContext, type ProviderHit, type ProviderOp, type ProviderQuery, type RequestRun, type SendPayload, type SyncSink } from "./types";

/** Outlook's limit per app and mailbox (learn.microsoft.com/graph/throttling-limits, "Outlook service limits") */
export const GRAPH_CONCURRENCY = 4;
/** 10,000 requests in ten minutes per app and mailbox: 15 a second plus a burst of 900 stays under it */
export const GRAPH_REQUESTS_PER_SECOND = 15;
const GRAPH_BURST = 900;
/** `Prefer: odata.maxpagesize` for listings and delta pages */
export const GRAPH_PAGE = 100;
/** a page of 100 envelopes is tens of kilobytes; a folder page as much */
const PAGE_BYTES = 2 * 1024 * 1024;
const SMALL_BYTES = 65_536;
/** a nextLink or deltaLink is opaque: kept whole, within a bound */
const LINK_MAX = 16_384;
const ID_MAX = 1024;
/** a pass's share of a first sync's listings; then another pass (Inbox first again) */
export const FIRST_SYNC_CHUNK_MS = 60_000;
/** new mail is what was received after the last round ended, less this (Graph's clock and this one's) */
const LIVE_MARGIN_MS = 10 * 60_000;
/** the most of those remembered (then forgotten all at once) */
const OUTSIDE_MAX = 10_000;
/** a pass reads at most this many pages of one folder's delta; then another pass */
export const DELTA_PAGES_PER_PASS = 100;
/** the folder list again at most this often (Graph has no change feed we use for it) */
export const CATALOG_EVERY_MS = 15 * 60_000;
/** a user folder's delta at most this often (role folders every pass, the Inbox in every quick check) */
export const USER_FOLDERS_EVERY_MS = 5 * 60_000;
/** a pass's share of flag snapshots and of a reconciliation's reads */
export const FLAG_SNAPSHOTS_MS = 30_000;
/** "A `$search` request returns up to 1,000 results" (learn.microsoft.com/graph/search-query-parameter) */
const SEARCH_MAX = 1000;
/** what an envelope read selects: all a sync needs to place and flag a message */
const SELECT = "id,receivedDateTime,isRead,isDraft,flag,parentFolderId,inferenceClassification";
/**
 * Plan 275 (Codex critique #2): what SELECT asks for, as a number. Graph keeps a delta link's `$select`, so a cursor
 * saved under an older one has every folder's round started again (its window listed, nothing downloaded again).
 */
const PROJECTION = 1;
const MAIL: HttpRequestContext = { endpoint: "graph-api", purpose: "mail" };
const IDENTITY: HttpRequestContext = { endpoint: "microsoft-identity", purpose: "identity-proof" };

/** folders that hold no mail of the person's: never synced, nor anything under them */
const EXCLUDED = ["outbox", "conversationhistory", "syncissues"];

const enc = encodeURIComponent;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = () => new ProviderError(L("errors.outlook.invalidResponse"), true);
const offline = () => L("errors.outlook.requestOffline");

/** Graph refused a request: its status, and Graph's codes (error.code and the nested innererror codes). */
export class GraphApiError extends ProviderError {
  constructor(readonly target: string, readonly status: number, readonly codes: readonly string[], retryable: boolean, httpResponse?: HttpResponseEvidence, ambiguous = false) {
    super(L("errors.outlook.requestFailed", { status }), retryable && !ambiguous, ambiguous, false, httpResponse);
  }
}

/** a pause's end, comparable: none (no Retry-After) waits least */
const pauseEnd = (m: RetryMinimum) => m.kind === "at" ? m.atMs : m.kind === "hold" ? Number.MAX_SAFE_INTEGER : -1;

/**
 * Plan 259 stage 2b: the longest wait a JSON batch's throttled requests ask for ("if any request exceeds the limits, it
 * fails with a status of 429": learn.microsoft.com/graph/json-batching), read as a top-level 429's headers are. A
 * Retry-After inside a sub-response isn't promised by the page: without one the pause is the ledger's own.
 */
export function batchThrottle(value: unknown, now = Date.now()): Observation429 | undefined {
  if (!isRecord(value) || !Array.isArray(value.responses)) return;
  const received: HttpReceipt = { source: "date-now", kind: "wall", wallMs: now };
  let found: Observation429 | undefined;
  for (const r of value.responses) {
    if (!isRecord(r) || typeof r.status !== "number") continue;
    const header = isRecord(r.headers) ? Object.entries(r.headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1] : undefined;
    const retryAfter: BoundedHttpHeader = header === undefined ? { kind: "not-visible" } : typeof header === "string" && header.length <= 256 ? { kind: "value", value: header } : { kind: "too-long" };
    if (!throttled(MAIL, r.status, retryAfter.kind === "value")) continue;
    const minimum = resolveRetryMinimum({ received, retryAfter, serverDate: { kind: "not-visible" } });
    if (!found || pauseEnd(minimum) > pauseEnd(found.minimum)) found = { received, minimum };
  }
  return found;
}

/** A delta link Graph no longer takes: `410 Gone` or a `syncStateNotFound` (learn.microsoft.com/graph/delta-query-overview). */
class DeltaExpired extends ProviderError {
  constructor() { super(L("errors.outlook.requestFailed", { status: 410 }), true); }
}

class ProofTokenExpired extends Error {}

/** Graph's error codes in an answer's text (an unreadable body says only its status). */
function graphCodes(text: string): string[] {
  try { return codesOf(JSON.parse(text)); } catch { return []; }
}

const mailboxRefused = (error: GraphApiError) => mailboxRefusedCodes(error.codes);

/**
 * What a 404 on this very request says isn't there (a message, a folder): Graph's own error code read, and not the
 * mailbox's (Codex code review #3). An unreadable body proves nothing, and nothing is removed for it (round 2 #3).
 */
/** plan 275: Outlook's classification as a message category (Primary for Focused, Other) */
const categoryOfInference = (inference: "focused" | "other"): MessageCategory => (inference === "other" ? CAT_OTHER : CAT_PERSONAL);

/** One folder Graph won't open for this mailbox (a 403 that isn't the mailbox's, nor a throttle): that folder's alone. */
const folderRefused = (error: unknown): error is GraphApiError => error instanceof GraphApiError && error.target.includes("/mailFolders/") && error.status >= 400 && error.status < 500 && error.status !== 404 && !error.retryable && !mailboxRefused(error);

/**
 * Graph refusing one message's content (a 4xx on its own `$value` that isn't a throttle, a 404 or the mailbox's):
 * that message's repair (review round 4: it held its folder's place, the Inbox's too, on every pass)
 */
const messageRefused = (error: unknown, target: string): error is GraphApiError => error instanceof GraphApiError && error.target === target && error.status >= 400 && error.status < 500 && error.status !== 404 && !error.retryable && !mailboxRefused(error);

/** plan 272: a source is copied this many incoming chunks (1 MiB each at most) between yields */
const ORIGINAL_COPY_CHUNKS = 4;

const notFound = (error: unknown, target: string) => error instanceof GraphApiError && error.status === 404 && error.target === target && error.codes.length > 0 && !mailboxRefused(error);

/** A folder's own listing or delta answered that the folder isn't there (round 2 #5: classified where it's asked). */
class FolderGone extends Error {}

/** An envelope as a listing, a delta page or a targeted read gives it. Absent fields weren't said (a delta update). */
interface Envelope {
  id: string;
  removed?: true;
  received?: number;
  isRead?: boolean;
  isDraft?: boolean;
  flagged?: boolean;
  parent?: string;
  /** a search's exact-address check (review of the reliability checklist, B36): the sender's and recipients' addresses, lower case */
  from?: string;
  recipients?: string[];
  /** plan 275: Focused Inbox's classification, only when Graph sent it (a sparse update never invents one) */
  inference?: "focused" | "other";
}

function readEnvelope(value: unknown): Envelope {
  if (!isRecord(value) || !nonempty(value.id) || value.id.length > ID_MAX) throw invalid();
  if (value["@removed"] !== undefined) {
    if (!isRecord(value["@removed"])) throw invalid();
    return { id: value.id, removed: true };
  }
  const out: Envelope = { id: value.id };
  if (value.receivedDateTime !== undefined && value.receivedDateTime !== null) {
    const at = typeof value.receivedDateTime === "string" ? Date.parse(value.receivedDateTime) : NaN;
    if (!Number.isFinite(at)) throw invalid();
    out.received = at;
  }
  for (const key of ["isRead", "isDraft"] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    if (typeof value[key] !== "boolean") throw invalid();
    out[key] = value[key];
  }
  if (value.flag !== undefined && value.flag !== null) {
    if (!isRecord(value.flag) || (value.flag.flagStatus !== undefined && typeof value.flag.flagStatus !== "string")) throw invalid();
    if (typeof value.flag.flagStatus === "string") out.flagged = value.flag.flagStatus === "flagged";
  }
  if (value.parentFolderId !== undefined && value.parentFolderId !== null) {
    if (!nonempty(value.parentFolderId) || value.parentFolderId.length > ID_MAX) throw invalid();
    out.parent = value.parentFolderId;
  }
  if (value.inferenceClassification !== undefined && value.inferenceClassification !== null) {
    if (typeof value.inferenceClassification !== "string") throw invalid();
    // a value Graph adds later is read as Focused: shown, the safe side
    out.inference = value.inferenceClassification.toLowerCase() === "other" ? "other" : "focused";
  }
  // only what a request selected: an address is { emailAddress: { address } }, a recipient list an array of them
  const address = (v: unknown) => isRecord(v) && isRecord(v.emailAddress) && typeof v.emailAddress.address === "string" ? v.emailAddress.address.trim().toLowerCase() : undefined;
  if (value.from !== undefined && value.from !== null) out.from = address(value.from) ?? "";
  for (const key of ["toRecipients", "ccRecipients", "bccRecipients"] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!Array.isArray(value[key]) || (value[key] as unknown[]).length > 1000) throw invalid();
    (out.recipients ??= []).push(...(value[key] as unknown[]).flatMap((r) => { const a = address(r); return a ? [a] : []; }));
  }
  return out;
}

interface Page { items: Envelope[]; next?: string; delta?: string }

/** A collection page: `value`, and at most one of `@odata.nextLink` and `@odata.deltaLink` (never both). */
function readPage(value: unknown): Page {
  if (!isRecord(value) || !Array.isArray(value.value) || value.value.length > 1000) throw invalid();
  const next = value["@odata.nextLink"], delta = value["@odata.deltaLink"];
  if ((next !== undefined && (!nonempty(next) || next.length > LINK_MAX)) || (delta !== undefined && (!nonempty(delta) || delta.length > LINK_MAX)) || (next !== undefined && delta !== undefined)) throw invalid();
  // a delta may name an entity more than once, and an update carries only what changed (learn.microsoft.com/graph/
  // delta-query-overview): a later entry adds to an earlier one's fields (Codex code review #2); a removal ends it
  const items = new Map<string, Envelope>();
  for (const raw of value.value) {
    const item = readEnvelope(raw);
    const was = items.get(item.id);
    items.delete(item.id);
    items.set(item.id, was && !was.removed && !item.removed ? { ...was, ...item } : item);
  }
  return { items: [...items.values()], ...(next !== undefined && { next: next as string }), ...(delta !== undefined && { delta: delta as string }) };
}

/**
 * A folder's place. `after`: where its delta's window starts. `delta`: the link to read next (absent: its first round,
 * from the window's filter). `initial`: still that first round. `round`: when the round under way began. `list`: the
 * window listed after the first round (`next` its page). `at`: when the last finished round began (new mail is what was
 * received after it). `startedAt`: when this folder's first round began.
 */
interface FolderState { after: number; startedAt: number; delta?: string; initial?: true; round?: number; list?: { next?: string }; at?: number }
interface BackfillProgress { since: number; until: number; next?: string }
interface Cursor {
  v: 1;
  folders: Record<string, FolderState>;
  /** plan 275: the PROJECTION the folders' links were made with (absent: 0, before Focused Inbox) */
  projection?: number;
  /**
   * The reconciliation: every stored message read again by id, past `after` (the store's page key); `again`: asked
   * for again while it ran (it starts over once it ends, never from the top mid-way: round 2 #4)
   */
  refresh?: { after?: string; again?: true };
  /**
   * Folders of the person's own no longer synced (deleted, moved where Terno doesn't sync): what Terno stored in each is
   * read again by id, a folder at a time past `after` (a message id), never the whole account (review round 3)
   */
  left?: { folders: string[]; after?: number };
  backfill?: BackfillProgress;
}

interface Pass extends SyncSink {
  check(): void;
  held: Held;
  /** where this pass saw each message (a delta or a read placed it): a later `@removed` elsewhere needs no read */
  seen: Map<string, string>;
  /** the folder a message is in, as Terno syncs it (one list refresh a pass at most: round 2 #6) */
  place?(parent: string | undefined): Promise<SyncedFolder | undefined>;
}

interface Wanted { envelope: Envelope; folder: SyncedFolder; quiet?: true }
/** a stored draft to read again whole (`local`: its row) */
interface Redraft { local: number; wanted: Wanted }

export interface GraphTokenSource {
  get(run?: RequestRun, admission?: MailAdmission): Promise<string>;
  invalidate(token: string): void;
}

export interface GraphApiOptions {
  endpoints?: Partial<MicrosoftEndpoints>;
  tokens: GraphTokenSource;
  /** requests a second (default Outlook's limit, GRAPH_REQUESTS_PER_SECOND); synthetic servers lift it */
  requestsPerSecond?: number;
  /** tests only */
  quota?: QuotaPacer;
  readTimeoutMs?: number;
  pageSize?: number;
  /** tests only: how often a user folder's delta is read (USER_FOLDERS_EVERY_MS) */
  userFoldersEveryMs?: number;
  /** stage 2b: the MIME a send carries (desktop: nodemailer's, Bcc kept: Graph reads a MIME message's headers) */
  buildRaw?: (payload: SendPayload) => Promise<Uint8Array>;
  /** tests only: a send's deadline (SEND_TIMEOUT_MS) */
  sendTimeoutMs?: number;
  /** tests only: Graph's write limit, over which a send goes through a draft (WRITE_MAX_BYTES) */
  writeMaxBytes?: number;
  /** tests only: an upload session's piece */
  uploadPieceBytes?: number;
}

interface IncomingResource { parsed: ParsedMessage; bytes: number; promoted: boolean; release(): void }

/**
 * At most `width` requests at once, in the order asked; a waiter that's aborted leaves the queue. A JSON batch takes as
 * many as Graph runs of it at once (stage 2b, Codex code review #10), all together, so two never deadlock.
 */
function createSlots(width: number) {
  let active = 0;
  const waiting: { n: number; go(): void }[] = [];
  const admit = () => {
    while (waiting.length && active + waiting[0]!.n <= width) {
      const next = waiting.shift()!;
      active += next.n;
      next.go();
    }
  };
  return {
    get active() { return active; },
    async acquire(signal?: AbortSignal, n = 1): Promise<() => void> {
      signal?.throwIfAborted();
      if (!waiting.length && active + n <= width) active += n;
      else await new Promise<void>((resolve, reject) => {
        const waiter = { n, go: () => { signal?.removeEventListener("abort", abort); resolve(); } };
        const abort = () => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) waiting.splice(at, 1);
          admit();
          reject(signal!.reason);
        };
        waiting.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
      let released = false;
      return () => { if (!released) { released = true; active -= n; admit(); } };
    },
  };
}

/** The first `max` bytes of a body, the rest cancelled: over the capture policy, the worker reads its headers only. */
/** A response cut at `max` bytes (exported for its test) */
export function truncated(response: Response, max: number): Response {
  const reader = response.body?.getReader();
  if (!reader) return response;
  let seen = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) { reader.releaseLock(); controller.close(); return; }
      const room = max - seen;
      if (next.value.byteLength < room) { seen += next.value.byteLength; controller.enqueue(next.value); return; }
      controller.enqueue(next.value.subarray(0, room));
      seen = max;
      // the rest is cancelled before the reader sees the end, so what's freed at the end (a Graph slot) is free
      // (plan 272's code review #3)
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      controller.close();
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}

/** A search box query as KQL: words only (anything else is a space), each property's words restricted to it. */
export function graphSearch(query: ProviderQuery): string {
  const words = (value: string) => value.normalize("NFC").replace(/[^\p{L}\p{N}@._+-]+/gu, " ").trim().split(/\s+/).filter(Boolean).filter((w) => !/^(AND|OR|NOT|NEAR)$/.test(w));
  const parts: string[] = [];
  for (const term of query.terms) parts.push(...words(term));
  for (const group of query.anyOf ?? []) {
    const any = group.flatMap((term) => { const w = words(term); return w.length ? [w.join(" ")] : []; });
    if (any.length) parts.push(any.length === 1 ? any[0]! : `(${any.map((a) => a.includes(" ") ? `(${a})` : a).join(" OR ")})`);
  }
  // a recipient is To, Cc or Bcc (`recipients:`, learn.microsoft.com/graph/search-query-parameter), as Terno's own search
  // reads one (code review #10: `to:` missed copied mail)
  for (const [property, value] of [["from", query.from], ["recipients", query.to], ["subject", query.subject]] as const) if (value) parts.push(...words(value).map((w) => `${property}:${w}`));
  if (query.hasAttachment) parts.push("hasAttachments:true");
  return parts.join(" ");
}

export function createGraphApiProvider(ctx: ProviderContext, options: GraphApiOptions): MailProvider {
  const ep = { ...MICROSOFT_ENDPOINTS, ...options.endpoints };
  const graphBase = new URL(ep.graph);
  const netFetch = ctx.fetch;
  const store = ctx.store;
  const accountId = ctx.account.id;
  const tokens = options.tokens;
  const pageSize = options.pageSize ?? GRAPH_PAGE;
  const readTimeout = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const quota = options.quota ?? createQuotaPacer({ perSecond: options.requestsPerSecond ?? GRAPH_REQUESTS_PER_SECOND, burst: GRAPH_BURST });
  const slots = createSlots(GRAPH_CONCURRENCY);
  const yieldPage = () => ctx.yield?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** reads in flight listen here: reset() aborts them all at once */
  let reads = new AbortController();
  /** stage 2b: drafts a send is building (graph-writes.ts); a sync stores none of them */
  const staging = new Set<string>();

  /** A path under Graph's root, or a link Graph handed back: only ever to Graph's own root (privacy: plan 97). */
  function resolve(target: string): string {
    // both as the URL parser normalizes them (a `%2e%2e` segment climbs out of a prefix): Codex code review #8
    let url: URL;
    try { url = new URL(target.startsWith("/") ? `${ep.graph}${target}` : target); } catch { throw invalid(); }
    if (target.length > LINK_MAX || url.origin !== graphBase.origin || !url.pathname.startsWith(`${graphBase.pathname.replace(/\/$/, "")}/`) || url.username || url.password) throw invalid();
    return url.href;
  }

  async function refused(generation: number | undefined, evidence?: HttpResponseEvidence): Promise<ProviderAuthError> {
    const error = new ProviderAuthError(L("errors.microsoft.revoked"), evidence);
    await ctx.tokenResult?.(generation ?? 0, error);
    return error;
  }

  /** Whose mailbox the token opens: Graph's `mail`, else the user principal name, as the sign-in read it. */
  async function mailbox(call: Call): Promise<string> {
    const me = await api("/me?$select=mail,userPrincipalName", { ...call, context: IDENTITY, limit: SMALL_BYTES });
    const email = isRecord(me) && nonempty(me.mail) ? me.mail : isRecord(me) ? me.userPrincipalName : undefined;
    if (typeof email !== "string" || email.length > 254 || !isValidEmail(email) || /[\s\p{Cc}]/u.test(email)) throw invalid();
    return email;
  }

  async function incomingResponse(response: Response, deadline: RequestDeadline, call: Call, free: () => void): Promise<IncomingResource> {
    let body: IncomingBody | undefined;
    try {
      body = await readIncomingBody(truncated(response, MAX_INCOMING_MIME_BYTES + 1), {
        signal: deadline.signal, limit: MAX_INCOMING_MIME_BYTES + 1,
        async promote(signal) {
          const resume = deadline.pause();
          try {
            if (!ctx.incoming?.promote) throw new IncomingProcessingError("worker-unavailable");
            return await ctx.incoming.promote(accountId, signal, undefined, call.admission);
          } finally { resume(); }
        },
      });
      free();
      deadline.stopClock();
      call.preparation?.throwIfAborted();
      if (body.bytes <= SMALL_BYTES && body.chunks.length <= 1 && inlineCandidate(body.chunks[0] ?? new Uint8Array(0))) {
        deadline.signal.throwIfAborted();
        return { parsed: await parseRaw(body.chunks[0] ?? new Uint8Array(0)), bytes: body.bytes, promoted: false, release: body.release };
      }
      await body.promote();
      call.preparation?.throwIfAborted();
      if (!ctx.incomingProcessor) throw new IncomingProcessingError("worker-unavailable");
      const result = await ctx.incomingProcessor.run({ kind: "mime", bodyFormat: "parts", chunks: body.chunks }, deadline.signal);
      if (result.kind !== "mime") throw new IncomingProcessingError("worker-fault");
      return { parsed: result.message, bytes: body.bytes, promoted: true, release: body.release };
    } catch (error) { body?.release(); throw error; }
  }

  /**
   * Plan 272: a message's source for Show original, as its bytes: bounded as incoming mail is (one over the cap is a
   * message too large, never a malformed answer), the large-read permit past the first 256 KB, nothing parsed.
   */
  async function originalResponse(response: Response, deadline: RequestDeadline, call: Call, free: () => void): Promise<Uint8Array> {
    const body = await readIncomingBody(truncated(response, MAX_INCOMING_MIME_BYTES + 1), {
      signal: deadline.signal, limit: MAX_INCOMING_MIME_BYTES + 1,
      async promote(signal) {
        const resume = deadline.pause();
        try {
          if (!ctx.incoming?.promote) return () => {};
          return await ctx.incoming.promote(accountId, signal, undefined, call.admission);
        } finally { resume(); }
      },
    });
    try {
      free();
      deadline.stopClock();
      call.preparation?.throwIfAborted();
      if (body.bytes > MAX_INCOMING_MIME_BYTES) throw new ProviderError(L("errors.mail.processingLimit"), false);
      // a 200 with nothing in it is no message's source (plan 272's code review #5)
      if (body.bytes === 0) throw new ProviderError(L("errors.original.unreadable"), true);
      // copied a few chunks at a time, yielding between them: up to 75 MB never holds the backend in one slice, and a
      // closed view stops it (code review #4)
      const bytes = new Uint8Array(body.bytes);
      let at = 0;
      for (let i = 0; i < body.chunks.length; i++) {
        const chunk = body.chunks[i]!;
        bytes.set(chunk, at);
        at += chunk.byteLength;
        if (i % ORIGINAL_COPY_CHUNKS === ORIGINAL_COPY_CHUNKS - 1) {
          await yieldPage();
          deadline.signal.throwIfAborted();
          call.preparation?.throwIfAborted();
        }
      }
      return bytes;
    } finally { body.release(); }
  }

  const RETRY = Symbol("retry");

  /** One Graph request; a 401 is tried once more with a fresh token. */
  async function api(target: string, call: Call & { mime: true }): Promise<IncomingResource>;
  async function api(target: string, call: Call & { original: true }): Promise<Uint8Array>;
  async function api(target: string, call?: Call): Promise<unknown>;
  async function api(target: string, call: Call & { mime?: true } = {}): Promise<unknown> {
    for (let retried = false; ; retried = true) {
      const result = await attempt(target, call, retried);
      if (result !== RETRY) return result;
    }
  }

  async function attempt(target: string, call: Call & { mime?: true }, retried: boolean): Promise<unknown> {
    const context = call.context ?? MAIL;
    ctx.requests?.check(context, call.admission);
    const generation = call.generation ?? ctx.requests?.generation();
    const waitOn = call.preparation ?? call.signal;
    waitOn?.throwIfAborted();
    const token = call.proofToken ?? (waitOn ? await untilAborted(tokens.get(call.run, call.admission), waitOn) : await tokens.get(call.run, call.admission));
    if (ctx.requests && !call.proofToken) {
      try {
        // a proof another request started is shared: this caller stops waiting when it's cancelled (a closed Show
        // original gives back its read permit at once), and the proof goes on for the rest (plan 272's code review #1)
        const proof = ctx.requests.prove(() => mailbox({ signal: call.signal, readReset: call.readReset, preparation: call.preparation, admission: call.admission, proofToken: token, proofFinal: retried, generation }), call.admission);
        await (waitOn ? untilAborted(proof, waitOn) : proof);
      } catch (error) {
        if (error instanceof ProofTokenExpired && !retried) return RETRY;
        throw error;
      }
    }
    const url = resolve(target);
    // Outlook's own pace and its four at once: what's queued leaves only for a pass still going; a send the person
    // asked for counts but never waits on the pace
    const requests = Math.max(1, call.batch ?? 1);
    if (call.submission) quota.charge(1);
    else if (!quota.unpaced) await quota.spend(requests, waitOn);
    const release = await slots.acquire(waitOn, Math.min(GRAPH_CONCURRENCY, requests));
    let holding = true;
    const free = () => { if (holding) { holding = false; release(); } };
    const sending = call.submission === true;
    // a send isn't cut by a network change and has a send's deadline; anything else is safe to repeat
    // a send's other steps (its draft, its files, its mark) carry up to 4 MB each: a send's time, not a read's (review round 4)
    const deadline = deadlineSignal(sending ? NEVER : (call.readReset ?? reads.signal), call.signal, sending || call.admission === "send" ? (options.sendTimeoutMs ?? SEND_TIMEOUT_MS) : readTimeout);
    const failed = (error: unknown) => {
      if (error instanceof RequestNotDispatchedError) return error;
      // a send that never connected never left (it waits for the network); one that may have left is unknown (plan 65)
      if (sending) return failedBeforeRequest(error) ? ProviderError.network(offline()) : new ProviderError(offline(), false, true);
      return isFetchNetworkFailure(error) ? ProviderError.network(offline()) : new ProviderError(offline(), true);
    };
    let settleBatch: ((throttled?: Observation429) => Promise<void>) | undefined;
    try {
      let response: Response;
      let evidence: HttpResponseEvidence | undefined;
      try {
        deadline.signal.throwIfAborted();
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, prefer: call.page ? `${IMMUTABLE}, odata.maxpagesize=${pageSize}` : IMMUTABLE };
        if (call.body !== undefined) headers["content-type"] = call.contentType ?? "application/json";
        const init: RequestInit = { method: call.method ?? "GET", redirect: "error", signal: deadline.signal, headers, ...(call.body !== undefined && { body: call.body }) };
        // the submission marks itself as the boundary: past it, the message may have gone
        const run = sending && call.run ? { markDispatched() { call.run!.markDispatched(); call.run!.markSubmissionDispatched?.(); } } : call.run;
        const sent = ctx.requests ? ctx.requests.request({
          request: context, admission: call.admission, generation, ...(run && { run }),
          ...(call.batch && { onBatch: (settle: (throttled?: Observation429) => Promise<void>) => { if (deadline.signal.aborted) void settle(); else settleBatch = settle; } }),
          onHeaders: (_status, observed) => { evidence = observed; },
        }, url, init) : netFetch(url, init);
        response = await untilAborted(sent.then((r) => {
          if (deadline.signal.aborted) { cancelResponse(r); throw deadline.signal.reason; }
          if (!r.ok && !evidence) evidence = captureHttpResponseEvidence(r, context, Date.now());
          return r;
        }), deadline.signal);
      } catch (error) { throw failed(error); }
      if (response.status === 401) {
        // the slot is the mailbox's until this answer is over (Codex code review #11): a bounded read, then the retry
        await readResponseText(response, SMALL_BYTES, deadline.signal).catch(() => "");
        free();
        tokens.invalidate(token);
        if (call.proofToken) throw call.proofFinal ? await refused(generation, evidence) : new ProofTokenExpired();
        if (retried) throw await refused(generation, evidence);
        return RETRY;
      }
      if (!response.ok) {
        const text = await readResponseText(response, SMALL_BYTES, deadline.signal).catch(() => "");
        free();
        const codes = graphCodes(text);
        // learn.microsoft.com/graph/delta-query-overview: "410 Gone", or "a 40X-series error with error codes such as syncStateNotFound"
        if (call.delta && (response.status === 410 || (response.status >= 400 && response.status < 500 && codes.some((c) => c.toLowerCase() === "syncstatenotfound")))) throw new DeltaExpired();
        // a send Graph failed with a server error may still have gone: unknown, never sent again (plan 65)
        throw new GraphApiError(target, response.status, codes, response.status === 429 || response.status >= 500, evidence, sending && response.status >= 500);
      }
      if (call.original) {
        try { return await originalResponse(response, deadline, call, free); }
        catch (error) {
          // the message's own size, against the cap; any other bound (one piece of the answer too large) and an answer
          // without a body are an unreadable answer, never "too large" nor "offline" (code review #2, #5)
          if (error instanceof ResponseBodyLimitError) throw new ProviderError(L(error.limit === MAX_INCOMING_MIME_BYTES + 1 ? "errors.mail.processingLimit" : "errors.original.unreadable"), error.limit !== MAX_INCOMING_MIME_BYTES + 1);
          if (error instanceof SyntaxError) throw new ProviderError(L("errors.original.unreadable"), true);
          if (error instanceof ProviderError || error instanceof RequestNotDispatchedError) throw error;
          throw failed(error);
        }
      }
      if (call.mime) {
        try { return await incomingResponse(response, deadline, call, free); }
        catch (error) {
          if (error instanceof IncomingProcessingError || error instanceof ResponseBodyLimitError) throw processingError(error, invalid);
          if (error instanceof ProviderError || error instanceof RequestNotDispatchedError) throw error;
          throw failed(error);
        }
      }
      if (call.empty) {
        // 202 Accepted / 204 No Content: the status is the answer (a body that doesn't end changes nothing)
        await readResponseText(response, SMALL_BYTES, deadline.signal).catch(() => "");
        free();
        return undefined;
      }
      let text: string;
      try { text = await readResponseText(response, call.limit ?? PAGE_BYTES, deadline.signal, yieldPage); }
      catch (error) {
        // accepted, and its answer unreadable: a send's outcome is still the status's (a draft path step is retried)
        if (error instanceof ResponseBodyLimitError) throw invalid();
        if (!deadline.signal.aborted && !isFetchNetworkFailure(error)) throw invalid();
        throw failed(error);
      }
      free();
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { throw invalid(); }
      // a request inside the batch refused its token (revoked before its expiry): the retry asks for a new one, as a 401
      // on the batch itself would
      if (call.batch && isRecord(value) && Array.isArray(value.responses) && value.responses.some((r) => isRecord(r) && r.status === 401)) tokens.invalidate(token);
      if (settleBatch) {
        const settle = settleBatch;
        settleBatch = undefined;
        await settle(batchThrottle(value));
      }
      return value;
    } finally {
      if (settleBatch) await settleBatch().catch(() => {});
      deadline.done();
      free();
    }
  }


  // ───────────────────────────── folders ─────────────────────────────

  let catalog: Catalog | null = null;
  /** every role folder's id a list has named (ids never change): a folder that stops being synced is told apart by it */
  const roleFolders = new Set<string>();

  /** One collection, every page (bounded), each item's raw record. */
  async function collection(first: string, signal: AbortSignal | undefined, limit: number): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (let next: string | undefined = first; next !== undefined;) {
      const value = await api(next, { signal, preparation: signal, page: true });
      if (!isRecord(value) || !Array.isArray(value.value) || value.value.length > 1000) throw invalid();
      for (const item of value.value) { if (!isRecord(item)) throw invalid(); out.push(item); }
      const link = value["@odata.nextLink"];
      if (link !== undefined && (!nonempty(link) || link.length > LINK_MAX || seen.has(link))) throw invalid();
      next = link as string | undefined;
      if (next) seen.add(next);
      // bounded: what's past it is never walked
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * The person's folders: the roles by their well-known names (locale-independent, learn.microsoft.com/graph/api/
   * resources/mailfolder; one that isn't there is a 404), and every folder from the top, its children read where it says
   * it has some. A search folder isn't one (its mail lives elsewhere), nor the Outbox, Conversation History or Sync Issues.
   */
  async function readCatalog(sink: Pick<SyncSink, "setFolders" | "signal">): Promise<Catalog> {
    const signal = sink.signal;
    const known = new Map<string, string>();
    await download([...Object.values(ROLES), ...EXCLUDED], async (name) => {
      try {
        const folder = await api(`/me/mailFolders/${name}?$select=id`, { signal, preparation: signal, limit: SMALL_BYTES });
        if (!isRecord(folder) || !nonempty(folder.id) || folder.id.length > ID_MAX) throw invalid();
        known.set(name, folder.id);
      } catch (error) {
        if (!notFound(error, `/me/mailFolders/${name}?$select=id`)) throw error;
      }
    }, GRAPH_CONCURRENCY);
    const byRole: Partial<Record<Role, string>> = {};
    for (const [role, name] of Object.entries(ROLES) as [Role, string][]) if (known.has(name)) byRole[role] = known.get(name)!;
    const roleOf = new Map(Object.entries(byRole).map(([role, id]) => [id, role as Role]));
    for (const id of roleOf.keys()) roleFolders.add(id);
    const excluded = new Set(EXCLUDED.flatMap((name) => known.has(name) ? [known.get(name)!] : []));
    const limit = FOLDERS_PER_ACCOUNT_MAX + 100;
    const query = `$top=${pageSize}&$select=id,displayName,parentFolderId,childFolderCount`;
    interface Node { id: string; name: string; parent: string | null; depth: number }
    const nodes = new Map<string, Node>();
    let level: Node[] = [];
    const take = (items: Record<string, unknown>[], parent: string | null, depth: number) => {
      for (const item of items) {
        if (nodes.size >= limit) return;
        if (!nonempty(item.id) || item.id.length > ID_MAX || typeof item.displayName !== "string" || (item.childFolderCount !== undefined && typeof item.childFolderCount !== "number")) throw invalid();
        if (item["@odata.type"] === "#microsoft.graph.mailSearchFolder" || excluded.has(item.id) || nodes.has(item.id)) continue;
        const node = { id: item.id, name: item.displayName, parent, depth };
        nodes.set(item.id, node);
        if (typeof item.childFolderCount === "number" && item.childFolderCount > 0) level.push(node);
      }
    };
    take(await collection(`/me/mailFolders?${query}`, signal, limit), null, 0);
    while (level.length && nodes.size < limit) {
      const parents = level.filter((node) => node.depth < 64);
      level = [];
      // read four at once, taken in the parents' order: the same folders make the same list, near the cap too (round 2 #11)
      const children = new Map<string, Record<string, unknown>[]>();
      await download(parents, async (parent) => {
        try { children.set(parent.id, await collection(`/me/mailFolders/${enc(parent.id)}/childFolders?${query}`, signal, limit)); }
        // gone, or one Graph won't open (403: a folder shared to the mailbox without access, review round 4): its
        // children aren't listed, and the rest of the list, and the Inbox after it, still are
        catch (error) { if (!notFound(error, `/me/mailFolders/${enc(parent.id)}/childFolders?${query}`) && !folderRefused(error)) throw error; }
      }, GRAPH_CONCURRENCY);
      for (const parent of parents) take(children.get(parent.id) ?? [], parent.id, parent.depth + 1);
    }
    const synced = new Map<string, SyncedFolder>();
    for (const [id, role] of roleOf) synced.set(id, { id, role });
    const folders: ProviderFolder[] = [];
    for (const node of nodes.values()) {
      if (roleOf.has(node.id)) continue;
      // the names from the top; a folder under the Inbox shows at the top, as IMAP's INBOX children do
      const path: string[] = [];
      let ok = true;
      for (let at: Node | undefined = node; at; at = at.parent === null ? undefined : nodes.get(at.parent)) {
        const above = at !== node ? roleOf.get(at.id) : undefined;
        if (above === "inbox") break;
        // inside Deleted Items or Junk Email (a folder deleted in Outlook lands in Deleted Items): its mail is deleted or
        // junk, never the person's live mail, so it's neither listed nor synced, as Outbox isn't (review round 3)
        if (above === "trash" || above === "junk") { ok = false; break; }
        const name = at.name.trim().slice(0, FOLDER_NAME_MAX);
        if (!name) { ok = false; break; }
        path.unshift(name);
        if (path.length > 64) { ok = false; break; }
      }
      if (!ok) continue;
      // the folders synced are the ones listed, within the account's cap (Codex code review #9)
      if (folders.length >= FOLDERS_PER_ACCOUNT_MAX) break;
      synced.set(node.id, { id: node.id });
      folders.push({ key: node.id, path, selectable: true });
    }
    const tree = new Map([...nodes.values()].map((node) => [node.id, { name: node.name, parent: node.parent }]));
    // the cache moves only once the list is stored (a failed write reads it again next pass); one read without storing it
    // (a folder change's) is used, but never counts as fresh: the next pass reads and stores the list
    const next: Catalog = { at: sink.setFolders ? Date.now() : 0, byRole, synced, folders, tree };
    await sink.setFolders?.(next.folders);
    catalog = next;
    return next;
  }

  async function ensureCatalog(sink: Pick<SyncSink, "setFolders" | "signal">, force = false): Promise<Catalog> {
    if (catalog && !force && Date.now() - catalog.at < CATALOG_EVERY_MS) return catalog;
    return readCatalog(sink);
  }

  /** The folder a message is in, as Terno syncs it; one it doesn't know reads the list again (once a pass) before saying none. */
  function placer(sink: Pass) {
    let again: Promise<Catalog> | undefined;
    return async (parent: string | undefined): Promise<SyncedFolder | undefined> => {
      if (parent === undefined) return;
      const found = catalog?.synced.get(parent);
      if (found) return found;
      again ??= readCatalog(sink);
      return (await again).synced.get(parent);
    };
  }

  /** messages read once and found outside the window (or where Terno doesn't sync), for this window: not read again */
  const outside = new Set<string>();
  let outsideFloor = Number.NaN;
  /**
   * The B44 case's ids search named its hits by, each with the immutable id a read answered with (plan 275's code review
   * #9: a stored message named the other way took a hit's place); bounded, oldest out first
   */
  const aliases = new Map<string, string>();
  const learnAlias = (from: string, to: string) => {
    aliases.delete(from);
    aliases.set(from, to);
    if (aliases.size > 5000) aliases.delete(aliases.keys().next().value!);
  };
  /** the pass's own placer, made once */
  const placeIn = (sink: Pass) => (sink.place ??= placer(sink));

  // ───────────────────────────── messages ─────────────────────────────

  function stateOf(folder: SyncedFolder, envelope: Envelope): FlagUpdate["flags"] {
    return {
      inInbox: folder.role === "inbox",
      isTrash: folder.role === "trash",
      isSpam: folder.role === "junk",
      // a message stays your own once seen in Sent (as Gmail's SENT label does); a move out of Sent keeps it
      ...(folder.role === "sent" && { isSent: true }),
      ...(envelope.isDraft !== undefined ? { isDraft: envelope.isDraft } : folder.role === "drafts" ? { isDraft: true } : {}),
      ...(envelope.isRead !== undefined && { isRead: envelope.isRead }),
      ...(envelope.flagged !== undefined && { isStarred: envelope.flagged }),
    };
  }

  const update = (messageId: number, folder: SyncedFolder, envelope: Envelope): FlagUpdate =>
    ({ messageId, expectedProviderMsgId: envelope.id, flags: stateOf(folder, envelope), folder: folder.role ? null : folder.id, ...(envelope.inference && { category: categoryOfInference(envelope.inference) }) });

  function incoming(item: Wanted, resource: IncomingResource, repair?: { key: string; revision: number }): IncomingMessage {
    const { envelope, folder } = item;
    const parsed = resource.parsed;
    const me = ctx.account.email.toLowerCase();
    return {
      ...(repair && { repair: { key: repair.key, revision: repair.revision } }),
      accountId,
      providerMsgId: envelope.id,
      // Outlook's conversations are by subject: RFC references thread, as for IMAP (plan 259 revision 3)
      providerThreadId: null,
      rfcMessageId: parsed.rfcMessageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      from: parsed.from,
      replyTo: parsed.replyTo,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      date: envelope.received ?? parsed.date ?? Date.now(),
      snippet: "",
      bodyParts: parsed.bodyParts,
      preparedBodyTokens: parsed.preparedBodyTokens,
      bodyText: parsed.text,
      bodyHtml: parsed.html,
      bodyState: parsed.captureUnavailable ? "partial" : "full",
      captureUnavailable: parsed.captureUnavailable,
      listId: parsed.listId,
      bulk: parsed.bulk,
      unsubscribe: parsed.unsubscribe,
      isRead: envelope.isRead ?? false,
      isStarred: envelope.flagged ?? false,
      inInbox: folder.role === "inbox",
      isSent: folder.role === "sent" || parsed.from.email.toLowerCase() === me,
      isDraft: envelope.isDraft ?? folder.role === "drafts",
      isTrash: folder.role === "trash",
      isSpam: folder.role === "junk",
      hasAttachments: parsed.attachments.length > 0,
      size: resource.bytes,
      attachments: parsed.captureUnavailable ? undefined : parsed.attachments,
      folder: folder.role ? null : folder.id,
      // plan 275: Graph's classification, wherever the message is (only the Inbox's decides a tab); none said: a new row is
      // Focused, a stored one keeps its own (code review #6)
      ...(envelope.inference ? { category: categoryOfInference(envelope.inference) } : { defaultCategory: CAT_PERSONAL }),
    };
  }

  /**
   * Messages downloaded whole (`$value`) and stored, 50 at a time, four at once; those Graph no longer has are returned.
   * `hold` (plan 265): one only its own content fails is left unstored and held in `sink.held` while the rest go on.
   */
  async function fetchFull(items: Wanted[], sink: Pass, hold = false): Promise<Set<string>> {
    ctx.requests?.check(MAIL);
    const held = hold ? sink.held : undefined;
    const gone = new Set<string>();
    let batch: { message: IncomingMessage; release?: () => void }[] = [];
    let batchBytes = 0;
    let admission = Promise.resolve();
    let admissionBusy = false;
    const flush = async () => {
      if (!batch.length) return;
      sink.check();
      const ready = batch;
      batch = [];
      batchBytes = 0;
      try { await sink.ingest(ready.map((entry) => entry.message)); }
      finally { for (const entry of ready) entry.release?.(); }
    };
    const enqueue = (message: IncomingMessage, force = false) => {
      sink.check();
      const bytes = retainedIncomingBytes(message);
      let credit = !force ? ctx.incoming?.retainCompleted?.(bytes) : undefined;
      force ||= Boolean(ctx.incoming?.retainCompleted && !credit);
      if (!force && !admissionBusy && batch.length < 49 && batchBytes + bytes < 4 * 1024 * 1024) {
        batch.push({ message, release: credit });
        batchBytes += bytes;
        return;
      }
      admissionBusy = true;
      admission = admission.then(async () => {
        sink.check();
        if (force || batchBytes + bytes > 4 * 1024 * 1024) await flush();
        batch.push({ message, release: credit });
        credit = undefined;
        batchBytes += bytes;
        if (force || batch.length >= 50 || batchBytes >= 4 * 1024 * 1024) await flush();
      }).finally(() => { credit?.(); });
      const queued = admission;
      void queued.then(() => { if (admission === queued) admissionBusy = false; }, () => {});
      return admission;
    };
    let failure: { error: unknown } | undefined;
    const pass = new AbortController();
    const reset = reads.signal;
    const resetCanceled = () => pass.abort(reset.reason);
    if (reset.aborted) resetCanceled();
    else reset.addEventListener("abort", resetCanceled, { once: true });
    const canceled = () => pass.abort(sink.signal.reason);
    if (sink.signal.aborted) canceled();
    else sink.signal.addEventListener("abort", canceled, { once: true });
    try {
      await download(items, async (item) => {
        const id = item.envelope.id;
        const check = () => {
          sink.check();
          if (reset.aborted) throw new ProviderError(offline(), true);
          if (failure) throw failure.error;
        };
        let release: (() => void) | undefined;
        let resource: IncomingResource | undefined;
        const locator = { kind: "outlook" as const, providerId: id };
        // a send's draft on its way, however it was met (a search hit, a read by id: round 2 #3), is never stored
        if (staging.has(id) && item.folder.role !== "sent") return;
        const repair = await store.repairs?.get(accountId, locator);
        if (repair?.state === "blocked") return;
        const target = `/me/messages/${enc(id)}/$value`;
        try {
          release = ctx.incoming ? await ctx.incoming.acquire(accountId, pass.signal, reset) : undefined;
          check();
          try {
            resource = await api(target, { mime: true, signal: sink.signal, readReset: reset, preparation: pass.signal });
          } catch (error) {
            // a listing isn't a snapshot: a message may go before its download (revision 3: gone, never an identity error)
            if (notFound(error, target)) { await sink.retireCapture?.(locator); gone.add(id); return; }
            const reason = error instanceof IncomingCaptureRefusal ? error.reason : messageRefused(error, target) ? "server-refused" as const : undefined;
            if (reason && sink.blockCapture) {
              check();
              try { await sink.blockCapture(locator, reason, repair?.revision ?? 0); }
              catch (blocked) {
                if (!held || !(blocked instanceof RpcError && blocked.code === "UNAVAILABLE" && blocked.i18n?.key === "capture.capacity")) throw blocked;
                check(); held.error ??= blocked; held.count++; return;
              }
              check(); return;
            }
            if (held && (error instanceof IncomingCaptureRefusal || (error instanceof IncomingResourceError && MESSAGE_FAILURES.has(error.code)))) {
              check(); held.error ??= error; held.count++; return;
            }
            throw error;
          }
          check();
          const admitted = enqueue(incoming(item, resource, repair ?? undefined), resource.promoted);
          if (admitted) await admitted;
        } catch (error) {
          failure ??= { error: sink.signal.aborted ? sink.signal.reason : reset.aborted ? new ProviderError(offline(), true) : error };
          pass.abort();
          throw failure.error;
        } finally { resource?.release(); release?.(); }
      }, GRAPH_CONCURRENCY);
    } catch (error) {
      failure ??= { error };
    } finally {
      sink.signal.removeEventListener("abort", canceled);
      reset.removeEventListener("abort", resetCanceled);
    }
    let stored = true;
    try { await admission; }
    catch (error) { failure ??= { error }; stored = false; }
    try {
      if (stored) {
        sink.check();
        if (reset.aborted) throw new ProviderError(offline(), true);
        await flush();
        sink.check();
        if (reset.aborted) throw new ProviderError(offline(), true);
      }
    } catch (error) {
      failure ??= { error };
    }
    for (const entry of batch) entry.release?.();
    if (failure) throw failure.error;
    return gone;
  }

  /** The stored message a Graph id names, yielding every 50 lookups. */
  function lookups(sink: Pass): (id: string) => Promise<{ id: number; isDraft?: boolean } | null> {
    let examined = 0;
    return async (id) => {
      if (++examined % 50 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      sink.check();
      return store.messageByProviderId(id);
    };
  }

  /**
   * Whether a stored draft's change is to its content: still a draft in Drafts (edited there), or no longer a draft
   * (sent). A draft moved elsewhere (trashed) changed only its place, and keeps its row: an undo and the actions on
   * their way name it (review round 4).
   */
  const redraft = (folder: SyncedFolder, envelope: Envelope) => envelope.isDraft === false || (envelope.isDraft === true && folder.role === "drafts");

  /**
   * Stored drafts another app changed or sent: Outlook keeps a draft's id through its edits and its send, so the stored
   * copy is dropped and the message read whole again (its subject, recipients and body may all have changed). A read that
   * fails holds the page (`hold`), so its delta is read again.
   */
  async function readDraftsAgain(redrafted: readonly Redraft[], sink: Pass): Promise<void> {
    for (let i = 0; i < redrafted.length; i += 50) {
      const chunk = redrafted.slice(i, i + 50);
      await sink.removeMessages(chunk.map((r) => r.local));
      await fetchFull(chunk.map((r) => r.wanted), sink, true);
    }
  }

  /**
   * Messages read again by id (`$select` of the envelope): each placed where the server has it now (flags and folder by
   * updateFlags), or removed here when it isn't anywhere Terno syncs (a 404, or a folder it doesn't sync). Plan 259
   * revisions 4 and 8: what a `@removed` and a flag snapshot both come to.
   */
  async function observe(targets: readonly { local?: number; providerMsgId: string }[], sink: Pass): Promise<void> {
    const place = placeIn(sink);
    const updates: FlagUpdate[] = [], gone: { local?: number; providerMsgId: string }[] = [], redrafted: Redraft[] = [];
    await download([...targets], async (target) => {
      const path = `/me/messages/${enc(target.providerMsgId)}?$select=${SELECT}`;
      let envelope: Envelope;
      try {
        envelope = readEnvelope(await api(path, { signal: sink.signal, preparation: sink.signal, limit: SMALL_BYTES }));
        if (envelope.id !== target.providerMsgId || envelope.removed) throw invalid();
      } catch (error) {
        if (notFound(error, path)) { gone.push(target); return; }
        throw error;
      }
      const folder = await place(envelope.parent);
      if (!folder) { gone.push(target); return; }
      sink.seen.set(envelope.id, folder.id);
      if (target.local === undefined) return;
      // a draft still (changed elsewhere), or one now sent: read again whole, as a page's is (only these ask the store)
      if (redraft(folder, envelope) && (envelope.isDraft || folder.role === "sent") && (await store.messageByProviderId(target.providerMsgId))?.isDraft) {
        redrafted.push({ local: target.local, wanted: { envelope, folder, quiet: true } });
      } else updates.push(update(target.local, folder, envelope));
    }, GRAPH_CONCURRENCY);
    sink.check();
    for (let i = 0; i < updates.length; i += 200) await sink.updateFlags(updates.slice(i, i + 200));
    await readDraftsAgain(redrafted, sink);
    for (const target of gone) {
      const locator = { kind: "outlook" as const, providerId: target.providerMsgId };
      if (await store.repairs?.get(accountId, locator)) await sink.retireCapture?.(locator);
    }
    const removals = gone.flatMap((target) => target.local === undefined ? [] : [target.local]);
    for (let i = 0; i < removals.length; i += 50) await sink.removeMessages(removals.slice(i, i + 50));
  }

  /**
   * One page of a folder's listing or delta: messages it names that are stored take their flags and folder; new ones in
   * the window come down whole (`live` says which notify); a `@removed` (it left this folder: revision 4) is read again
   * by id unless this pass already saw it elsewhere. False: a message was held back, so nothing is saved past this page.
   */
  async function applyPage(folder: SyncedFolder, items: readonly Envelope[], sink: Pass, live: (envelope: Envelope) => boolean, changes = false): Promise<boolean> {
    const holds = sink.held.count;
    const lookup = lookups(sink);
    const updates: FlagUpdate[] = [], fresh: Wanted[] = [], removed: string[] = [], undated: string[] = [], redrafted: Redraft[] = [];
    for (const envelope of items) {
      // a send's draft on its way (its files still going up): the Sent copy comes whole after it (Codex code review #1);
      // the copy in Sent keeps the draft's id, and is stored whenever it's seen (round 2 #2)
      if (staging.has(envelope.id) && folder.role !== "sent") continue;
      if (envelope.removed) {
        const where = sink.seen.get(envelope.id);
        if (where === undefined || where === folder.id) removed.push(envelope.id);
        continue;
      }
      sink.seen.set(envelope.id, folder.id);
      const stored = await lookup(envelope.id);
      // a draft another app changed, or sent (the Sent copy keeps the draft's id: learn.microsoft.com/graph/outlook-immutable-id):
      // its content is read again, never only its flags (`changes`: a delta round's entry is a change)
      if (changes && stored?.isDraft && redraft(folder, envelope)) redrafted.push({ local: stored.id, wanted: { envelope, folder, quiet: true } });
      else if (stored) updates.push(update(stored.id, folder, envelope));
      // an update says only what changed: one Terno doesn't have and that names no date is read whole (Codex #2)
      else if (envelope.received === undefined) undated.push(envelope.id);
      // only what the window holds; a change to an older message it doesn't have (a read state) is nothing here
      else if (envelope.received >= sink.windowStart) fresh.push({ envelope, folder });
    }
    if (undated.length) {
      const place = placeIn(sink);
      if (outsideFloor !== sink.windowStart) { outside.clear(); outsideFloor = sink.windowStart; }
      await download(undated.filter((id) => !outside.has(id)), async (id) => {
        const path = `/me/messages/${enc(id)}?$select=${SELECT}`;
        let envelope: Envelope;
        try {
          envelope = readEnvelope(await api(path, { signal: sink.signal, preparation: sink.signal, limit: SMALL_BYTES }));
          if (envelope.id !== id || envelope.removed) throw invalid();
        } catch (error) {
          if (notFound(error, path)) return;
          throw error;
        }
        const where = await place(envelope.parent);
        if (!where || envelope.received === undefined || envelope.received < sink.windowStart) {
          if (outside.size >= OUTSIDE_MAX) outside.clear();
          outside.add(id);
          return;
        }
        // where the read found it decides its folder and whether it's new (round 2 #10)
        sink.seen.set(id, where.id);
        fresh.push({ envelope, folder: where, ...(where.id !== folder.id && { quiet: true }) });
      }, GRAPH_CONCURRENCY);
    }
    sink.check();
    for (let i = 0; i < updates.length; i += 200) await sink.updateFlags(updates.slice(i, i + 200));
    await readDraftsAgain(redrafted, sink);
    const liveSink: Pass = { ...sink, ingest: (messages) => sink.ingest(messages, { live: true }) };
    const now = fresh.filter((w) => !w.quiet && live(w.envelope)), older = fresh.filter((w) => w.quiet || !live(w.envelope));
    for (let i = 0; i < now.length; i += 50) await fetchFull(now.slice(i, i + 50), liveSink, true);
    for (let i = 0; i < older.length; i += 50) await fetchFull(older.slice(i, i + 50), sink, true);
    if (removed.length) {
      const targets: { local?: number; providerMsgId: string }[] = [];
      for (const id of removed) {
        const stored = await lookup(id);
        if (stored) targets.push({ local: stored.id, providerMsgId: id });
        else if (await store.repairs?.get(accountId, { kind: "outlook", providerId: id })) targets.push({ providerMsgId: id });
      }
      if (targets.length) await observe(targets, sink);
    }
    return sink.held.count === holds;
  }

  // ───────────────────────────── the pass ─────────────────────────────

  function readCursor(value: unknown): Cursor {
    const cursor: Cursor = { v: 1, folders: {} };
    if (!isRecord(value) || value.v !== 1 || !isRecord(value.folders)) return cursor;
    const link = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LINK_MAX;
    const ms = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
    const entries = Object.entries(value.folders);
    if (entries.length > FOLDERS_PER_ACCOUNT_MAX + Object.keys(ROLES).length) return cursor;
    for (const [id, state] of entries) {
      if (!isRecord(state) || id.length > ID_MAX || !ms(state.after) || !ms(state.startedAt)) continue;
      if ((state.delta !== undefined && !link(state.delta)) || (state.initial !== undefined && state.initial !== true) || (state.round !== undefined && !ms(state.round)) || (state.at !== undefined && !ms(state.at))) continue;
      if (state.list !== undefined && (!isRecord(state.list) || (state.list.next !== undefined && !link(state.list.next)))) continue;
      cursor.folders[id] = {
        after: state.after, startedAt: state.startedAt,
        ...(state.delta !== undefined && { delta: state.delta as string }), ...(state.initial && { initial: true as const }),
        ...(state.round !== undefined && { round: state.round as number }), ...(state.at !== undefined && { at: state.at as number }),
        ...(isRecord(state.list) && { list: { ...(state.list.next !== undefined && { next: state.list.next as string }) } }),
      };
    }
    if (isRecord(value.refresh) && (value.refresh.after === undefined || (typeof value.refresh.after === "string" && value.refresh.after.length <= LINK_MAX))) cursor.refresh = { ...(value.refresh.after !== undefined && { after: value.refresh.after as string }), ...(value.refresh.again === true && { again: true as const }) };
    if (Number.isSafeInteger(value.projection) && (value.projection as number) > 0) cursor.projection = value.projection as number;
    if (isRecord(value.left) && Array.isArray(value.left.folders) && value.left.folders.length <= 4 * FOLDERS_PER_ACCOUNT_MAX && value.left.folders.every((f) => typeof f === "string" && f.length > 0 && f.length <= ID_MAX) && (value.left.after === undefined || ms(value.left.after))) {
      cursor.left = { folders: [...value.left.folders as string[]], ...(value.left.after !== undefined && { after: value.left.after as number }) };
    }
    if (isRecord(value.backfill) && ms(value.backfill.since) && ms(value.backfill.until) && (value.backfill.next === undefined || link(value.backfill.next))) {
      cursor.backfill = { since: value.backfill.since, until: value.backfill.until, ...(value.backfill.next !== undefined && { next: value.backfill.next as string }) };
    }
    return cursor;
  }

  async function save(sink: Pass, cursor: Cursor) {
    sink.check();
    await ctx.saveCursor(cursor, sink.check);
    sink.check();
  }

  const firstListing = (folder: SyncedFolder, state: FolderState) =>
    `/me/mailFolders/${enc(folder.id)}/messages?$select=${SELECT}&$filter=${enc(`receivedDateTime ge ${iso(state.after)}`)}&$orderby=${enc("receivedDateTime desc")}&$top=${pageSize}`;
  /** a folder's first round: the window's filtered delta (it names at most 5,000: learn.microsoft.com/graph/delta-query-messages) */
  const firstDelta = (folder: SyncedFolder, state: FolderState) =>
    `/me/mailFolders/${enc(folder.id)}/messages/delta?$select=${SELECT}&$filter=${enc(`receivedDateTime ge ${iso(state.after)}`)}`;
  /** a reconciliation asked for: from the top, or after the one under way */
  const reconcile = (cursor: Cursor) => { cursor.refresh = cursor.refresh?.after !== undefined ? { ...cursor.refresh, again: true } : {}; };
  /**
   * Folders that stopped being synced: one of the person's own has its stored messages read again by id (`left`); a role
   * folder's are flags, not rows, so only the whole reconciliation finds them
   */
  const leave = (cursor: Cursor, folders: readonly string[], roles: ReadonlySet<string>) => {
    if (folders.some((id) => roles.has(id))) reconcile(cursor);
    const own = folders.filter((id) => !roles.has(id) && !cursor.left?.folders.includes(id));
    if (own.length) cursor.left = { folders: [...(cursor.left?.folders ?? []), ...own], ...(cursor.left?.after !== undefined && { after: cursor.left.after }) };
  };
  /** a new first round for a folder (a first sync, an expired link, a wider window) */
  const fresh = (after: number): FolderState => ({ after, startedAt: Date.now(), initial: true });

  /**
   * `unsaved`: the full pass's folder sweep saves an empty round's new link once, after the sweep, not once a folder (the
   * cursor holds every folder's state); a pass cut short reads the older link again, which repeats nothing harmful
   */
  /** `drain` (plan 275): every folder's link is read this pass, whatever its interval (an older projection's, to its end) */
  interface Budget { started: number; more: boolean; out: boolean; unsaved?: boolean; drain?: boolean }
  const outOfTime = (budget: Budget) => Date.now() - budget.started > FIRST_SYNC_CHUNK_MS;

  /**
   * New mail (plan 41) is the Inbox's, received after its first round began or (past it) after the last finished round
   * began, within a margin for the two clocks: never an old message moved into the Inbox (Codex code review #5).
   */
  const isNew = (folder: SyncedFolder, state: FolderState) => (envelope: Envelope) =>
    folder.role === "inbox" && envelope.received !== undefined && envelope.received >= (state.initial ? state.startedAt : (state.at ?? state.startedAt) - LIVE_MARGIN_MS);

  /**
   * Past a first round that held a filtered delta's 5,000, the rest of the window listed newest first, a page at a
   * time, each page's effects before its place is saved. Changes meanwhile are the delta's: its link was kept first
   * (Codex code review #1). True: all listed.
   */
  async function listFolder(folder: SyncedFolder, cursor: Cursor, sink: Pass, budget: Budget): Promise<boolean> {
    for (;;) {
      const state = cursor.folders[folder.id];
      if (!state?.list) return true;
      sink.check();
      const target = state.list.next ?? firstListing(folder, state);
      let page: Page;
      try { page = readPage(await api(target, { signal: sink.signal, preparation: sink.signal })); }
      catch (error) {
        if (notFound(error, target)) throw new FolderGone();
        // a continuation Graph no longer takes: the listing starts over (what's stored isn't downloaded again)
        if (state.list.next && error instanceof GraphApiError && error.target === target && error.status >= 400 && error.status < 500 && error.status !== 429 && !mailboxRefused(error)) {
          cursor.folders[folder.id] = { ...state, list: {} };
          await save(sink, cursor);
          budget.more = true;
          return false;
        }
        throw error;
      }
      if (page.delta || page.items.some((item) => item.removed)) throw invalid();
      if (page.next) resolve(page.next);
      if (!(await applyPage(folder, page.items, sink, (envelope) => folder.role === "inbox" && (envelope.received ?? -1) >= state.startedAt))) return false;
      const { list: _list, ...rest } = state;
      cursor.folders[folder.id] = page.next ? { ...state, list: { next: page.next } } : rest;
      await save(sink, cursor);
      if (!page.next) return true;
      if (outOfTime(budget)) { budget.more = true; budget.out = true; return false; }
      if (!page.items.length) await yieldPage();
    }
  }

  /** The folder's delta from its link (or its first round): pages applied, then their link saved; a deltaLink ends the round. */
  async function deltaFolder(folder: SyncedFolder, cursor: Cursor, sink: Pass, budget: Budget): Promise<void> {
    for (let pages = 0; ; pages++) {
      const state = cursor.folders[folder.id];
      if (!state || state.list) return;
      sink.check();
      // the round's start, before its first request: mail it doesn't hold is the next round's, received after this (round 2 #8)
      const round = state.round ?? Date.now();
      const target = state.delta ?? firstDelta(folder, state);
      let page: Page;
      try { page = readPage(await api(target, { signal: sink.signal, preparation: sink.signal, page: true, delta: true })); }
      catch (error) {
        if (notFound(error, target)) throw new FolderGone();
        // a saved link Graph calls a bad request (no longer one it takes, beyond the documented expiry codes): the folder
        // starts again as an expired link does, never retried as it is forever (review round 4)
        if (state.delta && error instanceof GraphApiError && error.target === target && error.status === 400 && !mailboxRefused(error)) throw new DeltaExpired();
        throw error;
      }
      // a link that can't be used is never kept (round 2 #12)
      resolve(page.delta ?? page.next ?? target);
      // a round after the first names what changed (a first round, like a listing, names everything)
      if (!(await applyPage(folder, page.items, sink, isNew(folder, state), !state.initial))) return;
      if (page.delta) {
        // a first round is followed by the rest of the window, listed: Graph names at most 5,000, and how many it named
        // never says it named them all (round 2 #1); the list skips what's stored
        cursor.folders[folder.id] = { after: state.after, startedAt: state.startedAt, delta: page.delta, at: round, ...(state.initial && { list: {} }) };
        if (budget.unsaved !== undefined && pages === 0 && !page.items.length && state.delta && !state.initial) budget.unsaved = true;
        else await save(sink, cursor);
        lastDelta.set(folder.id, Date.now());
        return;
      }
      if (!page.next) throw invalid();
      cursor.folders[folder.id] = { ...state, delta: page.next, round };
      await save(sink, cursor);
      if (pages + 1 >= DELTA_PAGES_PER_PASS) { budget.more = true; return; }
      // a first round out of the pass's share stops the pass's folders, as a listing does (round 2 #7)
      if (state.initial && outOfTime(budget)) { budget.more = true; budget.out = true; return; }
      if (!page.items.length) await yieldPage();
    }
  }

  /** when each folder's delta was last read to its end (in memory: a launch reads them all) */
  const lastDelta = new Map<string, number>();

  /**
   * One folder: its first round (the window's filtered delta, whose link is kept before anything is listed, so what
   * changes during a first sync is the next round's), the rest of the window listed when that round held 5,000, then its
   * delta when due. An expired link (410, syncStateNotFound) starts a new first round and reads every stored message
   * again by id (the reconciliation): moves and deletions in the gap are found that way, never guessed from what's
   * missing. A folder gone (a 404 that isn't the mailbox's) drops its place and starts the same reconciliation.
   */
  async function syncFolder(folder: SyncedFolder, cursor: Cursor, sink: Pass, budget: Budget): Promise<void> {
    let state = cursor.folders[folder.id];
    if (!budget.drain && state?.delta && !state.initial && !state.list && !folder.role && Date.now() - (lastDelta.get(folder.id) ?? -Infinity) < (options.userFoldersEveryMs ?? USER_FOLDERS_EVERY_MS)) return;
    if (!state) {
      state = cursor.folders[folder.id] = fresh(sink.windowStart);
      await save(sink, cursor);
    }
    try {
      if (!state.list) await deltaFolder(folder, cursor, sink, budget);
      if (budget.out || !cursor.folders[folder.id]?.list) return;
      if (await listFolder(folder, cursor, sink, budget)) await deltaFolder(folder, cursor, sink, budget);
    } catch (error) {
      if (error instanceof DeltaExpired) {
        const was = cursor.folders[folder.id];
        const next = fresh(was?.after ?? sink.windowStart);
        // mail since the last round that finished is still new (review round 4: what came in the gap went unannounced)
        if (was) next.startedAt = Math.min(next.startedAt, (was.at ?? was.startedAt) - LIVE_MARGIN_MS);
        cursor.folders[folder.id] = next;
        reconcile(cursor);
        await save(sink, cursor);
        budget.more = true;
        return;
      }
      // a 404 on the folder's own listing or delta (its saved link included): the folder went (Codex code review #4)
      if (error instanceof FolderGone) {
        delete cursor.folders[folder.id];
        leave(cursor, [folder.id], roleFolders);
        catalog = null;
        await save(sink, cursor);
        budget.more = true;
        return;
      }
      throw error;
    }
  }

  /** The Inbox first (new mail waits on nothing), then the other roles, then the person's folders. */
  function ordered(current: Catalog): SyncedFolder[] {
    const roles = (["inbox", "sent", "drafts", "archive", "junk", "trash"] as Role[]).flatMap((role) => current.byRole[role] ? [current.synced.get(current.byRole[role]!)!] : []);
    return [...roles, ...[...current.synced.values()].filter((f) => !f.role)];
  }

  /** What folders no longer synced held, read again by id a page at a time (each placed where it is now, or removed). */
  async function refreshLeft(cursor: Cursor, sink: Pass, budget: Budget): Promise<void> {
    while (cursor.left) {
      sink.check();
      const [folder] = cursor.left.folders;
      if (folder === undefined) { delete cursor.left; await save(sink, cursor); return; }
      const page = await store.folderMessagePage(folder, cursor.left.after);
      sink.check();
      if (page.next !== undefined && (page.items.length > 50 || (cursor.left.after !== undefined && page.next <= cursor.left.after))) throw invalid();
      if (page.items.length) await observe(page.items.map((m) => ({ local: m.id, providerMsgId: m.providerMsgId })), sink);
      const rest = cursor.left.folders.slice(1);
      cursor.left = page.next !== undefined ? { folders: cursor.left.folders, after: page.next } : { folders: rest };
      if (!cursor.left.folders.length) delete cursor.left;
      await save(sink, cursor);
      if (outOfTime(budget)) { budget.more = true; return; }
    }
  }

  /** The reconciliation after an expired delta: every stored message read again by id, a page at a time. */
  async function refreshStored(cursor: Cursor, sink: Pass, budget: Budget): Promise<void> {
    while (cursor.refresh) {
      sink.check();
      const page = await store.syncedMessagePage(cursor.refresh.after);
      sink.check();
      if (page.next === undefined) {
        if (cursor.refresh.again) cursor.refresh = {};
        else delete cursor.refresh;
        await save(sink, cursor);
        if (!cursor.refresh) return;
        continue;
      }
      if (page.next.length > LINK_MAX || page.items.length > 50 || (cursor.refresh.after !== undefined && page.next <= cursor.refresh.after)) throw invalid();
      await observe(page.items.map((m) => ({ local: m.id, providerMsgId: m.providerMsgId })), sink);
      cursor.refresh = { after: page.next, ...(cursor.refresh.again && { again: true as const }) };
      await save(sink, cursor);
      if (outOfTime(budget)) { budget.more = true; return; }
    }
  }

  /** where the flag snapshots' traversal stopped for time, for the next pass (in memory: a launch starts over) */
  let flagPlace: { after: number; through: number } | undefined;

  /** Plan 259 revision 8: flag snapshots answered by targeted reads, a share of them a pass. */
  async function reconcileFlags(sink: Pass): Promise<void> {
    if (!ctx.flagObservation) return;
    let after = flagPlace?.after, through = flagPlace?.through;
    const started = Date.now();
    for (;;) {
      sink.check();
      const page = await store.pendingFlagSnapshots({ limit: 50, ...(after !== undefined && { afterMessageId: after }), ...(through !== undefined && { throughMessageId: through }) });
      through ??= page.throughMessageId;
      if (!page.items.length) { flagPlace = undefined; return; }
      await observe(page.items.map((m) => ({ local: m.id, providerMsgId: m.providerMsgId })), sink);
      if (!page.hasMore) { flagPlace = undefined; return; }
      after = page.items[page.items.length - 1]!.id;
      if (Date.now() - started > FLAG_SNAPSHOTS_MS) { flagPlace = { after, through: through! }; sink.again?.(); return; }
    }
  }

  /**
   * Messages by id (a repair retried, a search hit, a stored message missing its attachments): read, placed, downloaded.
   * A stored one (`local`) that's gone, or in no folder Terno syncs, goes here too, so it never comes back to the head
   * of a list again (Codex code review #7); a repair whose message is gone is retired (revision 3: an Outlook outcome,
   * never an identity error).
   */
  async function fetchById(targets: readonly { local?: number; providerMsgId: string }[], sink: Pass, hold: boolean, hits = false): Promise<void> {
    const place = placeIn(sink);
    const wanted: Wanted[] = [], gone: { local?: number; providerMsgId: string }[] = [];
    await download([...targets], async (target) => {
      const path = `/me/messages/${enc(target.providerMsgId)}?$select=${SELECT}`;
      try {
        const envelope = readEnvelope(await api(path, { signal: sink.signal, preparation: sink.signal, limit: SMALL_BYTES }));
        if (envelope.removed) throw invalid();
        if (envelope.id !== target.providerMsgId) {
          // a search hit named by another id than the one this read (asking for immutable ids) answers with: the
          // answer's is the message's (the reliability checklist's B44); anything else naming another message is broken
          if (!hits || target.local !== undefined) throw invalid();
          learnAlias(target.providerMsgId, envelope.id);
          if (await store.messageByProviderId(envelope.id)) return;
        }
        const folder = await place(envelope.parent);
        // in no folder Terno syncs: a stored one goes, and a repair of one is retired (never read again each pass)
        if (folder) wanted.push({ envelope, folder });
        else gone.push(target);
      } catch (error) {
        if (notFound(error, path)) { gone.push(target); return; }
        throw error;
      }
    }, GRAPH_CONCURRENCY);
    const local = new Map(targets.flatMap((t) => t.local === undefined ? [] : [[t.providerMsgId, t.local] as const]));
    for (let i = 0; i < wanted.length; i += 50) {
      const missing = await fetchFull(wanted.slice(i, i + 50), sink, hold);
      for (const id of missing) gone.push({ local: local.get(id), providerMsgId: id });
    }
    for (const target of gone) {
      const locator = { kind: "outlook" as const, providerId: target.providerMsgId };
      if (await store.repairs?.get(accountId, locator)) await sink.retireCapture?.(locator);
    }
    const removals = gone.flatMap((target) => target.local === undefined ? [] : [target.local]);
    for (let i = 0; i < removals.length; i += 50) await sink.removeMessages(removals.slice(i, i + 50));
  }

  async function captureAttachments(sink: Pass) {
    if (sink.signal.aborted) return;
    const pending = await store.pendingAttachmentBodies(50);
    if (!pending.length || sink.signal.aborted) return;
    await fetchById(pending.map((m) => ({ local: m.id, providerMsgId: m.providerMsgId })), sink, false);
  }

  /**
   * Plan 101: older mail a widened window asks for, after the pass's own work: the span listed newest first across the
   * mailbox (`/me/messages`, Deleted Items included), what isn't stored and is in a synced folder downloaded (no
   * notices), its place saved a page at a time, at most BACKFILL_CHUNK_MS a pass.
   */
  async function backfill(cursor: Cursor, sink: Pass): Promise<void> {
    const request = sink.backfill;
    if (!request) return;
    const started = Date.now();
    const progress = cursor.backfill?.since === request.since && cursor.backfill.until === request.until ? cursor.backfill : { since: request.since, until: request.until };
    const lookup = lookups(sink);
    const place = placeIn(sink);
    let next = progress.next ?? `/me/messages?$select=${SELECT}&$filter=${enc(`receivedDateTime ge ${iso(request.since)} and receivedDateTime lt ${iso(request.until)}`)}&$orderby=${enc("receivedDateTime desc")}&$top=${pageSize}`;
    for (;;) {
      sink.check();
      let page: Page;
      try { page = readPage(await api(next, { signal: sink.signal, preparation: sink.signal })); }
      catch (error) {
        if (progress.next && error instanceof GraphApiError && error.target === next && error.status >= 400 && error.status < 500 && error.status !== 429) {
          delete cursor.backfill;
          await save(sink, cursor);
          sink.backfillMore?.();
          return;
        }
        throw error;
      }
      const wanted: Wanted[] = [];
      for (const envelope of page.items) {
        if (envelope.removed || await lookup(envelope.id)) continue;
        const folder = await place(envelope.parent);
        if (folder) wanted.push({ envelope, folder });
      }
      for (let i = 0; i < wanted.length; i += 50) await fetchFull(wanted.slice(i, i + 50), sink, true);
      if (sink.held.count) return;
      if (!page.next) break;
      next = page.next;
      cursor.backfill = { since: request.since, until: request.until, next };
      await save(sink, cursor);
      if (Date.now() - started > BACKFILL_CHUNK_MS) { sink.backfillMore?.(); return; }
    }
    delete cursor.backfill;
    // a folder's delta filter keeps the window it began with, so what came in is outside it (flag changes to it would
    // never be reported): each folder whose window began later starts a new first round from the wider one (Codex
    // code review #6); what's stored isn't downloaded again
    let restarted = false;
    for (const [id, state] of Object.entries(cursor.folders)) if (state.after > request.since) { cursor.folders[id] = fresh(request.since); restarted = true; }
    // what the old links would have reported between their last round and the new ones' first is read by id (round 2 #2)
    if (restarted) reconcile(cursor);
    await save(sink, cursor);
    await sink.backfillDone?.(request);
  }

  function passOf(outer: SyncSink): Pass {
    const generation = ctx.requests?.generation();
    const check = () => {
      outer.signal.throwIfAborted();
      if (generation !== ctx.requests?.generation()) throw new RequestNotDispatchedError(offline());
    };
    const effect = async (run: () => Promise<void>) => { check(); await run(); check(); };
    const pass: Pass = {
      ...outer, check, held: { count: 0 }, seen: new Map(),
      ingest: (messages, o) => effect(() => outer.ingest(messages, o)),
      updateFlags: (updates) => effect(() => outer.updateFlags(updates)),
      removeMessages: (ids) => effect(() => outer.removeMessages(ids)),
      setBody: (...args) => effect(() => outer.setBody(...args)),
    };
    // one for the pass, shared by the sinks made from it (a live one)
    pass.place = placer(pass);
    return pass;
  }

  /**
   * Plan 176: a quick check: the Inbox's delta from its saved round and nothing else (one request when nothing is new).
   * A first sync, an expired link or an unknown folder list is the ordinary pass's: asked for with `again()`, then left.
   */
  async function quickPass(sink: Pass): Promise<void> {
    const inbox = catalog?.byRole.inbox !== undefined ? catalog.synced.get(catalog.byRole.inbox) : undefined;
    const cursor = readCursor(await ctx.loadCursor<unknown>());
    sink.check();
    const state = inbox && cursor.folders[inbox.id];
    // links made with an older projection are started again by a full pass first (plan 275)
    if (!inbox || !state?.delta || state.initial || state.list || (cursor.projection ?? 0) < PROJECTION) return void sink.again?.();
    const budget: Budget = { started: Date.now(), more: false, out: false };
    try { await deltaFolder(inbox, cursor, sink, budget); }
    catch (error) {
      if (error instanceof DeltaExpired || error instanceof FolderGone) return void sink.again?.();
      throw error;
    }
    if (budget.more) sink.again?.();
    if (sink.held.error !== undefined) throw sink.held.error;
  }

  // ───────────────────────────── writes (stage 2b) ─────────────────────────────

  /** the role folders' ids for the writes: the catalog's, else each read by its well-known name once (ids never change) */
  let roles: Partial<Record<Role, string>> | undefined;
  async function roleIds(): Promise<Partial<Record<Role, string>>> {
    if (catalog) return catalog.byRole;
    if (roles) return roles;
    const found: Partial<Record<Role, string>> = {};
    await download(Object.entries(ROLES) as [Role, string][], async ([role, name]) => {
      const target = `/me/mailFolders/${name}?$select=id`;
      try {
        const folder = await api(target, { limit: SMALL_BYTES });
        if (!isRecord(folder) || !nonempty(folder.id) || folder.id.length > ID_MAX) throw invalid();
        found[role] = folder.id;
      } catch (error) {
        if (!notFound(error, target)) throw error;
      }
    }, GRAPH_CONCURRENCY);
    return (roles = found);
  }

  /**
   * An upload session's URL, which Graph hands back "in the https://outlook.office.com domain" (learn.microsoft.com/
   * graph/outlook-large-attachments): that host over https, or Graph's own root (a synthetic Graph's). Nowhere else.
   */
  function uploadTarget(target: string): string {
    let url: URL;
    try { url = new URL(target); } catch { throw invalid(); }
    const graphs = url.origin === graphBase.origin && url.pathname.startsWith(`${graphBase.pathname.replace(/\/$/, "")}/`);
    if (target.length > LINK_MAX || url.username || url.password || !(graphs || (url.protocol === "https:" && url.hostname === "outlook.office.com"))) throw invalid();
    return url.href;
  }

  /**
   * One piece of an upload session: a PUT of its bytes with their Content-Range, and no Authorization ("Do not specify
   * an Authorization request header": the URL carries its own). 200 asks for more; 201 Created was the last.
   */
  async function upload(target: string, piece: Uint8Array, start: number, total: number, run?: RequestRun): Promise<boolean> {
    ctx.requests?.check(MAIL, "send");
    const url = uploadTarget(target);
    quota.charge(1);
    const release = await slots.acquire();
    const generation = ctx.requests?.generation();
    const deadline = deadlineSignal(reads.signal, undefined, options.sendTimeoutMs ?? SEND_TIMEOUT_MS);
    try {
      let response: Response;
      let evidence: HttpResponseEvidence | undefined;
      try {
        const init: RequestInit = { method: "PUT", redirect: "error", signal: deadline.signal, body: piece as Uint8Array<ArrayBuffer>, headers: { "content-type": "application/octet-stream", "content-range": `bytes ${start}-${start + piece.byteLength - 1}/${total}` } };
        const sent = ctx.requests ? ctx.requests.request({ request: MAIL, admission: "send", generation, ...(run && { run }), onHeaders: (_status, observed) => { evidence = observed; } }, url, init) : netFetch(url, init);
        response = await untilAborted(sent, deadline.signal);
      } catch (error) {
        if (error instanceof RequestNotDispatchedError) throw error;
        throw isFetchNetworkFailure(error) ? ProviderError.network(offline()) : new ProviderError(offline(), true);
      }
      const text = await readResponseText(response, SMALL_BYTES, deadline.signal).catch(() => "");
      if (response.status === 200 || response.status === 201) return response.status === 201;
      throw new GraphApiError("upload", response.status, graphCodes(text), response.status === 429 || response.status >= 500, evidence ?? captureHttpResponseEvidence(response, MAIL, Date.now()));
    } finally {
      deadline.done();
      release();
    }
  }

  const writes = createGraphWrites({
    // stage 2b (Codex code review #1): a send's drafts on their way are never stored
    ctx, api, roleIds, upload,
    readCatalog: () => readCatalog({ signal: NEVER }),
    refusal: (error) => error instanceof GraphApiError ? { status: error.status, codes: error.codes } : undefined,
    buildRaw: options.buildRaw, writeMaxBytes: options.writeMaxBytes, uploadPieceBytes: options.uploadPieceBytes, staging,
  });

  return {
    flagSnapshots: true,
    // plan 176: a quick pass is one Inbox delta request when nothing is new
    quickChecks: true,

    async verify() {
      await mailbox({});
    },

    async sync(outer) {
      const sink = passOf(outer);
      sink.check();
      if (outer.quick) return quickPass(sink);
      const budget: Budget = { started: Date.now(), more: false, out: false, unsaved: false };
      const current = await ensureCatalog(sink);
      // a repair asked for now goes first (plan 265: one its own content fails again stays pending, held)
      const requested = sink.captureRetry;
      if (requested?.locator.kind === "outlook") {
        const repair = await store.repairs?.get(accountId, requested.locator);
        if (repair?.state === "pending" && repair.revision === requested.revision) await fetchById([{ providerMsgId: requested.locator.providerId }], sink, true);
      }
      sink.check();
      // a share of the flag backlog before the deltas (a snapshot read under its old epoch is refused: plan 38)
      await reconcileFlags(sink);
      const cursor = readCursor(await ctx.loadCursor<unknown>());
      sink.check();
      // plan 275 (Codex critique #2, #4): links made with an older SELECT keep it. A cursor with no folder yet takes the
      // new one at once (its first rounds are made with it); one with folders reads each old link to its end first, every
      // folder this pass (code review #1: replaced unread, a message deleted or moved out in the gap stayed)
      const upgrading = (cursor.projection ?? 0) < PROJECTION;
      if (upgrading && !Object.keys(cursor.folders).length) cursor.projection = PROJECTION;
      if (upgrading && cursor.projection !== PROJECTION) budget.drain = true;
      const sweep = Date.now();
      // a folder no longer synced keeps no place, and what Terno stored of it is read again by id (Codex code review #4)
      const dropped = Object.keys(cursor.folders).filter((id) => !current.synced.has(id));
      if (dropped.length) {
        for (const id of dropped) delete cursor.folders[id];
        leave(cursor, dropped, roleFolders);
        await save(sink, cursor);
      }
      // one folder Graph refuses (a 403, a 400 on its link) is that folder's: the rest still sync (review round 3), and
      // the pass still ends well, so new mail is announced and older mail fetched (round 4: a pass that always failed
      // left the account silent); it's asked again next pass, its place kept
      const refused = new Set<string>();
      for (const folder of ordered(current)) {
        if (budget.out) break;
        try { await syncFolder(folder, cursor, sink, budget); }
        catch (error) {
          if (!folderRefused(error)) throw error;
          refused.add(folder.id);
        }
      }
      if (budget.unsaved) { budget.unsaved = false; await save(sink, cursor); }
      // every old link read to its end this pass: each folder's round starts again from its window, mail since its last
      // finished round still new (as an expired link's); the listing gives what's stored its classification as a flag
      // update, and downloads nothing again
      if (budget.drain && !budget.out && Object.keys(cursor.folders).every((id) => refused.has(id) || (lastDelta.get(id) ?? -Infinity) >= sweep)) {
        for (const [id, state] of Object.entries(cursor.folders)) {
          cursor.folders[id] = { ...fresh(state.after), startedAt: Math.min(Date.now(), (state.at ?? state.startedAt) - LIVE_MARGIN_MS) };
        }
        cursor.projection = PROJECTION;
        await save(sink, cursor);
        budget.more = true;
      }
      sink.check();
      await refreshLeft(cursor, sink, budget);
      await refreshStored(cursor, sink, budget);
      // retries asked for earlier (a page of them) after new mail
      if (requested?.locator.kind !== "outlook") {
        const retry = await store.repairs?.list(accountId, "", "pending");
        const ids = retry?.items.flatMap((r) => r.locator.kind === "outlook" ? [r.locator.providerId] : []) ?? [];
        if (ids.length) await fetchById(ids.map((providerMsgId) => ({ providerMsgId })), sink, true);
      }
      sink.check();
      await captureAttachments(sink);
      sink.check();
      if (budget.more) sink.again?.();
      // a held message keeps its folder's place back: its error, and what to do about it, comes first
      if (sink.held.error !== undefined) throw sink.held.error;
      // plan 101: older mail, after everything new, once no first listing is under way
      if (!budget.more && !Object.entries(cursor.folders).some(([id, state]) => !refused.has(id) && (state.list || state.initial))) await backfill(cursor, sink);
    },

    async folders(sink) {
      if (catalog && Date.now() - catalog.at < CATALOG_EVERY_MS) return;
      await readCatalog(sink);
    },

    async search({ queries, before, limit, signal }) {
      ctx.requests?.check(MAIL);
      const lookupStored = (id: string) => store.messageByProviderId(id);
      const hits = new Map<string, number>();
      let partial = false;
      for (const query of queries) {
        signal.throwIfAborted();
        const kql = graphSearch(query);
        const top = Math.min(Math.max(limit, 1), 250);
        // KQL's from:/to: match words, so alice@example.com also finds alice+news@example.com: an address asked for is
        // checked exactly on each hit (the reliability checklist's B36)
        const exact = (v?: string) => v && v.includes("@") ? v.trim().toLowerCase() : undefined;
        const from = exact(query.from), to = exact(query.to);
        const select = `id,receivedDateTime${from ? ",from" : ""}${to ? ",toRecipients,ccRecipients,bccRecipients" : ""}`;
        let next: string | undefined;
        // learn.microsoft.com/graph/search-query-parameter: results by date sent, newest first, at most 1,000; `before`
        // and `after` are read from each hit's own receivedDateTime
        if (kql) next = `/me/messages?$search=${enc(`"${kql}"`)}&$select=${select}&$top=${top}`;
        // dates alone ("mail from last February"): $search documents no range for `received`, so a $filter on
        // receivedDateTime, newest first (the property it orders by is filtered first: learn.microsoft.com/graph/query-parameters)
        else if (query.after !== undefined || query.before !== undefined) {
          const range = [`receivedDateTime lt ${iso(Math.min(before, query.before ?? before))}`, ...(query.after !== undefined ? [`receivedDateTime ge ${iso(query.after)}`] : [])].join(" and ");
          next = `/me/messages?$filter=${enc(range)}&$orderby=${enc("receivedDateTime desc")}&$select=${select}&$top=${top}`;
        } else continue;
        let seen = 0;
        for (let pages = 0; next !== undefined && hits.size < limit; pages++) {
          if (pages >= 8) { partial = true; break; }
          const page = readPage(await api(next, { signal, preparation: signal }));
          for (const envelope of page.items) {
            seen++;
            if (envelope.removed || envelope.received === undefined || envelope.received >= before || (query.before !== undefined && envelope.received >= query.before) || (query.after !== undefined && envelope.received < query.after)) continue;
            if ((from && envelope.from !== from) || (to && !envelope.recipients?.includes(to))) continue;
            const known = aliases.get(envelope.id);
            if (hits.has(envelope.id) || await lookupStored(envelope.id) || (known && await lookupStored(known))) continue;
            hits.set(envelope.id, envelope.received);
            if (hits.size >= limit) break;
          }
          next = page.next;
          if (seen >= SEARCH_MAX) break;
        }
        // short of the limit with more Graph didn't give (its page bound or its 1,000): not the whole answer (Codex #10)
        if (hits.size < limit && (next !== undefined || seen >= SEARCH_MAX)) partial = true;
      }
      return { hits: [...hits].map(([id, date]): ProviderHit => ({ id, date })), partial };
    },

    async fetchHits(hits, sink) {
      const pass = passOf(sink);
      for (let i = 0; i < hits.length; i += 50) {
        pass.check();
        await fetchById(hits.slice(i, i + 50).map((h) => ({ providerMsgId: h.id })), pass, false, true);
      }
    },

    async describe(providerId, signal) {
      ctx.requests?.check(MAIL, "reader");
      try {
        const m = await api(`/me/messages/${enc(providerId)}?$select=id,subject,from,receivedDateTime`, { signal, preparation: signal, admission: "reader", limit: SMALL_BYTES });
        if (!isRecord(m) || m.id !== providerId) return;
        const from = isRecord(m.from) && isRecord(m.from.emailAddress) ? m.from.emailAddress : undefined;
        const sender = from && (nonempty(from.name) ? from.name : nonempty(from.address) ? from.address : undefined);
        const date = typeof m.receivedDateTime === "string" ? Date.parse(m.receivedDateTime) : NaN;
        return { ...(nonempty(m.subject) && { subject: m.subject.trim() }), ...(sender && { from: sender.trim() }), ...(Number.isSafeInteger(date) && date > 0 && { date }) };
      } catch (error) {
        // gone, unreadable, over its bound: the row stays as it is (a cancelled read is the caller's)
        if (signal.aborted) throw error;
        return;
      }
    },

    async readBody(target, signal) {
      const path = `/me/messages/${enc(target.providerMsgId)}/$value`;
      const release = await ctx.incoming?.acquire(accountId, signal, reads.signal, "reader");
      try {
        const resource = await api(path, { mime: true, signal, preparation: signal, admission: "reader" });
        let released = false;
        return { parsed: resource.parsed, release() { if (released) return; released = true; resource.release(); release?.(); } };
      } catch (error) {
        release?.();
        if (notFound(error, path)) return null;
        throw error;
      }
    },

    /**
     * Plan 272 (Show original): the message's source as Graph holds it (`GET /me/messages/{id}/$value`,
     * learn.microsoft.com/graph/outlook-get-mime-message), read on the click in the reader's lane and stored nowhere.
     * The read permit is held only while it reads; a 404 on that path is a message no longer on the server.
     */
    async readOriginal(target, signal) {
      ctx.requests?.check(MAIL, "reader");
      const path = `/me/messages/${enc(target.providerMsgId)}/$value`;
      const release = await ctx.incoming?.acquire(accountId, signal, reads.signal, "reader");
      try { return await api(path, { original: true, signal, preparation: signal, admission: "reader" }); }
      catch (error) {
        if (notFound(error, path)) return null;
        throw error;
      } finally { release?.(); }
    },

    // stage 2b (graph-writes.ts): flags, moves, archive, trash, spam, a filing and its undo, and send
    async execute(op: ProviderOp) {
      ctx.requests?.check(MAIL, op.kind === "send" ? "send" : "background");
      await writes.execute(op);
    },

    // plan 275: Focused Inbox's rule for a sender, read on the person's click before an action changes it
    async senderOverride(address, signal) {
      ctx.requests?.check(MAIL, "reader");
      return writes.senderOverride(address, signal);
    },

    // plan 107, stage 2b: the host holds the account's sync and ops meanwhile
    async createFolder(input) {
      ctx.requests?.check(MAIL);
      return writes.createFolder(input);
    },

    async renameFolder(input) {
      ctx.requests?.check(MAIL);
      return writes.renameFolder(input);
    },

    async deleteFolder(input) {
      ctx.requests?.check(MAIL);
      return writes.deleteFolder(input);
    },

    reset() {
      const stale = reads;
      reads = new AbortController();
      stale.abort(new DOMException("the network changed", "AbortError"));
    },

    async close() {
      reads.abort(new DOMException("closed", "AbortError"));
    },
  };
}

/** Desktop: the Graph client over the account's rotating refresh token (createMicrosoftSession). */
export function createGraphProvider(ctx: ProviderContext, options: { endpoints?: Partial<MicrosoftEndpoints>; requestsPerSecond?: number; buildRaw?: GraphApiOptions["buildRaw"] } = {}): MailProvider {
  const session = createMicrosoftSession(ctx, { endpoints: options.endpoints });
  const provider = createGraphApiProvider(ctx, { endpoints: options.endpoints, requestsPerSecond: options.requestsPerSecond, buildRaw: options.buildRaw, tokens: { get: session.get, invalidate: session.invalidate } });
  const close = provider.close.bind(provider);
  provider.close = async () => {
    session.close();
    await close();
  };
  return provider;
}

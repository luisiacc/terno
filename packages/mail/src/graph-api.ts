// Plan 259 stage 2a: Outlook's mail over Microsoft Graph, the read side. Every call goes to Graph's v1.0 `/me`, with
// `Prefer: IdType="ImmutableId"` (an id survives a move between folders: learn.microsoft.com/graph/outlook-immutable-id),
// at most four at a time (Outlook's "Four concurrent requests" per app and mailbox: learn.microsoft.com/graph/
// throttling-limits), paced under its 10,000 requests in ten minutes, and redirects refused. Each synced folder keeps a
// delta cursor (learn.microsoft.com/graph/delta-query-messages): a first sync lists the window newest first, then starts
// the folder's delta; `@removed` only says a message left that folder. Bodies are `$value` MIME through the incoming
// pool, as Gmail's are. Writes (flags, moves, folders, send) are stage 2b's: `execute` refuses them for now.
import { FOLDER_NAME_MAX, FOLDERS_PER_ACCOUNT_MAX, MAX_INCOMING_MIME_BYTES, isValidEmail } from "@terno/core";
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
import { parseRaw, type ParsedMessage } from "./mime";
import { isFetchNetworkFailure, RequestNotDispatchedError } from "./net-errors";
import { deadlineSignal, download, inlineCandidate, IncomingCaptureRefusal, IncomingResourceError, MESSAGE_FAILURES, processingError, READ_TIMEOUT_MS, type Held, type RequestDeadline } from "./rest-provider";
import { BACKFILL_CHUNK_MS, ProviderAuthError, ProviderError, type HttpRequestContext, type HttpResponseEvidence, type MailAdmission, type MailProvider, type ProviderContext, type ProviderHit, type ProviderOp, type ProviderQuery, type RequestRun, type SyncSink } from "./types";

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
/** a filtered delta's first round names at most this many (learn.microsoft.com/graph/delta-query-messages) */
const FILTERED_DELTA_MAX = 5000;
/** new mail is what was received after the last round ended, less this (Graph's clock and this one's) */
const LIVE_MARGIN_MS = 10 * 60_000;
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
const SELECT = "id,receivedDateTime,isRead,isDraft,flag,parentFolderId";
const IMMUTABLE = 'IdType="ImmutableId"';
const MAIL: HttpRequestContext = { endpoint: "graph-api", purpose: "mail" };
const IDENTITY: HttpRequestContext = { endpoint: "microsoft-identity", purpose: "identity-proof" };

type Role = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive";
/** Graph's well-known folder names (learn.microsoft.com/graph/api/resources/mailfolder) for Terno's roles */
const ROLES: Record<Role, string> = { inbox: "inbox", sent: "sentitems", drafts: "drafts", trash: "deleteditems", junk: "junkemail", archive: "archive" };
/** folders that hold no mail of the person's: never synced, nor anything under them */
const EXCLUDED = ["outbox", "conversationhistory", "syncissues"];

const enc = encodeURIComponent;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = () => new ProviderError(L("errors.outlook.invalidResponse"), true);
const offline = () => L("errors.outlook.requestOffline");

/** Graph refused a request: its status, and Graph's codes (error.code and the nested innererror codes). */
export class GraphApiError extends ProviderError {
  constructor(readonly target: string, readonly status: number, readonly codes: readonly string[], retryable: boolean, httpResponse?: HttpResponseEvidence) {
    super(L("errors.outlook.requestFailed", { status }), retryable, false, false, httpResponse);
  }
}

/** A delta link Graph no longer takes: `410 Gone` or a `syncStateNotFound` (learn.microsoft.com/graph/delta-query-overview). */
class DeltaExpired extends ProviderError {
  constructor() { super(L("errors.outlook.requestFailed", { status: 410 }), true); }
}

class ProofTokenExpired extends Error {}

/** Graph's error codes, top-level and nested (only tokens; never message text). */
function graphCodes(text: string): string[] {
  const codes: string[] = [];
  try {
    let error: unknown = (JSON.parse(text) as Record<string, unknown> | null)?.error;
    for (let depth = 0; isRecord(error) && depth < 5; depth++) {
      if (typeof error.code === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(error.code)) codes.push(error.code);
      error = error.innererror ?? error.innerError;
    }
  } catch { /* an unreadable body says only its status */ }
  return codes;
}

/**
 * The mailbox itself refused ("REST API is not yet supported for this mailbox": learn.microsoft.com/troubleshoot/exchange/
 * user-and-shared-mailboxes/rest-api-is-not-yet-supported-for-this-mailbox-error): a 404 that says nothing of a message.
 */
const MAILBOX_REFUSED = new Set(["mailboxnotenabledforrestapi", "mailboxnotsupportedforrestapi"]);
const mailboxRefused = (error: GraphApiError) => error.codes.some((code) => MAILBOX_REFUSED.has(code.toLowerCase()));

/** What a 404 on this very request says isn't there (a message, a folder) — never the mailbox (Codex code review #3). */
const notFound = (error: unknown, target: string) => error instanceof GraphApiError && error.status === 404 && error.target === target && !mailboxRefused(error);

/** An envelope as a listing, a delta page or a targeted read gives it. Absent fields weren't said (a delta update). */
interface Envelope {
  id: string;
  removed?: true;
  received?: number;
  isRead?: boolean;
  isDraft?: boolean;
  flagged?: boolean;
  parent?: string;
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

/** A folder Terno syncs: a role folder (its flags say where) or one of the person's own (its id is the folder key). */
interface SyncedFolder { id: string; role?: Role }

interface Catalog {
  at: number;
  byRole: Partial<Record<Role, string>>;
  synced: Map<string, SyncedFolder>;
  folders: ProviderFolder[];
}

/**
 * A folder's place. `after`: where its delta's window starts. `delta`: the link to read next (absent: its first round,
 * from the window's filter). `initial`: still that first round, `count` what it named so far. `list`: the window listed
 * after a first round that held a filtered delta's 5,000 (`next` its page). `at`: when its last round ended (new mail
 * is what was received after it). `startedAt`: when this folder's first round began.
 */
interface FolderState { after: number; startedAt: number; delta?: string; initial?: true; count?: number; list?: { next?: string }; at?: number }
interface BackfillProgress { since: number; until: number; next?: string }
interface Cursor {
  v: 1;
  folders: Record<string, FolderState>;
  /** an expired delta's reconciliation: every stored message read again by id, past `after` (the store's page key) */
  refresh?: { after?: string };
  backfill?: BackfillProgress;
}

interface Pass extends SyncSink {
  check(): void;
  held: Held;
  /** where this pass saw each message (a delta or a read placed it): a later `@removed` elsewhere needs no read */
  seen: Map<string, string>;
}

interface Wanted { envelope: Envelope; folder: SyncedFolder }

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
  /** tests only: what a filtered first round names at most (FILTERED_DELTA_MAX, Graph's 5,000) */
  filteredDeltaMax?: number;
}

interface IncomingResource { parsed: ParsedMessage; bytes: number; promoted: boolean; release(): void }

interface Call {
  /** the caller's (a pass's, a reader's) */
  signal?: AbortSignal;
  readReset?: AbortSignal;
  /** a pass that gave up: its queued requests never leave */
  preparation?: AbortSignal;
  context?: HttpRequestContext;
  admission?: MailAdmission;
  proofToken?: string;
  /** the proof's read with a token already renewed once: a 401 now means signing in again */
  proofFinal?: boolean;
  generation?: number;
  limit?: number;
  /** `Prefer: odata.maxpagesize` */
  page?: boolean;
  /** a delta link: its expiry is DeltaExpired */
  delta?: boolean;
}

/** At most `width` requests at once; a waiter that's aborted leaves the queue. */
function createSlots(width: number) {
  let active = 0;
  const waiting: { go(): void }[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next.go();
    else active--;
  };
  return {
    get active() { return active; },
    async acquire(signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted();
      if (active < width) active++;
      else await new Promise<void>((resolve, reject) => {
        const waiter = { go: () => { signal?.removeEventListener("abort", abort); resolve(); } };
        const abort = () => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) waiting.splice(at, 1);
          reject(signal!.reason);
        };
        waiting.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
      let released = false;
      return () => { if (!released) { released = true; release(); } };
    },
  };
}

/** The first `max` bytes of a body, the rest cancelled: over the capture policy, the worker reads its headers only. */
function truncated(response: Response, max: number): Response {
  const reader = response.body?.getReader();
  if (!reader) return response;
  let seen = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) { controller.close(); return; }
      const room = max - seen;
      if (next.value.byteLength < room) { seen += next.value.byteLength; controller.enqueue(next.value); return; }
      controller.enqueue(next.value.subarray(0, room));
      seen = max;
      controller.close();
      void reader.cancel().catch(() => {});
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
  for (const [property, value] of [["from", query.from], ["to", query.to], ["subject", query.subject]] as const) if (value) parts.push(...words(value).map((w) => `${property}:${w}`));
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

  const RETRY = Symbol("retry");

  /** One Graph request; a 401 is tried once more with a fresh token. */
  async function api(target: string, call: Call & { mime: true }): Promise<IncomingResource>;
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
    const token = call.proofToken ?? (waitOn ? await untilAborted(tokens.get(undefined, call.admission), waitOn) : await tokens.get(undefined, call.admission));
    if (ctx.requests && !call.proofToken) {
      try {
        await ctx.requests.prove(() => mailbox({ signal: call.signal, readReset: call.readReset, preparation: call.preparation, admission: call.admission, proofToken: token, proofFinal: retried, generation }), call.admission);
      } catch (error) {
        if (error instanceof ProofTokenExpired && !retried) return RETRY;
        throw error;
      }
    }
    const url = resolve(target);
    // Outlook's own pace and its four at once: what's queued leaves only for a pass still going
    if (!quota.unpaced) await quota.spend(1, waitOn);
    const release = await slots.acquire(waitOn);
    let holding = true;
    const free = () => { if (holding) { holding = false; release(); } };
    const deadline = deadlineSignal(call.readReset ?? reads.signal, call.signal, readTimeout);
    const failed = (error: unknown) => error instanceof RequestNotDispatchedError ? error : isFetchNetworkFailure(error) ? ProviderError.network(offline()) : new ProviderError(offline(), true);
    try {
      let response: Response;
      let evidence: HttpResponseEvidence | undefined;
      try {
        deadline.signal.throwIfAborted();
        const init: RequestInit = { method: "GET", redirect: "error", signal: deadline.signal, headers: { authorization: `Bearer ${token}`, prefer: call.page ? `${IMMUTABLE}, odata.maxpagesize=${pageSize}` : IMMUTABLE } };
        const sent = ctx.requests ? ctx.requests.request({ request: context, admission: call.admission, generation, onHeaders: (_status, observed) => { evidence = observed; } }, url, init) : netFetch(url, init);
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
        throw new GraphApiError(target, response.status, codes, response.status === 429 || response.status >= 500, evidence);
      }
      if (call.mime) {
        try { return await incomingResponse(response, deadline, call, free); }
        catch (error) {
          if (error instanceof IncomingProcessingError || error instanceof ResponseBodyLimitError) throw processingError(error, invalid);
          if (error instanceof ProviderError || error instanceof RequestNotDispatchedError) throw error;
          throw failed(error);
        }
      }
      let text: string;
      try { text = await readResponseText(response, call.limit ?? PAGE_BYTES, deadline.signal, yieldPage); }
      catch (error) {
        if (error instanceof ResponseBodyLimitError) throw invalid();
        if (!deadline.signal.aborted && !isFetchNetworkFailure(error)) throw invalid();
        throw failed(error);
      }
      free();
      try { return JSON.parse(text) as unknown; } catch { throw invalid(); }
    } finally {
      deadline.done();
      free();
    }
  }

  // ───────────────────────────── folders ─────────────────────────────

  let catalog: Catalog | null = null;

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
      await download(parents, async (parent) => {
        try { take(await collection(`/me/mailFolders/${enc(parent.id)}/childFolders?${query}`, signal, limit - nodes.size), parent.id, parent.depth + 1); }
        catch (error) { if (!notFound(error, `/me/mailFolders/${enc(parent.id)}/childFolders?${query}`)) throw error; }
      }, GRAPH_CONCURRENCY);
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
        if (at !== node && roleOf.get(at.id) === "inbox") break;
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
    const next: Catalog = { at: Date.now(), byRole, synced, folders };
    // the cache moves only once the list is stored (a failed write reads it again next pass)
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
    ({ messageId, expectedProviderMsgId: envelope.id, flags: stateOf(folder, envelope), folder: folder.role ? null : folder.id });

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
            if (error instanceof IncomingCaptureRefusal && sink.blockCapture) {
              check();
              try { await sink.blockCapture(locator, error.reason, repair?.revision ?? 0); }
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
  function lookups(sink: Pass): (id: string) => Promise<{ id: number } | null> {
    let examined = 0;
    return async (id) => {
      if (++examined % 50 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      sink.check();
      return store.messageByProviderId(id);
    };
  }

  /**
   * Messages read again by id (`$select` of the envelope): each placed where the server has it now (flags and folder by
   * updateFlags), or removed here when it isn't anywhere Terno syncs (a 404, or a folder it doesn't sync). Plan 259
   * revisions 4 and 8: what a `@removed` and a flag snapshot both come to.
   */
  async function observe(targets: readonly { local?: number; providerMsgId: string }[], sink: Pass): Promise<void> {
    const place = placer(sink);
    const updates: FlagUpdate[] = [], gone: { local?: number; providerMsgId: string }[] = [];
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
      if (target.local !== undefined) updates.push(update(target.local, folder, envelope));
    }, GRAPH_CONCURRENCY);
    sink.check();
    for (let i = 0; i < updates.length; i += 200) await sink.updateFlags(updates.slice(i, i + 200));
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
  async function applyPage(folder: SyncedFolder, items: readonly Envelope[], sink: Pass, live: (envelope: Envelope) => boolean): Promise<boolean> {
    const holds = sink.held.count;
    const lookup = lookups(sink);
    const updates: FlagUpdate[] = [], fresh: Wanted[] = [], removed: string[] = [], undated: string[] = [];
    for (const envelope of items) {
      if (envelope.removed) {
        const where = sink.seen.get(envelope.id);
        if (where === undefined || where === folder.id) removed.push(envelope.id);
        continue;
      }
      sink.seen.set(envelope.id, folder.id);
      const stored = await lookup(envelope.id);
      if (stored) updates.push(update(stored.id, folder, envelope));
      // an update says only what changed: one Terno doesn't have and that names no date is read whole (Codex #2)
      else if (envelope.received === undefined) undated.push(envelope.id);
      // only what the window holds; a change to an older message it doesn't have (a read state) is nothing here
      else if (envelope.received >= sink.windowStart) fresh.push({ envelope, folder });
    }
    if (undated.length) {
      const place = placer(sink);
      await download(undated, async (id) => {
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
        if (where && envelope.received !== undefined && envelope.received >= sink.windowStart) fresh.push({ envelope, folder: where });
      }, GRAPH_CONCURRENCY);
    }
    sink.check();
    for (let i = 0; i < updates.length; i += 200) await sink.updateFlags(updates.slice(i, i + 200));
    const liveSink: Pass = { ...sink, ingest: (messages) => sink.ingest(messages, { live: true }) };
    const now = fresh.filter((w) => live(w.envelope)), older = fresh.filter((w) => !live(w.envelope));
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
      if ((state.delta !== undefined && !link(state.delta)) || (state.initial !== undefined && state.initial !== true) || (state.count !== undefined && !ms(state.count)) || (state.at !== undefined && !ms(state.at))) continue;
      if (state.list !== undefined && (!isRecord(state.list) || (state.list.next !== undefined && !link(state.list.next)))) continue;
      cursor.folders[id] = {
        after: state.after, startedAt: state.startedAt,
        ...(state.delta !== undefined && { delta: state.delta as string }), ...(state.initial && { initial: true as const }),
        ...(state.count !== undefined && { count: state.count as number }), ...(state.at !== undefined && { at: state.at as number }),
        ...(isRecord(state.list) && { list: { ...(state.list.next !== undefined && { next: state.list.next as string }) } }),
      };
    }
    if (isRecord(value.refresh) && (value.refresh.after === undefined || (typeof value.refresh.after === "string" && value.refresh.after.length <= LINK_MAX))) cursor.refresh = { ...(value.refresh.after !== undefined && { after: value.refresh.after as string }) };
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
  /** a new first round for a folder (a first sync, an expired link, a wider window) */
  const fresh = (after: number): FolderState => ({ after, startedAt: Date.now(), initial: true });

  interface Budget { started: number; more: boolean; out: boolean }
  const outOfTime = (budget: Budget) => Date.now() - budget.started > FIRST_SYNC_CHUNK_MS;

  /**
   * New mail (plan 41) is the Inbox's, received after its first round began or (past it) after its last round ended,
   * within a margin for the two clocks: never an old message moved into the Inbox (Codex code review #5).
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
      const page = readPage(await api(state.delta ?? firstDelta(folder, state), { signal: sink.signal, preparation: sink.signal, page: true, delta: true }));
      if (!(await applyPage(folder, page.items, sink, isNew(folder, state)))) return;
      const count = (state.count ?? 0) + page.items.length;
      if (page.delta) {
        // a first round that named the filter's 5,000 lists the rest of the window next
        cursor.folders[folder.id] = { after: state.after, startedAt: state.startedAt, delta: page.delta, at: Date.now(), ...(state.initial && count >= (options.filteredDeltaMax ?? FILTERED_DELTA_MAX) && { list: {} }) };
        await save(sink, cursor);
        lastDelta.set(folder.id, Date.now());
        return;
      }
      if (!page.next) throw invalid();
      cursor.folders[folder.id] = { ...state, delta: page.next, ...(state.initial && { count }) };
      await save(sink, cursor);
      if (pages + 1 >= DELTA_PAGES_PER_PASS || (state.initial && outOfTime(budget))) { budget.more = true; return; }
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
    if (state?.delta && !state.initial && !state.list && !folder.role && Date.now() - (lastDelta.get(folder.id) ?? -Infinity) < (options.userFoldersEveryMs ?? USER_FOLDERS_EVERY_MS)) return;
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
        cursor.folders[folder.id] = fresh(cursor.folders[folder.id]?.after ?? sink.windowStart);
        cursor.refresh = {};
        await save(sink, cursor);
        budget.more = true;
        return;
      }
      // a 404 on the folder's own listing or delta (its saved link included): the folder went (Codex code review #4)
      if (error instanceof GraphApiError && error.status === 404 && !mailboxRefused(error) && !error.target.startsWith("/me/messages/")) {
        delete cursor.folders[folder.id];
        cursor.refresh = {};
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

  /** The reconciliation after an expired delta: every stored message read again by id, a page at a time. */
  async function refreshStored(cursor: Cursor, sink: Pass, budget: Budget): Promise<void> {
    while (cursor.refresh) {
      sink.check();
      const page = await store.syncedMessagePage(cursor.refresh.after);
      sink.check();
      if (page.next === undefined) { delete cursor.refresh; await save(sink, cursor); return; }
      if (page.next.length > LINK_MAX || page.items.length > 50 || (cursor.refresh.after !== undefined && page.next <= cursor.refresh.after)) throw invalid();
      await observe(page.items.map((m) => ({ local: m.id, providerMsgId: m.providerMsgId })), sink);
      cursor.refresh = { after: page.next };
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
  async function fetchById(targets: readonly { local?: number; providerMsgId: string }[], sink: Pass, hold: boolean): Promise<void> {
    const place = placer(sink);
    const wanted: Wanted[] = [], gone: { local?: number; providerMsgId: string }[] = [];
    await download([...targets], async (target) => {
      const path = `/me/messages/${enc(target.providerMsgId)}?$select=${SELECT}`;
      try {
        const envelope = readEnvelope(await api(path, { signal: sink.signal, preparation: sink.signal, limit: SMALL_BYTES }));
        if (envelope.id !== target.providerMsgId || envelope.removed) throw invalid();
        const folder = await place(envelope.parent);
        if (folder) wanted.push({ envelope, folder });
        else if (target.local !== undefined) gone.push(target);
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
    const place = placer(sink);
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
    for (const [id, state] of Object.entries(cursor.folders)) if (state.after > request.since) cursor.folders[id] = fresh(request.since);
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
    return {
      ...outer, check, held: { count: 0 }, seen: new Map(),
      ingest: (messages, o) => effect(() => outer.ingest(messages, o)),
      updateFlags: (updates) => effect(() => outer.updateFlags(updates)),
      removeMessages: (ids) => effect(() => outer.removeMessages(ids)),
      setBody: (...args) => effect(() => outer.setBody(...args)),
    };
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
    if (!inbox || !state?.delta || state.initial || state.list) return void sink.again?.();
    const budget: Budget = { started: Date.now(), more: false, out: false };
    try { await deltaFolder(inbox, cursor, sink, budget); }
    catch (error) {
      if (error instanceof DeltaExpired) return void sink.again?.();
      throw error;
    }
    if (budget.more) sink.again?.();
    if (sink.held.error !== undefined) throw sink.held.error;
  }

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
      const budget: Budget = { started: Date.now(), more: false, out: false };
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
      // a folder no longer synced keeps no place, and what Terno stored of it is read again by id (Codex code review #4)
      const dropped = Object.keys(cursor.folders).filter((id) => !current.synced.has(id));
      if (dropped.length) {
        for (const id of dropped) delete cursor.folders[id];
        cursor.refresh = {};
        await save(sink, cursor);
      }
      for (const folder of ordered(current)) {
        if (budget.out) break;
        await syncFolder(folder, cursor, sink, budget);
      }
      sink.check();
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
      if (!budget.more && !Object.values(cursor.folders).some((state) => state.list || state.initial)) await backfill(cursor, sink);
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
        if (!kql) continue;
        // learn.microsoft.com/graph/search-query-parameter: results by date sent, newest first, at most 1,000; `before`
        // and `after` are read from each hit's own receivedDateTime
        let next: string | undefined = `/me/messages?$search=${enc(`"${kql}"`)}&$select=id,receivedDateTime&$top=${Math.min(Math.max(limit, 1), 250)}`;
        let seen = 0;
        for (let pages = 0; next !== undefined && hits.size < limit; pages++) {
          if (pages >= 8) { partial = true; break; }
          const page = readPage(await api(next, { signal, preparation: signal }));
          for (const envelope of page.items) {
            seen++;
            if (envelope.removed || envelope.received === undefined || envelope.received >= before || (query.before !== undefined && envelope.received >= query.before) || (query.after !== undefined && envelope.received < query.after)) continue;
            if (hits.has(envelope.id) || await lookupStored(envelope.id)) continue;
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
        await fetchById(hits.slice(i, i + 50).map((h) => ({ providerMsgId: h.id })), pass, false);
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

    // Stage 2b: flags, moves, archive, trash, spam, folder changes and send. Until then an Outlook op says so plainly.
    async execute(op: ProviderOp) {
      ctx.requests?.check(MAIL, op.kind === "send" ? "send" : "background");
      throw new ProviderError(L("errors.outlook.actionNotYet"), false);
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
export function createGraphProvider(ctx: ProviderContext, options: { endpoints?: Partial<MicrosoftEndpoints>; requestsPerSecond?: number } = {}): MailProvider {
  const session = createMicrosoftSession(ctx, { endpoints: options.endpoints });
  const provider = createGraphApiProvider(ctx, { endpoints: options.endpoints, requestsPerSecond: options.requestsPerSecond, tokens: { get: session.get, invalidate: session.invalidate } });
  const close = provider.close.bind(provider);
  provider.close = async () => {
    session.close();
    await close();
  };
  return provider;
}

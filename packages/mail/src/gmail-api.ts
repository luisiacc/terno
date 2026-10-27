import { gmailSendBody } from "./outgoing-wire";
import { L } from "@terno/i18n";
import type { IncomingMessage } from "@terno/store";
import { collectGooglePhotos, type GoogleFailureReason } from "./google-photos";
import type { ParsedMessage } from "./mime";
import { cancelResponse, readResponseText, ResponseBodyLimitError, untilAborted } from "./http-body";
import { readIncomingBody, type IncomingBody } from "./incoming-body";
import { IncomingProcessingError, INCOMING_GMAIL_WIRE_BYTES } from "./incoming-processing";
import { failedBeforeRequest, isFetchNetworkFailure, RequestNotDispatchedError } from "./net-errors";
import { ProviderAuthError, ProviderError, type FlagUpdate, type MailProvider, type ProviderContext, type ProviderOp, type SendPayload, type SyncSink } from "./types";

export interface GmailEndpoints {
  auth: string;
  token: string;
  api: string;
  userinfo: string;
}

export const GOOGLE_ENDPOINTS: GmailEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  api: "https://gmail.googleapis.com/gmail/v1/users/me",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
};

export const GMAIL_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"];

/** base64url without Buffer (the Gmail API's raw messages) */
export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ───────────────────────────── API client ─────────────────────────────

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
}

interface Cursor {
  historyId: string;
}

interface MessageRef { id: string }
interface MessagePage { messages?: MessageRef[]; nextPageToken?: string }
interface HistoryEntry {
  messagesAdded?: { message: MessageRef }[];
  messagesDeleted?: { message: MessageRef }[];
  labelsAdded?: { message: MessageRef }[];
  labelsRemoved?: { message: MessageRef }[];
}
interface HistoryPage { history?: HistoryEntry[]; historyId: string; nextPageToken?: string }

class ExpiredHistory extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidResponse(sending = false): ProviderError {
  return new ProviderError(L("errors.gmail.invalidResponse"), !sending, sending);
}

function readMessage(value: unknown, id: string, raw = false): GmailMessage {
  if (!isRecord(value) || value.id !== id || (value.labelIds !== undefined && (!Array.isArray(value.labelIds) || !value.labelIds.every(nonempty)))) throw invalidResponse();
  if (raw && (!nonempty(value.threadId) || typeof value.raw !== "string" || !value.raw.length)) throw invalidResponse();
  if (raw && value.internalDate !== undefined && (typeof value.internalDate !== "string" || !/^-?\d+$/.test(value.internalDate) || !Number.isFinite(new Date(Number(value.internalDate)).getTime()))) throw invalidResponse();
  if (raw && value.sizeEstimate !== undefined && (typeof value.sizeEstimate !== "number" || !Number.isSafeInteger(value.sizeEstimate) || value.sizeEstimate < 0)) throw invalidResponse();
  return value as unknown as GmailMessage;
}

async function validateRaw(raw: string): Promise<void> {
  const chunkSize = 256 * 1024;
  const end = raw.length - (raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0);
  if (!end || end % 4 === 1 || (end !== raw.length && raw.length % 4 !== 0)) throw invalidResponse();
  for (let offset = 0; offset < end; offset += chunkSize) {
    if (offset) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!/^[A-Za-z0-9_-]+$/.test(raw.slice(offset, Math.min(end, offset + chunkSize)))) throw invalidResponse();
  }
}

function historyId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function earlierHistory(next: string, previous: string): boolean {
  const a = next.replace(/^0+/, ""), b = previous.replace(/^0+/, "");
  return a.length < b.length || (a.length === b.length && a < b);
}

function readBaseline(value: unknown): string {
  if (!isRecord(value) || !historyId(value.historyId)) throw invalidResponse();
  return value.historyId;
}

function optionalArray(value: unknown, valid: (item: unknown) => boolean): boolean {
  return value === undefined || (Array.isArray(value) && value.every(valid));
}

function messageRef(value: unknown): boolean {
  return isRecord(value) && nonempty(value.id);
}

function readList(value: unknown): MessagePage {
  if (!isRecord(value) || !optionalArray(value.messages, messageRef)) throw invalidResponse();
  return value as MessagePage;
}

function readHistory(value: unknown): HistoryPage {
  const change = (item: unknown) => isRecord(item) && messageRef(item.message);
  const entry = (item: unknown) => isRecord(item) && [item.messagesAdded, item.messagesDeleted, item.labelsAdded, item.labelsRemoved].every((changes) => optionalArray(changes, change));
  if (!isRecord(value) || !historyId(value.historyId) || !optionalArray(value.history, entry)) throw invalidResponse();
  return value as unknown as HistoryPage;
}

function continuation(value: unknown, seen: Set<string>): string | undefined {
  if (value === undefined) return;
  if (!nonempty(value) || seen.has(value)) throw invalidResponse();
  seen.add(value);
  return value;
}

async function download<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  }));
  if (failure) throw failure.error;
}

class GmailApiError extends ProviderError {
  constructor(readonly status: number, retryable: boolean, ambiguous: boolean, readonly reason?: GoogleFailureReason) {
    super(L("errors.gmail.requestFailed", { status }), retryable, ambiguous);
  }
}

function googleFailureReason(text: string): GoogleFailureReason | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !isRecord(value.error)) return;
    const details = [value.error.details, value.error.errors].flatMap((items) => Array.isArray(items) ? items : []);
    if (details.some((detail) => isRecord(detail) && (detail.reason === "SERVICE_DISABLED" || detail.reason === "accessNotConfigured"))) return "SERVICE_DISABLED";
    if (details.some((detail) => isRecord(detail) && (detail.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || detail.reason === "insufficientPermissions" || detail.reason === "SCOPE_INSUFFICIENT"))) return "ACCESS_TOKEN_SCOPE_INSUFFICIENT";
  } catch { /* Invalid bodies carry only their HTTP status. */ }
}

function isRateLimit(text: string): boolean {
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || !("error" in body)) return false;
    const error = body.error;
    if (!error || typeof error !== "object" || !("errors" in error) || !Array.isArray(error.errors)) return false;
    return error.errors.some((detail: unknown) => detail !== null && typeof detail === "object" && "reason" in detail && (detail.reason === "userRateLimitExceeded" || detail.reason === "rateLimitExceeded"));
  } catch {
    return false;
  }
}

function labelState(labels: string[]): FlagUpdate["flags"] {
  const has = (l: string) => labels.includes(l);
  return {
    inInbox: has("INBOX") && !has("TRASH") && !has("SPAM"),
    isRead: !has("UNREAD"),
    isStarred: has("STARRED"),
    isSent: has("SENT"),
    isDraft: has("DRAFT"),
    isTrash: has("TRASH"),
    isSpam: has("SPAM"),
  };
}

const LABEL_OPS: Record<string, { add?: string[]; remove?: string[] }> = {
  moveToInbox: { add: ["INBOX"], remove: ["SPAM", "TRASH"] },
  archive: { remove: ["INBOX"] },
  spam: { add: ["SPAM"], remove: ["INBOX"] },
  notSpam: { add: ["INBOX"], remove: ["SPAM"] },
  markRead: { remove: ["UNREAD"] },
  markUnread: { add: ["UNREAD"] },
  star: { add: ["STARRED"] },
  unstar: { remove: ["STARRED"] },
};

/** Where the provider gets access tokens: a refresh token on desktop, Google's token model (memory only) on the web. */
export interface GmailTokenSource {
  /** a valid access token, renewed as the platform can (throws ProviderError when the user must reconnect) */
  get(): Promise<string>;
  /**
   * the API refused `token` (401): forget it so the next get() renews. Only that one (plan 25, Codex review #5):
   * a request that left before a renew mustn't drop the token the renew just brought.
   */
  invalidate(token: string): void;
}

export interface GmailApiOptions {
  endpoints?: Partial<GmailEndpoints>;
  tokens: GmailTokenSource;
  /** the RFC 5322 source of a message to send (Bcc kept: the Gmail API reads recipients from headers) */
  buildRaw(payload: SendPayload): Promise<Uint8Array>;
  /** tests only: a read's and a send's deadlines */
  readTimeoutMs?: number;
  sendTimeoutMs?: number;
}

/** A read that hasn't finished in a minute is on a dead socket (undici's own wait is 5 minutes). */
const READ_TIMEOUT_MS = 60_000;
/** A send may upload 35 MB over a slow link; past this its outcome is unknown (never retried). */
const SEND_TIMEOUT_MS = 15 * 60_000;
const NEVER = new AbortController().signal;

/**
 * One request's signal: aborted by its deadline, by reset (`reset`) or by the caller. `done()`
 * clears the timer and the listeners (an `AbortSignal.timeout` would keep a timer per request alive).
 */
interface RequestDeadline {
  signal: AbortSignal;
  pause(): () => void;
  stopClock(): void;
  done(): void;
}

function deadlineSignal(reset: AbortSignal, caller: AbortSignal | undefined, ms: number): RequestDeadline {
  const ctl = new AbortController();
  const abort = (reason: unknown) => ctl.abort(reason);
  const onReset = () => abort(reset.reason);
  const onCaller = () => abort(caller?.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = ms, started = 0, paused = 0;
  let finished = false;
  const stopClock = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (performance.now() - started));
  };
  const arm = () => {
    if (finished || paused || ctl.signal.aborted) return;
    started = performance.now();
    timer = setTimeout(() => { timer = undefined; abort(new DOMException(`no answer in ${ms} ms`, "TimeoutError")); }, remaining);
  };
  if (reset.aborted) onReset();
  else reset.addEventListener("abort", onReset, { once: true });
  if (caller?.aborted) onCaller();
  else caller?.addEventListener("abort", onCaller, { once: true });
  arm();
  return {
    signal: ctl.signal,
    pause() {
      if (finished) return () => {};
      stopClock(); paused++;
      let resumed = false;
      return () => { if (!resumed) { resumed = true; paused--; arm(); } };
    },
    stopClock() { stopClock(); finished = true; },
    done() {
      stopClock(); finished = true;
      reset.removeEventListener("abort", onReset);
      caller?.removeEventListener("abort", onCaller);
    },
  };
}

interface IncomingResource {
  metadata: GmailMessage;
  parsed: ParsedMessage;
  promoted: boolean;
  release(): void;
}

class IncomingResourceError extends ProviderError {
  constructor(readonly code: string, message: ReturnType<typeof L>) { super(message, false); }
  override get expected(): boolean { return true; }
}

function processingError(error: IncomingProcessingError | ResponseBodyLimitError): ProviderError {
  if (error instanceof ResponseBodyLimitError || error.code === "input-limit" || error.code === "result-limit") return new IncomingResourceError("input-limit", L("errors.mail.processingLimit"));
  if (error.code.startsWith("malformed-")) return invalidResponse();
  if (error.code === "worker-timeout") return new IncomingResourceError(error.code, L("errors.mail.processingTimedOut"));
  if (error.code.startsWith("mime-limit-") || error.code === "envelope-unavailable") return new IncomingResourceError(error.code, L("errors.mail.processingComplex"));
  return new IncomingResourceError(error.code, L("errors.mail.processingUnavailable"));
}

function inlineCandidate(bytes: Uint8Array): boolean {
  let lines = 0, line = 0, parts = 0, tags = 0, entities = 0, nesting = 0, declarations = 0;
  for (let index = 0; index < bytes.length; index++) {
    const value = bytes[index]!;
    if ((value | 32) === 99) {
      const field = "content-transfer-encoding";
      let end = index;
      while (end - index < field.length && (bytes[end]! | 32) === field.charCodeAt(end - index)) end++;
      if (end - index === field.length) {
        while (bytes[end] === 32 || bytes[end] === 9 || bytes[end] === 10 || bytes[end] === 13) end++;
        if (bytes[end] === 58) return false;
      }
    }
    if (value === 10) {
      if (++lines > 128) return false;
      line = 0;
      if (bytes[index + 1] === 45 && bytes[index + 2] === 45 && ++parts > 16) return false;
    } else if (++line > 4096) return false;
    if (value === 60 && ++tags > 32) return false;
    if (value === 38 && ++entities > 256) return false;
    if ((value === 40 || value === 123 || value === 91) && ++nesting > 32) return false;
    if ((value === 58 || value === 59) && ++declarations > 64) return false;
    if ((value | 32) === 109 && (bytes[index + 1]! | 32) === 101 && (bytes[index + 2]! | 32) === 115 && (bytes[index + 3]! | 32) === 115 && (bytes[index + 4]! | 32) === 97 && (bytes[index + 5]! | 32) === 103 && (bytes[index + 6]! | 32) === 101) {
      let end = index + 7;
      while (bytes[end] === 32 || bytes[end] === 9 || bytes[end] === 10 || bytes[end] === 13) end++;
      if (bytes[end] === 47) return false;
    }
  }
  return true;
}

function retainedMessageBytes(message: IncomingMessage): number {
  const seen = new Set<object>();
  const charge = (value: unknown): number => {
    if (typeof value === "string") return value.length * 2;
    if (value === null || value === undefined) return 0;
    if (typeof value !== "object") return 8;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (value instanceof Uint8Array) return 64 + charge(value.buffer);
    if (value instanceof ArrayBuffer) return value.byteLength;
    const values = Object.values(value);
    return 64 + values.length * 8 + values.reduce<number>((total, child) => total + charge(child), 0);
  };
  return charge(message);
}

/** The Gmail REST client (sync, history, labels, send) over any token source: no Node APIs. */
export function createGmailApiProvider(ctx: ProviderContext, options: GmailApiOptions): MailProvider {
  const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const netFetch = ctx.fetch;
  const store = ctx.store;
  const accountId = ctx.account.id;
  const tokens = options.tokens;

  /** reads in flight listen here: reset() aborts them all at once (a send never does) */
  let reads = new AbortController();
  let parser: Promise<typeof import("./mime")> | undefined;

  async function incomingResponse(response: Response, expectedId: string, deadline: RequestDeadline, preparation?: AbortSignal): Promise<IncomingResource> {
    let body: IncomingBody | undefined;
    try {
      body = await readIncomingBody(response, {
        signal: deadline.signal, limit: INCOMING_GMAIL_WIRE_BYTES,
        async promote(signal) {
          const resume = deadline.pause();
          try {
            if (!ctx.incoming?.promote) throw new IncomingProcessingError("worker-unavailable");
            return await ctx.incoming.promote(accountId, signal);
          } finally { resume(); }
        },
      });
      deadline.stopClock();
      preparation?.throwIfAborted();
      if (body.bytes <= 65536) {
        const m = readMessage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.chunks[0])) as unknown, expectedId, true);
        await validateRaw(m.raw!);
        const bytes = fromBase64url(m.raw!);
        if (inlineCandidate(bytes)) {
          const mime = await (parser ??= import("./mime").then(async (loaded) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            return loaded;
          }));
          deadline.signal.throwIfAborted();
          const parsed = await mime.parseRaw(bytes);
          return { metadata: m, parsed, promoted: false, release: body.release };
        }
      }
      await body.promote();
      preparation?.throwIfAborted();
      if (!ctx.incomingProcessor) throw new IncomingProcessingError("worker-unavailable");
      const result = await ctx.incomingProcessor.run({ kind: "gmail", expectedId, chunks: body.chunks }, deadline.signal);
      if (result.kind !== "gmail") throw new IncomingProcessingError("worker-fault");
      return { metadata: result.metadata, parsed: result.message, promoted: true, release: body.release };
    } catch (error) { body?.release(); throw error; }
  }

  async function api<T>(path: string, init: RequestInit & { ambiguousOnFailure?: boolean; responseMode?: "json" | "void" | "incoming"; incomingId?: string; readReset?: AbortSignal; preparationSignal?: AbortSignal } = {}, retried = false): Promise<T> {
    const { ambiguousOnFailure, responseMode = "json", incomingId, readReset, preparationSignal, ...request } = init;
    preparationSignal?.throwIfAborted();
    const token = preparationSignal ? await untilAborted(tokens.get(), preparationSignal) : await tokens.get();
    preparationSignal?.throwIfAborted();
    const sending = Boolean(ambiguousOnFailure);
    // Plan 20: a read on a socket a network change killed fails fast, by its deadline or by reset(), and
    // the sync goes again on a fresh one. A send isn't reset and has a long deadline; its failure is ambiguous.
    const deadline = deadlineSignal(sending ? NEVER : (readReset ?? reads.signal), request.signal ?? undefined, sending ? (options.sendTimeoutMs ?? SEND_TIMEOUT_MS) : (options.readTimeoutMs ?? READ_TIMEOUT_MS));
    const failed = (e: unknown) => {
      if (e instanceof RequestNotDispatchedError) return e;
      const detail = L("errors.gmail.requestOffline");
      // a send that never connected (offline, DNS, refused) never left: it waits for the network like a read
      if (sending) return failedBeforeRequest(e) ? ProviderError.network(detail) : new ProviderError(detail, false, true);
      return isFetchNetworkFailure(e) ? ProviderError.network(detail) : new ProviderError(detail, true);
    };
    try {
      let res: Response;
      try {
        // plan 22: the People API and userinfo go through the same token and deadlines (absolute URLs)
        deadline.signal.throwIfAborted();
        res = await untilAborted(netFetch(path.startsWith("https://") ? path : `${ep.api}${path}`, { ...request, signal: deadline.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...request.headers } }).then((response) => {
          if (deadline.signal.aborted) { cancelResponse(response); throw deadline.signal.reason; }
          return response;
        }), deadline.signal);
      } catch (e) {
        throw failed(e);
      }
      if (res.status === 401) {
        cancelResponse(res);
        deadline.done();
        tokens.invalidate(token);
        // a fresh token refused as well: the grant is gone, the user signs in again (ops wait for it)
        if (retried) throw new ProviderAuthError(L("errors.gmail.revoked"));
        return await api<T>(path, init, true);
      }
      if (!res.ok) {
        const text = await readResponseText(res, 65_536, deadline.signal).catch(() => "");
        const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && isRateLimit(text));
        throw new GmailApiError(res.status, retryable, Boolean(sending && res.status >= 500), googleFailureReason(text));
      }
      if (responseMode === "void") {
        cancelResponse(res);
        return undefined as T;
      }
      try {
        if (responseMode === "incoming") return await incomingResponse(res, incomingId!, deadline, preparationSignal) as T;
        if (path === "/profile" || path === "/messages/send" || path === ep.userinfo) return JSON.parse(await readResponseText(res, 65_536, deadline.signal)) as T;
        return await untilAborted(res.json(), deadline.signal) as T;
      } catch (e) {
        if (responseMode === "incoming" && (e instanceof IncomingProcessingError || e instanceof ResponseBodyLimitError)) throw processingError(e);
        // The request was accepted; a send whose answer can't be read has an unknown outcome (no resend).
        if (sending) throw invalidResponse(true);
        if (!deadline.signal.aborted && !isFetchNetworkFailure(e)) throw invalidResponse();
        // a read whose body stopped coming (the deadline, a reset, a dead socket) is safe to repeat
        throw failed(e);
      }
    } finally {
      deadline.done();
    }
  }

  async function fetchFull(ids: string[], sink: SyncSink, captured?: (id: string) => void): Promise<Set<string>> {
    const gone = new Set<string>();
    let batch: { message: IncomingMessage; release?: () => void }[] = [];
    let batchBytes = 0;
    let admission = Promise.resolve();
    let admissionBusy = false;
    const flush = async () => {
      if (!batch.length) return;
      sink.signal.throwIfAborted();
      const ready = batch;
      batch = [];
      batchBytes = 0;
      try {
        await sink.ingest(ready.map((entry) => entry.message));
        for (const { message } of ready) captured?.(message.providerMsgId!);
      } finally { for (const entry of ready) entry.release?.(); }
    };
    const enqueue = (message: IncomingMessage, force = false) => {
      sink.signal.throwIfAborted();
      const bytes = retainedMessageBytes(message);
      let credit = !force ? ctx.incoming?.retainCompleted?.(bytes) : undefined;
      // Credit refusal flushes this producer instead of waiting on another account's partial batch.
      force ||= Boolean(ctx.incoming?.retainCompleted && !credit);
      if (!force && !admissionBusy && batch.length < 49 && batchBytes + bytes < 4 * 1024 * 1024) {
        batch.push({ message, release: credit });
        batchBytes += bytes;
        return;
      }
      // Admission serializes staging without making six producers await an unfilled 50-item batch.
      admissionBusy = true;
      admission = admission.then(async () => {
        sink.signal.throwIfAborted();
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
      await download(ids, async (id) => {
        const check = () => {
          sink.signal.throwIfAborted();
          if (reset.aborted) throw new ProviderError(L("errors.gmail.requestOffline"), true);
          if (failure) throw failure.error;
        };
        let release: (() => void) | undefined;
        let resource: IncomingResource | undefined;
        try {
          release = ctx.incoming ? await ctx.incoming.acquire(accountId, pass.signal, reset) : undefined;
          check();
          let m: GmailMessage;
          try {
            resource = await api<IncomingResource>(`/messages/${id}?format=raw`, { signal: sink.signal, readReset: reset, preparationSignal: pass.signal, responseMode: "incoming", incomingId: id });
            m = resource.metadata;
          } catch (error) {
            // Enumeration isn't a snapshot: a message may disappear before its download.
            if (error instanceof GmailApiError && error.status === 404) { gone.add(id); return; }
            throw error;
          }
          check();
          const parsed = resource.parsed;
          check();
          const labels = m.labelIds ?? [];
          const st = labelState(labels);
          const admitted = enqueue({
            accountId,
            providerMsgId: m.id,
            providerThreadId: m.threadId,
            rfcMessageId: parsed.rfcMessageId,
            inReplyTo: parsed.inReplyTo,
            references: parsed.references,
            from: parsed.from,
            replyTo: parsed.replyTo,
            to: parsed.to,
            cc: parsed.cc,
            bcc: parsed.bcc,
            subject: parsed.subject,
            date: Number(m.internalDate ?? parsed.date ?? Date.now()),
            snippet: "",
            bodyText: parsed.text,
            bodyHtml: parsed.html,
            bodyState: parsed.captureUnavailable ? "partial" : "full",
            captureUnavailable: parsed.captureUnavailable,
            listId: parsed.listId,
            bulk: parsed.bulk,
            isRead: st.isRead!,
            isStarred: st.isStarred!,
            inInbox: st.inInbox!,
            isSent: st.isSent!,
            isDraft: st.isDraft!,
            isTrash: st.isTrash!,
            isSpam: st.isSpam!,
            hasAttachments: parsed.attachments.length > 0,
            gmailLabels: labels,
            size: m.sizeEstimate ?? 0,
            attachments: parsed.captureUnavailable ? undefined : parsed.attachments,
          }, resource.promoted);
          if (admitted) await admitted;
        } catch (error) {
          failure ??= { error: sink.signal.aborted ? sink.signal.reason : reset.aborted ? new ProviderError(L("errors.gmail.requestOffline"), true) : error };
          pass.abort();
          throw failure.error;
        } finally { resource?.release(); release?.(); }
      });
    } catch (error) {
      failure ??= { error };
    } finally {
      sink.signal.removeEventListener("abort", canceled);
      reset.removeEventListener("abort", resetCanceled);
    }
    try {
      await admission;
      if (!failure) {
        sink.signal.throwIfAborted();
        if (reset.aborted) throw new ProviderError(L("errors.gmail.requestOffline"), true);
        await flush();
        sink.signal.throwIfAborted();
        if (reset.aborted) throw new ProviderError(L("errors.gmail.requestOffline"), true);
      }
    } catch (error) {
      failure ??= { error };
    }
    for (const entry of batch) entry.release?.();
    if (failure) throw failure.error;
    return gone;
  }

  async function fullSync(sink: SyncSink, previousHistory?: string) {
    const baseline = readBaseline(await api<unknown>("/profile"));
    if (previousHistory && earlierHistory(baseline, previousHistory)) throw invalidResponse();
    const after = Math.floor(sink.windowStart / 1000);
    const freshlyIngested = new Set<string>();
    let pageToken: string | undefined;
    const pages = new Set<string>();
    do {
      const q = new URLSearchParams({ q: `after:${after}`, maxResults: "500", includeSpamTrash: "true" });
      if (pageToken) q.set("pageToken", pageToken);
      const page = readList(await api<unknown>(`/messages?${q}`));
      pageToken = continuation(page.nextPageToken, pages);
      const pageIds = (page.messages ?? []).map((m) => m.id);
      const ids: string[] = [];
      for (const id of pageIds) if (!(await store.messageByProviderId(id))) ids.push(id);
      for (let i = 0; i < ids.length; i += 50) {
        if (sink.signal.aborted) return;
        const batch = ids.slice(i, i + 50);
        await fetchFull(batch, sink, (id) => freshlyIngested.add(id));
      }
    } while (pageToken);
    // A resync (history expired) must also refresh what we already had: labels may have
    // changed and messages may have been deleted during the gap.
    const cached = await store.syncedMessages();
    // Every cached message is checked (also ones older than the window): explicit 404s are
    // deletions; any other failure aborts before the cursor advances, so nothing is skipped.
    const updates: FlagUpdate[] = [];
    const gone: number[] = [];
    await download(cached.filter((m) => !freshlyIngested.has(m.providerMsgId)), async (m) => {
      try {
        const full = readMessage(await api<unknown>(`/messages/${m.providerMsgId}?format=minimal`), m.providerMsgId);
        updates.push({ messageId: m.id, flags: labelState(full.labelIds ?? []), gmailLabels: full.labelIds ?? [] });
      } catch (e) {
        if (e instanceof GmailApiError && e.status === 404) gone.push(m.id);
        else throw e;
      }
    });
    if (updates.length) await sink.updateFlags(updates);
    if (gone.length) await sink.removeMessages(gone);
    await ctx.saveCursor({ historyId: baseline } satisfies Cursor);
  }

  async function incremental(sink: SyncSink, cursor: Cursor) {
    const added = new Set<string>();
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let pageToken: string | undefined;
    const pages = new Set<string>();
    let latest = cursor.historyId;
    do {
      const q = new URLSearchParams({ startHistoryId: cursor.historyId, maxResults: "500" });
      for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) q.append("historyTypes", t);
      if (pageToken) q.set("pageToken", pageToken);
      const page = readHistory(await api<unknown>(`/history?${q}`).catch((error: unknown) => {
        if (error instanceof GmailApiError && error.status === 404) throw new ExpiredHistory();
        throw error;
      }));
      pageToken = continuation(page.nextPageToken, pages);
      if (earlierHistory(page.historyId, latest)) throw invalidResponse();
      for (const h of page.history ?? []) {
        for (const a of h.messagesAdded ?? []) added.add(a.message.id);
        for (const d of h.messagesDeleted ?? []) deleted.add(d.message.id);
        for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) changed.add(l.message.id);
      }
      latest = page.historyId;
    } while (pageToken);

    const known = async (id: string) => (await store.messageByProviderId(id))?.id;
    const toFetch: string[] = [];
    for (const id of added) if (!deleted.has(id) && !(await known(id))) toFetch.push(id);
    for (let i = 0; i < toFetch.length; i += 50) await fetchFull(toFetch.slice(i, i + 50), sink);

    const updates: FlagUpdate[] = [];
    for (const gid of changed) {
      if (deleted.has(gid)) continue;
      const local = await known(gid);
      if (!local) continue;
      try {
        const m = readMessage(await api<unknown>(`/messages/${gid}?format=minimal`), gid);
        updates.push({ messageId: local, flags: labelState(m.labelIds ?? []), gmailLabels: m.labelIds ?? [] });
      } catch (e) {
        if (e instanceof GmailApiError && e.status === 404) deleted.add(gid);
        else throw e;
      }
    }
    if (updates.length) await sink.updateFlags(updates);
    const removals: number[] = [];
    for (const gid of deleted) {
      const id = await known(gid);
      if (id !== undefined) removals.push(id);
    }
    if (removals.length) await sink.removeMessages(removals);
    await ctx.saveCursor({ historyId: latest } satisfies Cursor);
  }

  async function captureAttachments(sink: SyncSink) {
    if (sink.signal.aborted) return;
    const pending = await store.pendingAttachmentBodies(50);
    if (!pending.length || sink.signal.aborted) return;
    const missing = await fetchFull(pending.map((m) => m.providerMsgId), sink);
    if (sink.signal.aborted) return;
    const gone = pending.filter((m) => missing.has(m.providerMsgId)).map((m) => m.id);
    if (gone.length) await sink.removeMessages(gone);
  }

  return {
    async verify() {
      readBaseline(await api<unknown>("/profile"));
    },

    photos(want, signal) {
      return collectGooglePhotos((url, sig) => api(url, { signal: sig }), ep.userinfo, want, signal);
    },

    async sync(sink) {
      const cursor = await ctx.loadCursor<Cursor>();
      if (!isRecord(cursor) || !historyId(cursor.historyId)) {
        await fullSync(sink);
        return captureAttachments(sink);
      }
      try {
        await incremental(sink, cursor);
      } catch (e) {
        // History records expire (~1 week): Google answers 404 and a full resync is required.
        if (e instanceof ExpiredHistory) {
          await fullSync(sink, cursor.historyId);
        } else {
          throw e;
        }
      }
      await captureAttachments(sink);
    },

    async execute(op: ProviderOp) {
      if (op.kind === "send") {
        const payload = op.payload as SendPayload;
        const raw = await options.buildRaw(payload);
        const res = await api<unknown>("/messages/send", {
          method: "POST",
          body: await gmailSendBody(raw, payload.providerThreadId),
          ambiguousOnFailure: true,
        });
        if (!isRecord(res) || !nonempty(res.id) || (res.threadId !== undefined && !nonempty(res.threadId))) throw invalidResponse(true);
        return { providerMsgId: res.id, providerThreadId: res.threadId };
      }
      const ids = op.target.messageIds ?? [];
      if (!ids.length) return;
      const gmailIds = [...(await store.providerIds(ids))]
        .sort(([a], [b]) => a - b)
        .flatMap(([, p]) => (p && !p.startsWith("local:") ? [p] : []));
      if (!gmailIds.length) return;
      if (op.kind === "trash") {
        for (const id of gmailIds) await api(`/messages/${id}/trash`, { method: "POST" });
        return;
      }
      const labels = LABEL_OPS[op.kind];
      if (!labels) throw new ProviderError(`Unsupported operation ${op.kind}`, false);
      for (let i = 0; i < gmailIds.length; i += 1000) {
        await api("/messages/batchModify", { method: "POST", responseMode: "void", body: JSON.stringify({ ids: gmailIds.slice(i, i + 1000), addLabelIds: labels.add ?? [], removeLabelIds: labels.remove ?? [] }) });
      }
    },

    reset() {
      // reads in flight fail now (retryable) and the sync goes again on fresh sockets; sends aren't listening
      const stale = reads;
      reads = new AbortController();
      stale.abort(new DOMException("the network changed", "AbortError"));
    },

    async close() {
      reads.abort(new DOMException("closed", "AbortError"));
    },
  };
}

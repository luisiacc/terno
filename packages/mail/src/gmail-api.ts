import { L } from "@terno/i18n";
import type { IncomingMessage } from "@terno/store";
import { collectGooglePhotos } from "./google-photos";
import { parseRaw } from "./mime";
import { failedBeforeRequest, isFetchNetworkFailure } from "./net-errors";
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

class ExpiredHistory extends Error {}

class GmailApiError extends ProviderError {
  constructor(readonly status: number, detail: string, retryable: boolean, ambiguous: boolean) {
    super(`Gmail API ${status}: ${detail.slice(0, 200)}`, retryable, ambiguous);
  }
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
function deadlineSignal(reset: AbortSignal, caller: AbortSignal | undefined, ms: number): { signal: AbortSignal; done(): void } {
  const ctl = new AbortController();
  const abort = (reason: unknown) => ctl.abort(reason);
  const onReset = () => abort(reset.reason);
  const onCaller = () => abort(caller?.reason);
  const timer = setTimeout(() => abort(new DOMException(`no answer in ${ms} ms`, "TimeoutError")), ms);
  if (reset.aborted) onReset();
  else reset.addEventListener("abort", onReset, { once: true });
  if (caller?.aborted) onCaller();
  else caller?.addEventListener("abort", onCaller, { once: true });
  return {
    signal: ctl.signal,
    done() {
      clearTimeout(timer);
      reset.removeEventListener("abort", onReset);
      caller?.removeEventListener("abort", onCaller);
    },
  };
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

  async function api<T>(path: string, init: RequestInit & { ambiguousOnFailure?: boolean; responseMode?: "json" | "void" } = {}, retried = false): Promise<T> {
    const { ambiguousOnFailure, responseMode = "json", ...request } = init;
    const token = await tokens.get();
    const sending = Boolean(ambiguousOnFailure);
    // Plan 20: a read on a socket a network change killed fails fast, by its deadline or by reset(), and
    // the sync goes again on a fresh one. A send isn't reset and has a long deadline; its failure is ambiguous.
    const deadline = deadlineSignal(sending ? NEVER : reads.signal, request.signal ?? undefined, sending ? (options.sendTimeoutMs ?? SEND_TIMEOUT_MS) : (options.readTimeoutMs ?? READ_TIMEOUT_MS));
    const failed = (e: unknown) => {
      const detail = L("errors.network", { detail: e instanceof Error ? e.message : String(e) });
      // a send that never connected (offline, DNS, refused) never left: it waits for the network like a read
      if (sending) return failedBeforeRequest(e) ? ProviderError.network(detail) : new ProviderError(detail, false, true);
      return isFetchNetworkFailure(e) ? ProviderError.network(detail) : new ProviderError(detail, true);
    };
    try {
      let res: Response;
      try {
        // plan 22: the People API and userinfo go through the same token and deadlines (absolute URLs)
        res = await netFetch(path.startsWith("https://") ? path : `${ep.api}${path}`, { ...request, signal: deadline.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...request.headers } });
      } catch (e) {
        throw failed(e);
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        tokens.invalidate(token);
        // a fresh token refused as well: the grant is gone, the user signs in again (ops wait for it)
        if (retried) throw new ProviderAuthError(L("errors.gmail.revoked"));
        return await api<T>(path, init, true);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && isRateLimit(text));
        throw new GmailApiError(res.status, text, retryable, Boolean(sending && res.status >= 500));
      }
      if (responseMode === "void") {
        await res.body?.cancel().catch(() => {});
        return undefined as T;
      }
      try {
        return (await res.json()) as T;
      } catch (e) {
        // The request was accepted; a send whose answer can't be read has an unknown outcome (no resend).
        if (sending) throw new ProviderError(`Unreadable response after a successful request: ${e instanceof Error ? e.message : e}`, false, true);
        // a read whose body stopped coming (the deadline, a reset, a dead socket) is safe to repeat
        throw failed(e);
      }
    } finally {
      deadline.done();
    }
  }

  async function fetchFull(ids: string[]): Promise<IncomingMessage[]> {
    const out: IncomingMessage[] = [];
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        let m: GmailMessage;
        try {
          m = await api<GmailMessage>(`/messages/${id}?format=raw`);
        } catch (error) {
          // Enumeration isn't a snapshot: a message may disappear before its download.
          if (error instanceof GmailApiError && error.status === 404) continue;
          throw error;
        }
        const parsed = await parseRaw(fromBase64url(m.raw ?? ""));
        const labels = m.labelIds ?? [];
        const st = labelState(labels);
        out.push({
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
          bodyState: "full",
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
          attachments: parsed.attachments,
        });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return out;
  }

  async function fullSync(sink: SyncSink) {
    const profile = await api<{ historyId: string }>("/profile");
    const after = Math.floor(sink.windowStart / 1000);
    const freshlyIngested = new Set<string>();
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ q: `after:${after}`, maxResults: "500", includeSpamTrash: "true" });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q}`);
      const pageIds = (page.messages ?? []).map((m) => m.id);
      const ids: string[] = [];
      for (const id of pageIds) if (!(await store.messageByProviderId(id))) ids.push(id);
      for (let i = 0; i < ids.length; i += 50) {
        if (sink.signal.aborted) return;
        const batch = ids.slice(i, i + 50);
        await sink.ingest(await fetchFull(batch));
        for (const id of batch) freshlyIngested.add(id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    // A resync (history expired) must also refresh what we already had: labels may have
    // changed and messages may have been deleted during the gap.
    const cached = await store.syncedMessages();
    // Every cached message is checked (also ones older than the window): explicit 404s are
    // deletions; any other failure aborts before the cursor advances, so nothing is skipped.
    const updates: FlagUpdate[] = [];
    const gone: number[] = [];
    const queue = cached.filter((m) => !freshlyIngested.has(m.providerMsgId));
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let m = queue.shift(); m; m = queue.shift()) {
          try {
            const full = await api<GmailMessage>(`/messages/${m.providerMsgId}?format=minimal`);
            updates.push({ messageId: m.id, flags: labelState(full.labelIds ?? []), gmailLabels: full.labelIds ?? [] });
          } catch (e) {
            if (e instanceof GmailApiError && e.status === 404) gone.push(m.id);
            else throw e;
          }
        }
      }),
    );
    if (updates.length) await sink.updateFlags(updates);
    if (gone.length) await sink.removeMessages(gone);
    await ctx.saveCursor({ historyId: profile.historyId } satisfies Cursor);
  }

  async function incremental(sink: SyncSink, cursor: Cursor) {
    const added = new Set<string>();
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let pageToken: string | undefined;
    let latest = cursor.historyId;
    do {
      const q = new URLSearchParams({ startHistoryId: cursor.historyId, maxResults: "500" });
      for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) q.append("historyTypes", t);
      if (pageToken) q.set("pageToken", pageToken);
      const page = await api<{ history?: { messagesAdded?: { message: GmailMessage }[]; messagesDeleted?: { message: GmailMessage }[]; labelsAdded?: { message: GmailMessage }[]; labelsRemoved?: { message: GmailMessage }[] }[]; historyId: string; nextPageToken?: string }>(`/history?${q}`).catch((error: unknown) => {
        if (error instanceof GmailApiError && error.status === 404) throw new ExpiredHistory();
        throw error;
      });
      for (const h of page.history ?? []) {
        for (const a of h.messagesAdded ?? []) added.add(a.message.id);
        for (const d of h.messagesDeleted ?? []) deleted.add(d.message.id);
        for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) changed.add(l.message.id);
      }
      latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);

    const known = async (id: string) => (await store.messageByProviderId(id))?.id;
    const toFetch: string[] = [];
    for (const id of added) if (!deleted.has(id) && !(await known(id))) toFetch.push(id);
    for (let i = 0; i < toFetch.length; i += 50) await sink.ingest(await fetchFull(toFetch.slice(i, i + 50)));

    const updates: FlagUpdate[] = [];
    for (const gid of changed) {
      if (deleted.has(gid)) continue;
      const local = await known(gid);
      if (!local) continue;
      try {
        const m = await api<GmailMessage>(`/messages/${gid}?format=minimal`);
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

  return {
    async verify() {
      await api("/profile");
    },

    photos(want, signal) {
      return collectGooglePhotos((url, sig) => api(url, { signal: sig }), ep.userinfo, want, signal);
    },

    async sync(sink) {
      const cursor = await ctx.loadCursor<Cursor>();
      if (!cursor) return fullSync(sink);
      try {
        await incremental(sink, cursor);
      } catch (e) {
        // History records expire (~1 week): Google answers 404 and a full resync is required.
        if (e instanceof ExpiredHistory) {
          await ctx.saveCursor(null);
          return fullSync(sink);
        }
        throw e;
      }
    },

    async execute(op: ProviderOp) {
      if (op.kind === "send") {
        const payload = op.payload as SendPayload;
        const raw = await options.buildRaw(payload);
        const res = await api<{ id: string; threadId?: string }>("/messages/send", {
          method: "POST",
          body: JSON.stringify({ raw: toBase64url(raw), threadId: payload.providerThreadId ?? undefined }),
          ambiguousOnFailure: true,
        });
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

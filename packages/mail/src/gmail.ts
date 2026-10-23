import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { placeholders, type IncomingMessage } from "@unica/db";
import { buildRaw } from "./compose";
import { parseRaw } from "./mime";
import { ProviderError, type FlagUpdate, type GmailConnectResult, type MailProvider, type ProviderContext, type ProviderOp, type SendPayload, type SyncSink } from "./types";

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

const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"];
const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ───────────────────────────── OAuth (installed app, PKCE, loopback) ─────────────────────────────

export interface ConnectOptions {
  clientId: string;
  clientSecret: string | null;
  openExternal: (url: string) => Promise<void>;
  signal?: AbortSignal;
  endpoints?: Partial<GmailEndpoints>;
  timeoutMs?: number;
  /** the backend's network-policy fetch (purpose "mail") */
  fetch: typeof fetch;
}

/**
 * RFC 8252 flow: a one-shot HTTP listener on 127.0.0.1:<random>, PKCE S256 and
 * a random state. The redirect is accepted only with the matching state.
 */
export async function connectGmail(options: ConnectOptions): Promise<GmailConnectResult> {
  const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const netFetch = options.fetch;
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  let server: Server | null = null;
  try {
    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProviderError("Google sign-in timed out", false)), options.timeoutMs ?? 300_000);
      options.signal?.addEventListener("abort", () => reject(new ProviderError("Sign-in cancelled", false)));
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") return void res.writeHead(404).end();
        const done = (ok: boolean, msg: string) => {
          res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px -apple-system;padding:40px;text-align:center"><h2>${ok ? "Cuenta conectada ✓" : "No se pudo conectar"}</h2><p>${msg}</p></body>`);
        };
        if (url.searchParams.get("state") !== state) {
          done(false, "Solicitud inválida.");
          return; // ignore forged/stale redirects, keep waiting for the real one
        }
        clearTimeout(timer);
        const error = url.searchParams.get("error");
        if (error) {
          done(false, "Permiso denegado.");
          reject(new ProviderError(error === "access_denied" ? "Google access was denied" : `Google error: ${error}`, false));
          return;
        }
        done(true, "Ya puedes volver a Única.");
        const port = (server!.address() as AddressInfo).port;
        resolve({ code: url.searchParams.get("code") ?? "", redirectUri: `http://127.0.0.1:${port}/callback` });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        const params = new URLSearchParams({
          client_id: options.clientId,
          redirect_uri: `http://127.0.0.1:${port}/callback`,
          response_type: "code",
          scope: SCOPES.join(" "),
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        });
        void options.openExternal(`${ep.auth}?${params}`).catch(reject);
      });
    });
    const body = new URLSearchParams({ client_id: options.clientId, code: code.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: code.redirectUri });
    if (options.clientSecret) body.set("client_secret", options.clientSecret);
    const tokenRes = await netFetch(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!tokenRes.ok || !tokens.access_token || !tokens.refresh_token) throw new ProviderError(`Token exchange failed: ${tokens.error ?? tokenRes.status}`, false);
    const profile = (await (await netFetch(`${ep.api}/profile`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as { emailAddress: string };
    const info = (await netFetch(ep.userinfo, { headers: { authorization: `Bearer ${tokens.access_token}` } }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as { name?: string };
    return { email: profile.emailAddress, name: info.name ?? "", refreshToken: tokens.refresh_token };
  } finally {
    (server as Server | null)?.close();
  }
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
  archive: { remove: ["INBOX"] },
  spam: { add: ["SPAM"], remove: ["INBOX"] },
  notSpam: { add: ["INBOX"], remove: ["SPAM"] },
  markRead: { remove: ["UNREAD"] },
  markUnread: { add: ["UNREAD"] },
  star: { add: ["STARRED"] },
  unstar: { remove: ["STARRED"] },
};

export function createGmailProvider(ctx: ProviderContext, options: { endpoints?: Partial<GmailEndpoints> } = {}): MailProvider {
  const ep = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const netFetch = ctx.fetch;
  const db = ctx.db;
  const accountId = ctx.account.id;
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  /** One refresh at a time: concurrent 401s share the same in-flight refresh. */
  function refresh(): Promise<string> {
    refreshing ??= (async () => {
      try {
        const refreshToken = await ctx.getSecret("refreshToken");
        if (!refreshToken) throw new ProviderError("Gmail account needs to be reconnected", false);
        const settings = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'app'");
        const clientId = settings ? (JSON.parse(settings.value_json) as { gmailClientId?: string }).gmailClientId : undefined;
        const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId ?? "" });
        const secret = await ctx.getAppSecret("gmailClientSecret").catch(() => null);
        if (secret) body.set("client_secret", secret);
        let res: Response;
        try {
          res = await netFetch(ep.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
        } catch (e) {
          throw new ProviderError(`Network error refreshing Gmail token: ${e instanceof Error ? e.message : e}`, true);
        }
        const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
        if (!res.ok || !json.access_token) {
          throw new ProviderError(json.error === "invalid_grant" ? "Gmail access was revoked; reconnect the account" : `Gmail token refresh failed (${res.status})`, res.status >= 500);
        }
        access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 };
        return json.access_token;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function api<T>(path: string, init: RequestInit & { ambiguousOnFailure?: boolean } = {}, retried = false): Promise<T> {
    const token = access && access.expiresAt > Date.now() ? access.token : await refresh();
    let res: Response;
    try {
      res = await netFetch(`${ep.api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
    } catch (e) {
      throw new ProviderError(`Network error: ${e instanceof Error ? e.message : e}`, !init.ambiguousOnFailure, init.ambiguousOnFailure);
    }
    if (res.status === 401 && !retried) {
      access = null;
      return api<T>(path, init, true);
    }
    if (res.ok && init.ambiguousOnFailure) {
      // The request was accepted; if the body can't be read we don't know the outcome (no resend).
      try {
        return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
      } catch (e) {
        throw new ProviderError(`Unreadable response after a successful request: ${e instanceof Error ? e.message : e}`, false, true);
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new ProviderError(`Gmail API ${res.status}: ${text.slice(0, 200)}`, res.status === 429 || res.status >= 500, Boolean(init.ambiguousOnFailure && res.status >= 500));
      (err as ProviderError & { status: number }).status = res.status;
      throw err;
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async function fetchFull(ids: string[]): Promise<IncomingMessage[]> {
    const out: IncomingMessage[] = [];
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const m = await api<GmailMessage>(`/messages/${id}?format=raw`);
        const parsed = await parseRaw(Buffer.from(m.raw ?? "", "base64url"));
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
      const ids = pageIds.filter((id) => !db.get("SELECT 1 FROM messages WHERE account_id = ? AND provider_msg_id = ?", accountId, id));
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
    const cached = db.all<{ id: number; provider_msg_id: string; date: number }>(
      "SELECT id, provider_msg_id, date FROM messages WHERE account_id = ? AND provider_msg_id NOT LIKE 'local:%'",
      accountId,
    );
    // Every cached message is checked (also ones older than the window): explicit 404s are
    // deletions; any other failure aborts before the cursor advances, so nothing is skipped.
    const updates: FlagUpdate[] = [];
    const gone: number[] = [];
    const queue = cached.filter((m) => !freshlyIngested.has(m.provider_msg_id));
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let m = queue.shift(); m; m = queue.shift()) {
          try {
            const full = await api<GmailMessage>(`/messages/${m.provider_msg_id}?format=minimal`);
            updates.push({ messageId: m.id, flags: labelState(full.labelIds ?? []) });
          } catch (e) {
            if ((e as { status?: number }).status === 404) gone.push(m.id);
            else throw e;
          }
        }
      }),
    );
    if (updates.length) await sink.updateFlags(updates);
    if (gone.length) await sink.removeMessages(gone);
    ctx.saveCursor({ historyId: profile.historyId } satisfies Cursor);
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
      const page = await api<{ history?: { messagesAdded?: { message: GmailMessage }[]; messagesDeleted?: { message: GmailMessage }[]; labelsAdded?: { message: GmailMessage }[]; labelsRemoved?: { message: GmailMessage }[] }[]; historyId: string; nextPageToken?: string }>(`/history?${q}`);
      for (const h of page.history ?? []) {
        for (const a of h.messagesAdded ?? []) added.add(a.message.id);
        for (const d of h.messagesDeleted ?? []) deleted.add(d.message.id);
        for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) changed.add(l.message.id);
      }
      latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);

    const known = (id: string) => db.get<{ id: number }>("SELECT id FROM messages WHERE account_id = ? AND provider_msg_id = ?", accountId, id)?.id;
    const toFetch = [...added].filter((id) => !deleted.has(id) && !known(id));
    for (let i = 0; i < toFetch.length; i += 50) await sink.ingest(await fetchFull(toFetch.slice(i, i + 50)));

    const updates: FlagUpdate[] = [];
    for (const gid of changed) {
      if (deleted.has(gid)) continue;
      const local = known(gid);
      if (!local) continue;
      try {
        const m = await api<GmailMessage>(`/messages/${gid}?format=minimal`);
        updates.push({ messageId: local, flags: labelState(m.labelIds ?? []) });
      } catch (e) {
        if ((e as { status?: number }).status === 404) deleted.add(gid);
        else throw e;
      }
    }
    if (updates.length) await sink.updateFlags(updates);
    const removals = [...deleted].map(known).filter((x): x is number => x !== undefined);
    if (removals.length) await sink.removeMessages(removals);
    ctx.saveCursor({ historyId: latest } satisfies Cursor);
  }

  return {
    async verify() {
      await api("/profile");
    },

    async sync(sink) {
      const cursor = ctx.loadCursor<Cursor>();
      if (!cursor) return fullSync(sink);
      try {
        await incremental(sink, cursor);
      } catch (e) {
        // History records expire (~1 week): Google answers 404 and a full resync is required.
        if ((e as { status?: number }).status === 404) {
          ctx.saveCursor(null);
          return fullSync(sink);
        }
        throw e;
      }
    },

    async execute(op: ProviderOp) {
      if (op.kind === "send") {
        const payload = op.payload as SendPayload;
        const raw = await buildRaw(payload, { keepBcc: true });
        const res = await api<{ id: string; threadId?: string }>("/messages/send", {
          method: "POST",
          body: JSON.stringify({ raw: raw.toString("base64url"), threadId: payload.providerThreadId ?? undefined }),
          ambiguousOnFailure: true,
        });
        return { providerMsgId: res.id, providerThreadId: res.threadId };
      }
      const ids = op.target.messageIds ?? [];
      if (!ids.length) return;
      const gmailIds = db
        .all<{ provider_msg_id: string }>(`SELECT provider_msg_id FROM messages WHERE id IN (${placeholders(ids.length)}) AND provider_msg_id NOT LIKE 'local:%'`, ...ids)
        .map((r) => r.provider_msg_id);
      if (!gmailIds.length) return;
      if (op.kind === "trash") {
        for (const id of gmailIds) await api(`/messages/${id}/trash`, { method: "POST" });
        return;
      }
      if (op.kind === "moveToInbox") {
        for (const id of gmailIds) await api(`/messages/${id}/untrash`, { method: "POST" }).catch(() => undefined);
        await api("/messages/batchModify", { method: "POST", body: JSON.stringify({ ids: gmailIds, addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }) });
        return;
      }
      const labels = LABEL_OPS[op.kind];
      if (!labels) throw new ProviderError(`Unsupported operation ${op.kind}`, false);
      for (let i = 0; i < gmailIds.length; i += 1000) {
        await api("/messages/batchModify", { method: "POST", body: JSON.stringify({ ids: gmailIds.slice(i, i + 1000), addLabelIds: labels.add ?? [], removeLabelIds: labels.remove ?? [] }) });
      }
    },

    async close() {},
  };
}

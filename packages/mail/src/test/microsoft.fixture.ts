// Plan 259: a synthetic Microsoft identity platform and Graph, for the mail and backend tests: the app registration's
// redirect matched as Entra does, PKCE checked, public clients (a secret is refused), rotating refresh tokens, an
// id_token with oid and tid, a mailbox probe, and (stage 2a) a Graph mailbox: well-known folders and folders of the
// person's own, messages with MIME, per-folder delta rounds (nextLink, deltaLink, `@removed` when a message leaves a
// folder, 410 or syncStateNotFound once a folder's links expire), listings newest first, `$search`, throttling with a
// Retry-After, and a count of requests at once.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MicrosoftEndpoints } from "../microsoft";
import { CONSUMER_TENANT } from "../microsoft-scopes";

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unb64url = (value: string): Record<string, unknown> | null => {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return null; }
};

export interface GraphFolderFixture { id: string; displayName: string; parentFolderId: string; wellKnown?: string; searchFolder?: boolean }
export interface GraphMessageFixture {
  id: string;
  folder: string;
  received: number;
  isRead: boolean;
  flag: "notFlagged" | "flagged" | "complete";
  isDraft: boolean;
  subject: string;
  from: string;
  body: string;
  /** the raw source, when a test gives its own (else one is built) */
  mime?: string;
}
interface Change { seq: number; folder: string; id: string; kind: "read" | "other" }

export class SyntheticMicrosoft {
  clientId = "00000000-0000-0000-0000-00000000c11e";
  /** every app registration this Microsoft knows (the build's, and any it carried before) */
  clients = new Set([this.clientId]);
  /** the registration's redirect: Entra ignores a localhost redirect's port, never its path */
  registeredRedirect = "http://localhost";
  /** who signs in on the consent screen */
  mail: string | null = "ana@contoso.com";
  userPrincipalName = "ana@contoso.com";
  displayName: string | null = "Ana Ruiz";
  tid = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  oid = "11111111-2222-3333-4444-555555555555";
  /** whether the account has an Exchange Online mailbox */
  mailbox = true;
  /** the token response's scope (undefined: omitted) */
  grantedScope: string | undefined = "openid profile email https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read";
  /** the next token answer, once (an error status and body) */
  tokenFailure: { status: number; body: unknown } | null = null;
  /** the token endpoint answers with a 307 to this URL instead */
  tokenRedirect: string | null = null;
  /** a Graph path answered with a 307 to the URL this returns (none: answered) */
  graphRedirect: ((path: string) => string | null) | null = null;
  /** the Graph paths asked, in order */
  graphRequests: string[] = [];
  /** the Graph requests asked, path and query, in order (stage 2a) */
  graphUrls: string[] = [];
  /** id_token claims replaced (another audience, issuer, expiry) */
  claims: Record<string, unknown> = {};
  refreshTokens = new Set<string>();
  /** what each authorize request asked */
  authorizations: URLSearchParams[] = [];
  /** what each token request sent */
  tokenRequests: URLSearchParams[] = [];
  refreshCalls = 0;
  url = "";

  // ── the Graph mailbox (stage 2a) ──
  folders = new Map<string, GraphFolderFixture>();
  messages = new Map<string, GraphMessageFixture>();
  /** Graph requests that came without `Prefer: IdType="ImmutableId"` */
  missingPrefer: string[] = [];
  /** the most Graph mail requests answered at once */
  maxInflight = 0;
  /** `$value` answers wait for this, when set */
  valueGate: Promise<void> | null = null;
  /** the next matching requests are throttled: a 429 (or a 503) with this Retry-After */
  throttle: { status: 429 | 503; retryAfter?: string; match?: RegExp; times: number } | null = null;
  /** how an expired link is refused: 410 Gone, or a 400 with error.code syncStateNotFound */
  expiry: "gone" | "syncStateNotFound" = "gone";
  /** the default page size when a request names none */
  defaultPage = 10;
  /** what a filtered delta's first round names at most (Graph's 5,000) */
  deltaCap = 5000;
  /** called with each Graph mail request's path and query before it's answered (a test changes the mailbox mid-pass) */
  onRequest: ((pathAndQuery: string) => void) | null = null;
  /** a 401's body is held until this settles (the answer stays open) */
  unauthorizedGate: Promise<void> | null = null;
  /** a first round's messages, kept for its pages */
  private rounds = new Map<number, string[]>();
  private roundSeq = 0;
  private inflight = 0;
  private changes: Change[] = [];
  private changeSeq = 0;
  /** per folder: links issued at or before this change are expired */
  private expiredAt = new Map<string, number>();
  private folderSeq = 0;
  private messageSeq = 0;

  private challenges = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  private access = new Set<string>();
  private seq = 0;
  private server = createServer((req, res) => void this.handle(req, res));

  constructor() {
    const root = "root-id";
    this.folders.set(root, { id: root, displayName: "Top of Information Store", parentFolderId: "", wellKnown: "msgfolderroot" });
    for (const [id, wellKnown, displayName] of [["inbox-id", "inbox", "Inbox"], ["sent-id", "sentitems", "Sent Items"], ["drafts-id", "drafts", "Drafts"], ["trash-id", "deleteditems", "Deleted Items"], ["junk-id", "junkemail", "Junk Email"], ["archive-id", "archive", "Archive"], ["outbox-id", "outbox", "Outbox"]] as const) {
      this.folders.set(id, { id, displayName, parentFolderId: root, wellKnown });
    }
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  endpoints(): MicrosoftEndpoints {
    return { authorize: `${this.url}/common/oauth2/v2.0/authorize`, token: `${this.url}/common/oauth2/v2.0/token`, graph: `${this.url}/v1.0` };
  }

  /** a personal account: the consumer tenant, and no `mail` */
  personal(address = "ana@outlook.com"): this {
    this.tid = CONSUMER_TENANT;
    this.mail = null;
    this.userPrincipalName = address;
    return this;
  }

  /** a live access token, as a refresh would give one */
  accessToken(): string {
    const access = `access-${++this.seq}`;
    this.access.add(access);
    return access;
  }

  // ── mailbox changes, each logged for the deltas ──

  folder(displayName: string, parentFolderId = "root-id"): string {
    const id = `AQMkFolder${++this.folderSeq}`;
    this.folders.set(id, { id, displayName, parentFolderId });
    return id;
  }

  deliver(folder: string, o: Partial<Omit<GraphMessageFixture, "id" | "folder">> = {}): string {
    const id = `AAMkMsg${String(++this.messageSeq).padStart(6, "0")}=`;
    const n = this.messageSeq;
    this.messages.set(id, { id, folder, received: o.received ?? Date.now(), isRead: o.isRead ?? false, flag: o.flag ?? "notFlagged", isDraft: o.isDraft ?? false, subject: o.subject ?? `Message ${n}`, from: o.from ?? "sender@example.test", body: o.body ?? `Body ${n}`, ...(o.mime !== undefined && { mime: o.mime }) });
    this.changed(folder, id);
    return id;
  }

  move(id: string, folder: string): void {
    const m = this.messages.get(id)!;
    const from = m.folder;
    m.folder = folder;
    this.changed(from, id);
    this.changed(folder, id);
  }

  setRead(id: string, isRead: boolean): void {
    const m = this.messages.get(id)!;
    m.isRead = isRead;
    this.changed(m.folder, id, "read");
  }

  setFlag(id: string, flag: GraphMessageFixture["flag"]): void {
    const m = this.messages.get(id)!;
    m.flag = flag;
    this.changed(m.folder, id);
  }

  /** gone for good (a permanent delete) */
  destroy(id: string): void {
    const m = this.messages.get(id)!;
    this.messages.delete(id);
    this.changed(m.folder, id);
  }

  /** deleted for good, with everything in it (no change is logged: its links now 404) */
  deleteFolder(id: string): void {
    this.folders.delete(id);
    for (const [key, m] of this.messages) if (m.folder === id) this.messages.delete(key);
  }

  /** every link this folder handed out so far is refused from now on */
  expireDelta(folder: string): void {
    this.expiredAt.set(folder, this.changeSeq);
  }

  mimeOf(m: GraphMessageFixture): string {
    return m.mime ?? `From: ${m.from}\r\nTo: ana@contoso.com\r\nSubject: ${m.subject}\r\nMessage-ID: <${m.id.replace(/=/g, "")}@example.test>\r\nDate: ${new Date(m.received).toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.body}`;
  }

  private changed(folder: string, id: string, kind: Change["kind"] = "other"): void {
    this.changes.push({ seq: ++this.changeSeq, folder, id, kind });
  }

  /**
   * Acts as the person's browser on the sign-in page: approves, denies, or returns an error with its description
   * (an administrator's refusal). A request Microsoft refuses before its page (AADSTS50011: a redirect the registration
   * doesn't have; prompt beside login_hint) never comes back.
   */
  browser(behaviour: "approve" | "deny" | { error: string; description?: string } = "approve") {
    return async (authorizeUrl: string) => {
      const url = new URL(authorizeUrl);
      this.authorizations.push(url.searchParams);
      const redirect = url.searchParams.get("redirect_uri")!;
      const asked = new URL(redirect), registered = new URL(this.registeredRedirect);
      if (asked.protocol !== registered.protocol || asked.hostname !== registered.hostname || redirect.replace(/:\d+/, "") !== this.registeredRedirect) throw new Error("AADSTS50011: the redirect URI doesn't match the app's");
      if (url.searchParams.has("prompt") && url.searchParams.has("login_hint")) throw new Error("AADSTS: prompt and login_hint together");
      const clientId = url.searchParams.get("client_id")!;
      if (!this.clients.has(clientId)) throw new Error("AADSTS700016: application not found");
      const state = url.searchParams.get("state")!;
      const code = `code-${++this.seq}`;
      this.challenges.set(code, { challenge: url.searchParams.get("code_challenge")!, redirectUri: redirect, clientId });
      const answer = behaviour === "approve" ? `code=${code}` : behaviour === "deny" ? "error=access_denied&error_description=AADSTS65004%3A+User+declined+to+consent"
        : `error=${encodeURIComponent(behaviour.error)}${behaviour.description ? `&error_description=${encodeURIComponent(behaviour.description)}` : ""}`;
      setTimeout(() => void fetch(`${redirect}/?${answer}&state=${encodeURIComponent(state)}`).catch(() => {}), 5);
    };
  }

  /** the id_token Microsoft returns beside the tokens (unsigned here: it reaches Terno straight from the token endpoint) */
  idToken(clientId: string): string {
    const claims = { aud: clientId, iss: `https://login.microsoftonline.com/${this.tid}/v2.0`, exp: Math.floor(Date.now() / 1000) + 3600, tid: this.tid, oid: this.oid, preferred_username: this.userPrincipalName, ...this.claims };
    return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.c2ln`;
  }

  private grant(clientId: string): Record<string, unknown> {
    const access = `access-${++this.seq}`;
    const refresh = `refresh-${this.seq}`;
    this.access.add(access);
    this.refreshTokens.add(refresh);
    return { token_type: "Bearer", expires_in: 3600, access_token: access, refresh_token: refresh, id_token: this.idToken(clientId), ...(this.grantedScope !== undefined && { scope: this.grantedScope }) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/common/oauth2/v2.0/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      this.tokenRequests.push(form);
      if (this.tokenRedirect) return void res.writeHead(307, { location: this.tokenRedirect }).end();
      if (this.tokenFailure) {
        const failure = this.tokenFailure;
        this.tokenFailure = null;
        return json(failure.status, failure.body);
      }
      // a public client: no secret, one of the app registrations
      const clientId = form.get("client_id") ?? "";
      if (form.has("client_secret") || !this.clients.has(clientId)) return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const issued = this.challenges.get(form.get("code") ?? "");
        this.challenges.delete(form.get("code") ?? "");
        const computed = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!issued || issued.challenge !== computed || issued.redirectUri !== form.get("redirect_uri") || issued.clientId !== clientId) return json(400, { error: "invalid_grant" });
        return json(200, this.grant(clientId));
      }
      if (form.get("grant_type") === "refresh_token") {
        this.refreshCalls++;
        if (!this.refreshTokens.has(form.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant", error_description: "AADSTS70008: The refresh token has expired." });
        // each use returns a new refresh token; the one presented isn't revoked by it
        return json(200, this.grant(clientId));
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname.startsWith("/v1.0/")) {
      this.graphRequests.push(url.pathname);
      this.graphUrls.push(`${url.pathname}${url.search}`);
      if (!/IdType="ImmutableId"/.test(String(req.headers.prefer ?? ""))) this.missingPrefer.push(url.pathname);
      const redirect = this.graphRedirect?.(url.pathname);
      if (redirect) return void res.writeHead(307, { location: redirect }).end();
    }
    const authorized = this.access.has((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!authorized && url.pathname.startsWith("/v1.0/me") && this.unauthorizedGate) {
      this.inflight++;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      res.once("close", () => { this.inflight--; });
      res.writeHead(401, { "content-type": "application/json" });
      res.flushHeaders();
      await this.unauthorizedGate;
      return void res.end(JSON.stringify({ error: { code: "InvalidAuthenticationToken" } }));
    }
    if (url.pathname === "/v1.0/me") {
      if (!authorized) return json(401, { error: { code: "InvalidAuthenticationToken" } });
      return json(200, { id: "graph-id", mail: this.mail, userPrincipalName: this.userPrincipalName, displayName: this.displayName });
    }
    if (url.pathname.startsWith("/v1.0/me/")) {
      if (!authorized) return json(401, { error: { code: "InvalidAuthenticationToken" } });
      if (!this.mailbox) return json(404, { error: { code: "MailboxNotEnabledForRESTAPI" } });
      const throttle = this.throttle;
      if (throttle && throttle.times > 0 && (!throttle.match || throttle.match.test(`${url.pathname}${url.search}`))) {
        throttle.times--;
        res.writeHead(throttle.status, { "content-type": "application/json", ...(throttle.retryAfter !== undefined && { "retry-after": throttle.retryAfter }) });
        return void res.end(JSON.stringify({ error: { code: throttle.status === 429 ? "TooManyRequests" : "ServiceUnavailable" } }));
      }
      this.onRequest?.(`${url.pathname}${url.search}`);
      this.inflight++;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      res.once("close", () => { this.inflight--; });
      try { return await this.graph(req, url, json, res); }
      catch { if (!res.headersSent) json(500, { error: { code: "generalException" } }); }
      return;
    }
    res.writeHead(404).end();
  }

  // ── Graph's mail API, as much of it as the provider reads ──

  private envelope(m: GraphMessageFixture, extra: string[] = []): Record<string, unknown> {
    return {
      "@odata.etag": `W/"${m.id}"`, id: m.id, receivedDateTime: new Date(m.received).toISOString(), isRead: m.isRead, isDraft: m.isDraft, flag: { flagStatus: m.flag }, parentFolderId: m.folder,
      ...(extra.includes("subject") && { subject: m.subject }),
      ...(extra.includes("from") && { from: { emailAddress: { name: "", address: m.from } } }),
    };
  }

  private folderOf(key: string): GraphFolderFixture | undefined {
    return this.folders.get(key) ?? [...this.folders.values()].find((f) => f.wellKnown === key);
  }

  private pageSize(req: IncomingMessage, url: URL): number {
    const prefer = /odata\.maxpagesize=(\d+)/.exec(String(req.headers.prefer ?? ""))?.[1];
    return Number(url.searchParams.get("$top") ?? prefer ?? this.defaultPage);
  }

  private link(path: string, token: Record<string, unknown>, kind: "$skiptoken" | "$deltatoken"): string {
    return `${this.url}/v1.0${path}?${kind}=${b64url(token)}`;
  }

  /** `receivedDateTime ge X` (and `lt Y`) */
  private window(filter: string | null): { from: number; until: number } {
    const ge = filter ? /receivedDateTime ge (\S+)/.exec(filter)?.[1] : undefined;
    const lt = filter ? /receivedDateTime lt (\S+)/.exec(filter)?.[1] : undefined;
    return { from: ge ? Date.parse(ge) : -Infinity, until: lt ? Date.parse(lt) : Infinity };
  }

  private listing(all: GraphMessageFixture[], req: IncomingMessage, url: URL, path: string, json: (status: number, data: unknown) => void, extra: Record<string, unknown> = {}) {
    const token = url.searchParams.get("$skiptoken");
    const state = token ? unb64url(token) : { filter: url.searchParams.get("$filter"), skip: 0, top: this.pageSize(req, url), ...extra };
    if (!state) return json(400, { error: { code: "badRequest" } });
    const { from, until } = this.window(state.filter as string | null);
    const sorted = all.filter((m) => m.received >= from && m.received < until).sort((a, b) => b.received - a.received || (a.id < b.id ? -1 : 1));
    const skip = state.skip as number, top = state.top as number;
    const page = sorted.slice(skip, skip + top);
    return json(200, { value: page.map((m) => this.envelope(m)), ...(skip + top < sorted.length && { "@odata.nextLink": this.link(path, { ...state, skip: skip + top }, "$skiptoken") }) });
  }

  private delta(folder: GraphFolderFixture, req: IncomingMessage, url: URL, json: (status: number, data: unknown) => void) {
    const path = `/me/mailFolders/${encodeURIComponent(folder.id)}/messages/delta`;
    const token = url.searchParams.get("$skiptoken") ?? url.searchParams.get("$deltatoken");
    const size = this.pageSize(req, url);
    let state: Record<string, unknown>;
    if (token) {
      const read = unb64url(token);
      if (!read || read.folder !== folder.id) return json(400, { error: { code: "badRequest" } });
      state = read;
      if ((state.issued as number) <= (this.expiredAt.get(folder.id) ?? -1)) {
        return this.expiry === "gone" ? json(410, { error: { code: "resyncRequired" } }) : json(400, { error: { code: "badRequest", innerError: { code: "syncStateNotFound" } } });
      }
      // a saved deltaLink starts a new round from where the last ended
      if (url.searchParams.has("$deltatoken")) state = { folder: folder.id, filter: state.filter, since: state.upto, upto: this.changeSeq, skip: 0, issued: this.changeSeq };
    } else state = { folder: folder.id, filter: url.searchParams.get("$filter"), since: null, upto: this.changeSeq, skip: 0, issued: this.changeSeq };
    const { from } = this.window(state.filter as string | null);
    let entries: (Record<string, unknown> | null)[];
    if (state.since === null) {
      // the first round: what's in the folder as it began, at most 5,000 with a filter (delta-query-messages), the newest
      if (state.round === undefined) {
        const now = [...this.messages.values()].filter((m) => m.folder === folder.id && m.received >= from).sort((a, b) => b.received - a.received || (a.id < b.id ? -1 : 1));
        state = { ...state, round: ++this.roundSeq };
        this.rounds.set(state.round as number, (state.filter ? now.slice(0, this.deltaCap) : now).map((m) => m.id));
      }
      // (one gone since keeps its place in the pages, and isn't named)
      entries = this.rounds.get(state.round as number)!.map((id) => { const m = this.messages.get(id); return m && m.folder === folder.id ? this.envelope(m) : null; });
    } else {
      const changes = this.changes.filter((c) => c.folder === folder.id && c.seq > (state.since as number) && c.seq <= (state.upto as number));
      const ids = new Set(changes.map((c) => c.id));
      entries = [...ids].sort().map((id) => {
        const m = this.messages.get(id);
        // gone, or moved out: "@removed with reason deleted when an item is deleted or moved from the folder"
        if (!m || m.folder !== folder.id) return { "@odata.type": "#microsoft.graph.message", id, "@removed": { reason: "deleted" } };
        // outside the round's filter only a read state change is said (message-delta: "Read/unread state changes")
        if (m.received < from && !changes.some((c) => c.id === id && c.kind === "read")) return null;
        return this.envelope(m);
      });
    }
    const skip = state.skip as number;
    const page = entries.slice(skip, skip + size).filter((entry) => entry !== null);
    const more = skip + size < entries.length;
    return json(200, {
      value: page,
      ...(more ? { "@odata.nextLink": this.link(path, { ...state, skip: skip + size, issued: this.changeSeq }, "$skiptoken") } : { "@odata.deltaLink": this.link(path, { ...state, since: state.upto, skip: 0, issued: this.changeSeq }, "$deltatoken") }),
    });
  }

  private async graph(req: IncomingMessage, url: URL, json: (status: number, data: unknown) => void, res: ServerResponse): Promise<void> {
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
    const select = (url.searchParams.get("$select") ?? "").split(",");
    // /me/mailFolders, /me/mailFolders/{id}, …/childFolders, …/messages, …/messages/delta
    if (parts[0] === "mailFolders") {
      const children = (parent: string, path: string) => {
        const all = [...this.folders.values()].filter((f) => f.parentFolderId === parent);
        const token = url.searchParams.get("$skiptoken");
        const skip = token ? (unb64url(token)?.skip as number) : 0, top = this.pageSize(req, url);
        const page = all.slice(skip, skip + top).map((f) => ({ ...(f.searchFolder && { "@odata.type": "#microsoft.graph.mailSearchFolder" }), id: f.id, displayName: f.displayName, parentFolderId: f.parentFolderId, childFolderCount: [...this.folders.values()].filter((c) => c.parentFolderId === f.id).length }));
        return json(200, { value: page, ...(skip + top < all.length && { "@odata.nextLink": this.link(path, { skip: skip + top }, "$skiptoken") }) });
      };
      if (parts.length === 1) return children("root-id", "/me/mailFolders");
      const folder = this.folderOf(parts[1]!);
      if (!folder) return json(404, { error: { code: "ErrorItemNotFound" } });
      if (parts.length === 2) return json(200, { id: folder.id, displayName: folder.displayName, parentFolderId: folder.parentFolderId });
      if (parts[2] === "childFolders" && parts.length === 3) return children(folder.id, `/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders`);
      if (parts[2] === "messages" && parts.length === 3) {
        if (url.searchParams.has("$filter") && url.searchParams.has("$orderby") && url.searchParams.get("$orderby") !== "receivedDateTime desc") return json(400, { error: { code: "InefficientFilter" } });
        return this.listing([...this.messages.values()].filter((m) => m.folder === folder.id), req, url, `/me/mailFolders/${encodeURIComponent(folder.id)}/messages`, json);
      }
      if (parts[2] === "messages" && parts[3] === "delta" && parts.length === 4) return this.delta(folder, req, url, json);
      return json(400, { error: { code: "badRequest" } });
    }
    if (parts[0] === "messages") {
      if (parts.length === 1) {
        const token = url.searchParams.get("$skiptoken");
        const search = url.searchParams.get("$search") ?? (token ? (unb64url(token)?.search as string | undefined) ?? null : null);
        if (search !== null) {
          // every word must be found: a bare word anywhere, `from:`/`subject:` in that field
          const words = search.replace(/^"|"$/g, "").split(/\s+/).filter((w) => w && !/^(OR|AND)$/.test(w) && !w.startsWith("("));
          const found = [...this.messages.values()].filter((m) => words.every((w) => {
            const [property, value] = w.includes(":") ? w.split(":", 2) as [string, string] : ["", w];
            const field = property === "from" ? m.from : property === "subject" ? m.subject : property === "hasAttachments" ? "true" : `${m.subject} ${m.from} ${m.body}`;
            return field.toLowerCase().includes(value.toLowerCase());
          })).slice(0, 1000);
          return this.listing(found, req, url, "/me/messages", json, { search });
        }
        return this.listing([...this.messages.values()], req, url, "/me/messages", json);
      }
      const m = this.messages.get(parts[1]!);
      if (!m) return json(404, { error: { code: "ErrorItemNotFound" } });
      if (parts.length === 2) return json(200, this.envelope(m, select));
      if (parts[2] === "$value" && parts.length === 3) {
        if (this.valueGate) await this.valueGate;
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end(this.mimeOf(m));
      }
    }
    return json(400, { error: { code: "badRequest" } });
  }
}

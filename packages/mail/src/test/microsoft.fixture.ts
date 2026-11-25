// Plan 259: a synthetic Microsoft identity platform and Graph, for the mail and backend tests: the app registration's
// redirect matched as Entra does, PKCE checked, public clients (a secret is refused), rotating refresh tokens, an
// id_token with oid and tid, a mailbox probe, and (stage 2a) a Graph mailbox: well-known folders and folders of the
// person's own, messages with MIME, per-folder delta rounds (nextLink, deltaLink, `@removed` when a message leaves a
// folder, 410 or syncStateNotFound once a folder's links expire), listings newest first, `$search`, throttling with a
// Retry-After, and a count of requests at once. Stage 2b: the writes: PATCH and DELETE of a message, its move, folders
// created, renamed and deleted, JSON batches (with a throttled request inside one), sendMail with MIME, a draft from MIME,
// upload sessions (their PUTs refused with an Authorization header) and a draft's send, and answers lost after the
// change was made.
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
/** what reached the outside world: a sendMail's MIME, or a draft's (with the files uploaded into it) */
export interface SentFixture { via: "sendMail" | "draft"; mime: string; files: { name: string; size: number; isInline: boolean; contentId?: string; bytes: Buffer }[] }
interface UploadSession { id: string; draft: string; name: string; size: number; isInline: boolean; contentId?: string; received: Buffer[]; at: number }
type Answer = { status: number; headers?: Record<string, string>; body?: unknown };

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
  /** the smallest file an upload session takes (the page's 3 MB; tests lower it) */
  uploadMin = 3_000_000;
  /** the largest write request (Graph's 4 MB; tests lower it) */
  writeMax = 4 * 1024 * 1024;
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
  // ── stage 2b ──
  /** what was sent, in order */
  sent: SentFixture[] = [];
  /** each JSON batch's requests (method and url), in order */
  batches: { method: string; url: string }[][] = [];
  /** the next requests inside batches that match fail with this status (a throttle: 429, or 503 with a Retry-After; a refusal: 401, 403) */
  batchThrottle: { status: 429 | 503 | 401 | 403; retryAfter?: string; match?: RegExp; times: number } | null = null;
  /** requests inside batches that came without `Prefer: IdType="ImmutableId"` */
  batchMissingPrefer: string[] = [];
  /** upload PUTs that carried an Authorization header (the page says never) */
  uploadAuthorized = 0;
  /** upload PUTs, in order: session and range */
  uploads: { session: string; range: string }[] = [];
  /**
   * The change is made and its answer lost (the connection drops), for a request this matches: `method path?query`, a
   * batch's as `POST /$batch`, an upload's as `PUT /upload`. `before`: the connection drops first, nothing changed.
   */
  lose: ((request: string) => "after" | "before" | undefined) | null = null;
  /** sendMail and a draft's send wait for this, when set */
  sendGate: Promise<void> | null = null;
  /** a draft's send, made, holds its answer until this settles */
  sentGate: Promise<void> | null = null;
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
  private sessions = new Map<string, UploadSession>();
  private sessionSeq = 0;
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

  /** every refresh and access token refused from now on (the person withdrew the grant, or an administrator did) */
  revoke(): void {
    this.refreshTokens.clear();
    this.access.clear();
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

  /** deleted for good, with everything in it and every folder under it (no change is logged: its links now 404) */
  deleteFolder(id: string): void {
    for (const child of [...this.folders.values()].filter((f) => f.parentFolderId === id)) this.deleteFolder(child.id);
    this.folders.delete(id);
    for (const [key, m] of this.messages) if (m.folder === id) this.messages.delete(key);
  }

  /** a message in the folder that has its well-known name (inbox, sentitems, …) or id */
  inFolder(key: string): GraphMessageFixture[] {
    const folder = this.folderOf(key);
    return [...this.messages.values()].filter((m) => m.folder === folder?.id);
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
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const body = raw.toString("utf8");
    const losing = this.lose?.(`${req.method} ${url.pathname.startsWith("/v1.0/upload/") ? "/upload" : url.pathname.replace(/^\/v1\.0/, "")}${url.pathname.startsWith("/v1.0/upload/") ? "" : url.search}`);
    if (losing === "before") return void res.destroy();
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      if (losing === "after") return void res.destroy();
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    // "Write requests … have a size limit of 4 MB … fail with the status code HTTP 413" (use-the-api); an upload's piece too
    if (raw.length > this.writeMax && req.method !== "GET") return json(413, { error: { code: "RequestEntityTooLarge" } });
    // an upload session's PUT: its URL carries its own authorization, and the page says to send none
    if (url.pathname.startsWith("/v1.0/upload/") && req.method === "PUT") return this.uploadPut(url.pathname.slice("/v1.0/upload/".length), req, raw, json);
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
    if (url.pathname === "/v1.0/$batch" && req.method === "POST") {
      if (!authorized) return json(401, { error: { code: "InvalidAuthenticationToken" } });
      if (!this.mailbox) return json(404, { error: { code: "MailboxNotEnabledForRESTAPI" } });
      this.inflight++;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      res.once("close", () => { this.inflight--; });
      return this.batch(body, json);
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
      try { return await this.graph(req, url, json, res, body); }
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

  /** a request's JSON body (a batch's is already one) */
  private static read(body: string): Record<string, unknown> {
    try { const value = JSON.parse(body) as unknown; return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; } catch { return {}; }
  }

  /** a MIME message as Graph takes one: base64 in a text/plain body */
  private static mime(body: string): string | null {
    const text = body.trim();
    if (!/^[A-Za-z0-9+/]+=*$/.test(text)) return null;
    return Buffer.from(text, "base64").toString("utf8");
  }

  private messageFromMime(folder: string, mime: string, isDraft: boolean): string {
    const subject = /^Subject: (.*)$/m.exec(mime)?.[1] ?? "";
    const from = /^From: (?:.*<)?([^<>\s]+@[^<>\s]+?)>?$/m.exec(mime)?.[1] ?? this.userPrincipalName;
    return this.deliver(folder, { mime, subject, from, isDraft, isRead: true });
  }

  /** a message as a write's answer gives it (the whole resource: its body too) */
  private resource(m: GraphMessageFixture): Record<string, unknown> {
    return { ...this.envelope(m, ["subject", "from"]), body: { contentType: "text", content: m.body } };
  }

  private async batch(body: string, json: (status: number, data: unknown) => void): Promise<void> {
    const requests = SyntheticMicrosoft.read(body).requests;
    if (!Array.isArray(requests) || requests.length > 20) return json(400, { error: { code: "BadRequest" } });
    this.batches.push(requests.map((r: Record<string, unknown>) => ({ method: String(r.method), url: String(r.url) })));
    const responses: { id: string; status: number; headers?: Record<string, string>; body?: unknown }[] = [];
    // answered in parallel, so in any order (json-batching: "might appear in a different order"): the last first here
    for (const r of [...requests].reverse() as Record<string, unknown>[]) {
      const path = `/v1.0${String(r.url).split("?")[0]}`;
      const headers = (r.headers ?? {}) as Record<string, string>;
      if (!/IdType="ImmutableId"/.test(String(headers.prefer ?? headers.Prefer ?? ""))) this.batchMissingPrefer.push(String(r.url));
      const throttle = this.batchThrottle;
      if (throttle && throttle.times > 0 && (!throttle.match || throttle.match.test(`${r.method} ${String(r.url)}`))) {
        throttle.times--;
        responses.push({ id: String(r.id), status: throttle.status, headers: throttle.retryAfter !== undefined ? { "Retry-After": throttle.retryAfter } : {}, body: { error: { code: ({ 429: "TooManyRequests", 503: "ServiceUnavailable", 401: "InvalidAuthenticationToken", 403: "ErrorAccessDenied" } as const)[throttle.status] } } });
        continue;
      }
      this.onRequest?.(`${path}${new URL(String(r.url), "http://x").search}`);
      let answer: Answer = { status: 500 };
      const capture = (status: number, data: unknown) => { answer = { status, body: data }; };
      const fake = { method: r.method, headers: { prefer: headers.prefer ?? "" } } as unknown as IncomingMessage;
      const url = new URL(`${this.url}${path}${new URL(String(r.url), "http://x").search}`);
      try { await this.graph(fake, url, capture, null as unknown as ServerResponse, r.body === undefined ? "" : JSON.stringify(r.body)); }
      catch { answer = { status: 500, body: { error: { code: "generalException" } } }; }
      responses.push({ id: String(r.id), status: answer.status, ...(answer.body !== undefined && { body: answer.body }) });
    }
    return json(200, { responses });
  }

  private async uploadPut(id: string, req: IncomingMessage, raw: Buffer, json: (status: number, data: unknown, headers?: Record<string, string>) => void): Promise<void> {
    if (req.headers.authorization) this.uploadAuthorized++;
    const session = this.sessions.get(id);
    const range = String(req.headers["content-range"] ?? "");
    this.uploads.push({ session: id, range });
    if (!session) return json(404, { error: { code: "ErrorItemNotFound" } });
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    const have = session.received.reduce((n, b) => n + b.length, 0);
    // "You must upload bytes in a file in order"
    if (!m || Number(m[1]) !== have || Number(m[2]) - Number(m[1]) + 1 !== raw.length || Number(m[3]) !== session.size || req.headers["content-type"] !== "application/octet-stream") return json(400, { error: { code: "InvalidRange" } });
    session.received.push(raw);
    const now = have + raw.length;
    if (now < session.size) return json(200, { expirationDateTime: new Date(Date.now() + 3600_000).toISOString(), nextExpectedRanges: [`${now}-`] });
    this.sessions.delete(id);
    const draft = this.messages.get(session.draft);
    if (draft) (this.files.get(draft.id) ?? this.files.set(draft.id, []).get(draft.id)!).push({ name: session.name, size: session.size, isInline: session.isInline, ...(session.contentId && { contentId: session.contentId }), bytes: Buffer.concat(session.received) });
    return json(201, undefined, { location: `${this.url}/v1.0/me/messages/${encodeURIComponent(session.draft)}/attachments/${id}` });
  }

  /** files uploaded into each draft */
  private files = new Map<string, SentFixture["files"]>();

  private async graph(req: IncomingMessage, url: URL, json: (status: number, data: unknown) => void, res: ServerResponse, body = ""): Promise<void> {
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
    const select = (url.searchParams.get("$select") ?? "").split(",");
    const method = req.method ?? "GET";
    if (parts[0] === "sendMail" && parts.length === 1 && method === "POST") {
      const mime = SyntheticMicrosoft.mime(body);
      if (mime === null) return json(400, { error: { code: "ErrorMimeContentInvalidBase64String" } });
      if (this.sendGate) await this.sendGate;
      this.sent.push({ via: "sendMail", mime, files: [] });
      // "This method saves the message in the Sent Items folder"
      this.messageFromMime(this.folderOf("sentitems")!.id, mime, false);
      return json(202, undefined);
    }
    if (parts[0] === "messages" && parts.length === 1 && method === "POST") {
      const mime = SyntheticMicrosoft.mime(body);
      if (mime === null) return json(400, { error: { code: "ErrorMimeContentInvalidBase64String" } });
      // "By default, this operation saves the draft in the Drafts folder"
      const id = this.messageFromMime(this.folderOf("drafts")!.id, mime, true);
      return json(201, this.resource(this.messages.get(id)!));
    }
    if (parts[0] === "mailFolders" && method !== "GET") {
      const read = SyntheticMicrosoft.read(body);
      const folderAnswer = (f: GraphFolderFixture) => ({ id: f.id, displayName: f.displayName, parentFolderId: f.parentFolderId, childFolderCount: 0 });
      const taken = (parent: string, name: string, except?: string) => [...this.folders.values()].some((f) => f.id !== except && f.parentFolderId === parent && f.displayName.toLowerCase() === name.toLowerCase());
      if (method === "POST" && (parts.length === 1 || (parts.length === 3 && parts[2] === "childFolders"))) {
        const parent = parts.length === 1 ? this.folderOf("msgfolderroot")! : this.folderOf(parts[1]!);
        if (!parent) return json(404, { error: { code: "ErrorItemNotFound" } });
        if (typeof read.displayName !== "string" || !read.displayName) return json(400, { error: { code: "ErrorInvalidRequest" } });
        if (taken(parent.id, read.displayName)) return json(409, { error: { code: "ErrorFolderExists" } });
        return json(201, folderAnswer(this.folders.get(this.folder(read.displayName, parent.id))!));
      }
      const folder = parts.length === 2 ? this.folderOf(parts[1]!) : undefined;
      if (!folder) return json(404, { error: { code: "ErrorItemNotFound" } });
      if (method === "PATCH") {
        if (typeof read.displayName !== "string" || !read.displayName) return json(400, { error: { code: "ErrorInvalidRequest" } });
        if (taken(folder.parentFolderId, read.displayName, folder.id)) return json(409, { error: { code: "ErrorFolderExists" } });
        folder.displayName = read.displayName;
        return json(200, folderAnswer(folder));
      }
      if (method === "DELETE") {
        if (folder.wellKnown) return json(403, { error: { code: "ErrorDeleteDistinguishedFolder" } });
        this.deleteFolder(folder.id);
        return json(204, undefined);
      }
    }
    if (parts[0] === "messages" && parts.length >= 2 && method !== "GET") {
      const m = this.messages.get(parts[1]!);
      if (!m) return json(404, { error: { code: "ErrorItemNotFound" } });
      const read = SyntheticMicrosoft.read(body);
      if (parts.length === 2 && method === "PATCH") {
        if (typeof read.isRead === "boolean") this.setRead(m.id, read.isRead);
        const flag = read.flag as { flagStatus?: string } | undefined;
        if (flag && (flag.flagStatus === "flagged" || flag.flagStatus === "notFlagged" || flag.flagStatus === "complete")) this.setFlag(m.id, flag.flagStatus);
        return json(200, this.resource(m));
      }
      if (parts.length === 2 && method === "DELETE") {
        this.destroy(m.id);
        return json(204, undefined);
      }
      if (parts[2] === "move" && parts.length === 3 && method === "POST") {
        const to = typeof read.destinationId === "string" ? this.folderOf(read.destinationId) : undefined;
        if (!to || to.searchFolder) return json(404, { error: { code: "ErrorItemNotFound" } });
        this.move(m.id, to.id);
        // "returns 201 Created response code and a message resource"
        return json(201, this.resource(m));
      }
      if (parts[2] === "attachments" && parts.length === 3 && method === "POST") {
        // a small file with its bytes ("smaller than 3 MB": outlook-large-attachments)
        if (read["@odata.type"] !== "#microsoft.graph.fileAttachment" || typeof read.name !== "string" || typeof read.contentBytes !== "string") return json(400, { error: { code: "ErrorInvalidRequest" } });
        const bytes = Buffer.from(read.contentBytes, "base64");
        (this.files.get(m.id) ?? this.files.set(m.id, []).get(m.id)!).push({ name: read.name, size: bytes.length, isInline: read.isInline === true, ...(typeof read.contentId === "string" && { contentId: read.contentId }), bytes });
        // the documented answer repeats the file's bytes
        return json(201, { "@odata.type": "#microsoft.graph.fileAttachment", id: `att-${bytes.length}`, name: read.name, size: bytes.length, contentBytes: read.contentBytes });
      }
      if (parts[2] === "attachments" && parts[3] === "createUploadSession" && parts.length === 4 && method === "POST") {
        const item = read.AttachmentItem as Record<string, unknown> | undefined;
        if (!item || item.attachmentType !== "file" || typeof item.name !== "string" || typeof item.size !== "number") return json(400, { error: { code: "ErrorInvalidRequest" } });
        // "a file … between 3 MB and 150 MB"
        if (item.size < this.uploadMin || item.size > 150 * 1024 * 1024) return json(400, { error: { code: "ErrorAttachmentSizeShouldNotBeLessThanMinimumSize" } });
        const id = `session-${++this.sessionSeq}`;
        this.sessions.set(id, { id, draft: m.id, name: item.name, size: item.size, isInline: item.isInline === true, ...(typeof item.contentId === "string" && { contentId: item.contentId }), received: [], at: Date.now() });
        return json(201, { uploadUrl: `${this.url}/v1.0/upload/${id}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString(), nextExpectedRanges: ["0-"] });
      }
      if (parts[2] === "send" && parts.length === 3 && method === "POST") {
        if (!m.isDraft) return json(400, { error: { code: "ErrorInvalidOperation" } });
        if (this.sendGate) await this.sendGate;
        this.sent.push({ via: "draft", mime: this.mimeOf(m), files: this.files.get(m.id) ?? [] });
        m.isDraft = false;
        // "This method saves the message in the Sent Items folder"
        this.move(m.id, this.folderOf("sentitems")!.id);
        // sent, and its answer still on its way
        if (this.sentGate) await this.sentGate;
        return json(202, undefined);
      }
      return json(400, { error: { code: "badRequest" } });
    }
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

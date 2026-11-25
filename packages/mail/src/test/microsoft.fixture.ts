// Plan 259: a synthetic Microsoft identity platform and Graph /me, for the mail and backend tests (and Graph's, stage
// 2): PKCE checked, public client (a secret is refused), rotating refresh tokens, and an id_token with oid and tid.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MicrosoftEndpoints } from "../microsoft";
import { CONSUMER_TENANT } from "../microsoft-scopes";

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export class SyntheticMicrosoft {
  clientId = "00000000-0000-0000-0000-00000000c11e";
  /** who signs in on the consent screen */
  mail: string | null = "ana@contoso.com";
  userPrincipalName = "ana@contoso.com";
  displayName: string | null = "Ana Ruiz";
  tid = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  oid = "11111111-2222-3333-4444-555555555555";
  /** the token response's scope (undefined: omitted) */
  grantedScope: string | undefined = "openid profile email https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read";
  /** the next token answer, once (an error status and body) */
  tokenFailure: { status: number; body: unknown } | null = null;
  /** the id_token's audience (another client's token) */
  audience: string | null = null;
  refreshTokens = new Set<string>();
  /** what each authorize request asked */
  authorizations: URLSearchParams[] = [];
  /** what each token request sent */
  tokenRequests: URLSearchParams[] = [];
  refreshCalls = 0;
  url = "";
  private challenges = new Map<string, { challenge: string; redirectUri: string }>();
  private access = new Set<string>();
  private seq = 0;
  private server = createServer((req, res) => void this.handle(req, res));

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

  /**
   * Acts as the person's browser on the sign-in page: approves, denies, or returns an error with its description
   * (an administrator's refusal), after answering a forged redirect first when asked.
   */
  browser(behaviour: "approve" | "deny" | { error: string; description?: string } = "approve") {
    return async (authorizeUrl: string) => {
      const url = new URL(authorizeUrl);
      this.authorizations.push(url.searchParams);
      const redirect = url.searchParams.get("redirect_uri")!;
      const state = url.searchParams.get("state")!;
      const code = `code-${++this.seq}`;
      this.challenges.set(code, { challenge: url.searchParams.get("code_challenge")!, redirectUri: redirect });
      const answer = behaviour === "approve" ? `code=${code}` : behaviour === "deny" ? "error=access_denied&error_description=AADSTS65004%3A+User+declined+to+consent"
        : `error=${encodeURIComponent(behaviour.error)}${behaviour.description ? `&error_description=${encodeURIComponent(behaviour.description)}` : ""}`;
      setTimeout(() => void fetch(`${redirect}?${answer}&state=${encodeURIComponent(state)}`).catch(() => {}), 5);
    };
  }

  /** the id_token Microsoft returns beside the tokens (unsigned here: it reaches Terno straight from the token endpoint) */
  idToken(): string {
    return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ aud: this.audience ?? this.clientId, iss: `https://login.microsoftonline.com/${this.tid}/v2.0`, tid: this.tid, oid: this.oid, preferred_username: this.userPrincipalName })}.c2ln`;
  }

  private grant(): Record<string, unknown> {
    const access = `access-${++this.seq}`;
    const refresh = `refresh-${this.seq}`;
    this.access.add(access);
    this.refreshTokens.add(refresh);
    return { token_type: "Bearer", expires_in: 3600, access_token: access, refresh_token: refresh, id_token: this.idToken(), ...(this.grantedScope !== undefined && { scope: this.grantedScope }) };
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
      if (this.tokenFailure) {
        const failure = this.tokenFailure;
        this.tokenFailure = null;
        return json(failure.status, failure.body);
      }
      // a public client: no secret, its own id
      if (form.has("client_secret") || form.get("client_id") !== this.clientId) return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const issued = this.challenges.get(form.get("code") ?? "");
        this.challenges.delete(form.get("code") ?? "");
        const computed = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!issued || issued.challenge !== computed || issued.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
        return json(200, this.grant());
      }
      if (form.get("grant_type") === "refresh_token") {
        this.refreshCalls++;
        const presented = form.get("refresh_token") ?? "";
        if (!this.refreshTokens.delete(presented)) return json(400, { error: "invalid_grant", error_description: "AADSTS70008: The refresh token has expired." });
        // refresh tokens rotate on every use
        return json(200, this.grant());
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/v1.0/me") {
      if (!this.access.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) return json(401, { error: { code: "InvalidAuthenticationToken" } });
      return json(200, { id: "graph-id", mail: this.mail, userPrincipalName: this.userPrincipalName, displayName: this.displayName });
    }
    res.writeHead(404).end();
  }
}

/**
 * Gmail provider against a fake Google (OAuth + Gmail REST), driven through the
 * real Backend: PKCE/state, token refresh, sync, history, ops and send.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage as Req, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@unica/core/rpc";
import { createGmailTokenBroker, createRegistry, GMAIL_RECONNECT, type ProviderRegistry } from "@unica/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { sqlDb } from "@unica/db";

interface FakeMsg {
  id: string;
  threadId: string;
  labelIds: string[];
  raw: string;
  internalDate: number;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function rawMail(o: { subject: string; from?: string; id: string; body?: string; inReplyTo?: string }) {
  return [
    `From: ${o.from ?? "Ana <ana@example.com>"}`,
    "To: Luis <luis@gmail.com>",
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}>`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "hola",
  ].join("\r\n");
}

class FakeGoogle {
  messages = new Map<string, FakeMsg>();
  history: { id: number; added?: string[]; deleted?: string[]; labels?: string[] }[] = [];
  historyId = 1000;
  challenges = new Map<string, string>(); // code → code_challenge
  refreshCalls = 0;
  validTokens = new Set<string>();
  calls: { method: string; path: string; body: unknown }[] = [];
  rateLimitNext = 0;
  failMinimalOnce = false;
  historyExpired = false;
  sent: { raw: string; threadId?: string }[] = [];
  truncateSendResponse = false;
  /** the Google account the consent screen signs in with */
  email = "luis@gmail.com";
  loginHints: (string | null)[] = [];
  private tokenSeq = 0;
  url = "";
  private server = createServer((req, res) => void this.handle(req, res));

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  endpoints() {
    return { auth: `${this.url}/auth`, token: `${this.url}/token`, api: `${this.url}/gmail`, userinfo: `${this.url}/userinfo` };
  }

  add(m: Omit<FakeMsg, "raw" | "internalDate"> & { raw: string; internalDate?: number }, recordHistory = true) {
    this.messages.set(m.id, { ...m, raw: b64(m.raw), internalDate: m.internalDate ?? Date.now() });
    if (recordHistory) this.history.push({ id: ++this.historyId, added: [m.id] });
  }
  relabel(id: string, add: string[], remove: string[]) {
    const m = this.messages.get(id)!;
    m.labelIds = [...new Set([...m.labelIds.filter((l) => !remove.includes(l)), ...add])];
    this.history.push({ id: ++this.historyId, labels: [id] });
  }
  remove(id: string) {
    this.messages.delete(id);
    this.history.push({ id: ++this.historyId, deleted: [id] });
  }
  expireTokens() {
    this.validTokens.clear();
  }

  issue() {
    const t = `tok-${++this.tokenSeq}`;
    this.validTokens.add(t);
    return t;
  }

  private async handle(req: Req, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    let body = "";
    for await (const c of req) body += c;
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/token") {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        const challenge = this.challenges.get(p.get("code") ?? "");
        const verifier = p.get("code_verifier") ?? "";
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (!challenge || computed !== challenge) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: this.issue(), refresh_token: "refresh-1", expires_in: 3600 });
      }
      if (p.get("grant_type") === "refresh_token") {
        this.refreshCalls++;
        await new Promise((r) => setTimeout(r, 30)); // make concurrent refreshes overlap
        if (p.get("refresh_token") !== "refresh-1") return json(400, { error: "invalid_grant" });
        return json(200, { access_token: this.issue(), expires_in: 3600 });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    if (!this.validTokens.has(token)) return json(401, { error: { code: 401 } });
    if (url.pathname === "/userinfo") return json(200, { name: "Luis Cordero", sub: `sub-${this.email}`, email: this.email, email_verified: true });
    this.calls.push({ method: req.method!, path: url.pathname, body: body ? JSON.parse(body) : null });
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return json(429, { error: { code: 429, message: "rate limited" } });
    }
    const path = url.pathname.replace(/^\/gmail/, "");
    if (path === "/profile") return json(200, { emailAddress: this.email, historyId: String(this.historyId) });
    if (path === "/messages" && req.method === "GET") {
      const all = [...this.messages.keys()];
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const page = all.slice(start, start + 2); // tiny pages exercise pagination
      return json(200, { messages: page.map((id) => ({ id })), nextPageToken: start + 2 < all.length ? String(start + 2) : undefined });
    }
    const m = /^\/messages\/([^/]+)(\/(trash|untrash))?$/.exec(path);
    if (m && req.method === "GET") {
      const msg = this.messages.get(m[1]!);
      if (!msg) return json(404, { error: { code: 404 } });
      if (url.searchParams.get("format") === "minimal" && this.failMinimalOnce) {
        this.failMinimalOnce = false;
        return json(503, { error: { code: 503 } });
      }
      const base = { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, internalDate: String(msg.internalDate) };
      return json(200, url.searchParams.get("format") === "raw" ? { ...base, raw: msg.raw } : base);
    }
    if (m && m[3] && req.method === "POST") {
      const msg = this.messages.get(m[1]!)!;
      if (m[3] === "trash") this.relabel(msg.id, ["TRASH"], ["INBOX"]);
      else this.relabel(msg.id, [], ["TRASH"]);
      return json(200, { id: msg.id });
    }
    if (path === "/messages/batchModify") {
      const b = JSON.parse(body) as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] };
      for (const id of b.ids) this.relabel(id, b.addLabelIds, b.removeLabelIds);
      return json(204, null);
    }
    if (path === "/messages/send") {
      const b = JSON.parse(body) as { raw: string; threadId?: string };
      this.sent.push({ raw: Buffer.from(b.raw, "base64url").toString(), threadId: b.threadId });
      if (this.truncateSendResponse) {
        // accepted, but the connection dies while the body is in flight
        res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
        res.write('{"id":"sen');
        res.destroy();
        return;
      }
      const id = `sent-${this.sent.length}`;
      this.add({ id, threadId: b.threadId ?? id, labelIds: ["SENT"], raw: Buffer.from(b.raw, "base64url").toString() });
      return json(200, { id, threadId: b.threadId ?? id });
    }
    if (path === "/history") {
      if (this.historyExpired) return json(404, { error: { code: 404, message: "history expired" } });
      const start = Number(url.searchParams.get("startHistoryId"));
      const entries = this.history.filter((h) => h.id > start);
      return json(200, {
        historyId: String(this.historyId),
        history: entries.map((h) => ({
          id: String(h.id),
          messagesAdded: h.added?.map((id) => ({ message: { id } })),
          messagesDeleted: h.deleted?.map((id) => ({ message: { id } })),
          labelsAdded: h.labels?.map((id) => ({ message: { id } })),
        })),
      });
    }
    return json(404, { error: { code: 404, message: `no route ${path}` } });
  }
}

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Acts as the user's browser: approves (or denies) the consent screen. */
function browser(google: FakeGoogle, behaviour: "approve" | "deny" | "forge-then-approve" = "approve") {
  return async (authUrl: string) => {
    const u = new URL(authUrl);
    const redirect = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    google.challenges.set("auth-code", u.searchParams.get("code_challenge")!);
    google.loginHints.push(u.searchParams.get("login_hint"));
    setTimeout(async () => {
      if (behaviour === "forge-then-approve") {
        const forged = await fetch(`${redirect}?code=evil&state=wrong`);
        expect(forged.status).toBe(400);
      }
      await fetch(behaviour === "deny" ? `${redirect}?error=access_denied&state=${state}` : `${redirect}?code=auth-code&state=${state}`);
    }, 10);
  };
}

async function setup(behaviour?: Parameters<typeof browser>[1]) {
  const google = await new FakeGoogle().start();
  cleanups.push(() => google.stop());
  const dir = mkdtempSync(join(tmpdir(), "unica-gmail-"));
  const backend = new Backend({
    dbPath: join(dir, "u.db"),
    version: "t",
    cipher: plaintextCipher,
    providers: createRegistry({ gmail: { endpoints: google.endpoints() } }),
    openExternal: browser(google, behaviour),
    autoSync: false,
  });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c, { defaultTimeoutMs: 20_000 });
  await client.call("settings.update", { gmailClientId: "client-123.apps.googleusercontent.com" });
  return { google, backend, client };
}

function seed(google: FakeGoogle) {
  google.add({ id: "g1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], raw: rawMail({ subject: "Viaje a Oaxaca", id: "a@x" }) }, false);
  google.add({ id: "g2", threadId: "t1", labelIds: ["INBOX"], raw: rawMail({ subject: "Re: Viaje a Oaxaca", id: "b@x", inReplyTo: "a@x" }) }, false);
  google.add({ id: "g3", threadId: "t2", labelIds: ["INBOX", "STARRED"], raw: rawMail({ subject: "Factura octubre", id: "c@x", body: "Adjunto la factura" }) }, false);
  google.add({ id: "g4", threadId: "t3", labelIds: ["SPAM", "UNREAD"], raw: rawMail({ subject: "Gana dinero", id: "d@x" }) }, false);
  google.add({ id: "g5", threadId: "t4", labelIds: ["SENT"], raw: rawMail({ subject: "Hola mamá", id: "e@x", from: "Luis <luis@gmail.com>" }) }, false);
}

describe("Gmail OAuth (installed app)", () => {
  it("completes PKCE + state, ignores a forged redirect, and stores the refresh token", async () => {
    const { client, backend } = await setup("forge-then-approve");
    const account = await client.call("accounts.connectGmail", {});
    expect(account).toMatchObject({ kind: "gmail", email: "luis@gmail.com" });
    expect(await backend.getSecret(`account:${account.id}:refreshToken`)).toBe("refresh-1");
  });

  it("reports a denied consent clearly", async () => {
    const { client } = await setup("deny");
    await expect(client.call("accounts.connectGmail", {})).rejects.toThrow(/denied/i);
  });

  it("requires a client ID first", async () => {
    const { client } = await setup();
    await client.call("settings.update", { gmailClientId: "" });
    await expect(client.call("accounts.connectGmail", {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("Gmail and the owner identity", () => {
  it("connecting the first Gmail account makes it the owner, with Google's subject as evidence", async () => {
    const { client, backend } = await setup();
    const account = await client.call("accounts.connectGmail", {});
    expect(await client.call("identity.get", {})).toMatchObject({ email: "luis@gmail.com", displayName: "Luis Cordero", provider: "gmail", verifiedBy: "google_oauth", accountId: account.id });
    expect(JSON.parse(sqlDb(backend.store).get<{ e: string }>("SELECT evidence_json AS e FROM owner")!.e)).toEqual({ googleSub: "sub-luis@gmail.com", emailVerified: true });
  });

  it("changing the owner re-runs OAuth for that address; a different Google account leaves the owner unchanged", async () => {
    const { client, google } = await setup();
    await client.call("accounts.addImap", { email: "a@b.dev", displayName: "A", imap: { host: "127.0.0.1", port: 1, secure: true, user: "a" }, smtp: { host: "127.0.0.1", port: 1, secure: true, user: "a" }, password: "x", verify: false });
    const gmail = await client.call("accounts.connectGmail", {});
    const owner = await client.call("identity.get", {});
    expect(owner).toMatchObject({ email: "luis@gmail.com" }); // the unverified IMAP add did not claim
    await expect(client.call("identity.changeOwner", { accountId: gmail.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/ya es tu cuenta/) });

    google.email = "other@gmail.com";
    const second = await client.call("accounts.connectGmail", {});
    google.email = "someone-else@gmail.com"; // the user picks the wrong account on the consent screen
    await expect(client.call("identity.changeOwner", { accountId: second.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/no other@gmail.com/) });
    expect(google.loginHints.at(-1)).toBe("other@gmail.com");
    expect(await client.call("identity.get", {})).toEqual(owner);

    google.email = "other@gmail.com";
    await expect(client.call("identity.changeOwner", { accountId: second.id })).resolves.toMatchObject({ userId: owner!.userId, email: "other@gmail.com", accountId: second.id });
  });
});

describe("Gmail sync", () => {
  async function connected() {
    const ctx = await setup();
    seed(ctx.google);
    const account = await ctx.client.call("accounts.connectGmail", {});
    await ctx.backend.syncAccount(account.id);
    return { ...ctx, account };
  }

  it("does a paginated initial sync with Gmail threads and labels mapped to state", async () => {
    const { client, backend } = await connected();
    const inbox = await client.call("threads.list", { view: "inbox" });
    expect(inbox.items.map((t) => [t.subject, t.messageCount, t.unread, t.starred]).sort()).toEqual([
      ["Factura octubre", 1, false, true],
      ["Viaje a Oaxaca", 2, true, false],
    ]);
    expect((await client.call("threads.list", { view: "spam" })).items).toHaveLength(1);
    expect((await client.call("threads.list", { view: "sent" })).items).toHaveLength(1);
    expect((await client.call("threads.search", { query: "factura" })).items).toHaveLength(1);
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM messages")).toEqual({ c: 5 });
  });

  it("applies history: new mail, label changes and deletions", async () => {
    const { google, backend, client, account } = await connected();
    google.add({ id: "g6", threadId: "t1", labelIds: ["INBOX", "UNREAD"], raw: rawMail({ subject: "Re: Viaje a Oaxaca", id: "f@x", inReplyTo: "b@x" }) });
    google.relabel("g1", [], ["UNREAD"]);
    google.relabel("g3", [], ["INBOX"]); // archived elsewhere
    google.remove("g4");
    await backend.syncAccount(account.id);
    const inbox = await client.call("threads.list", { view: "inbox" });
    expect(inbox.items.map((t) => [t.subject, t.messageCount])).toEqual([["Viaje a Oaxaca", 3]]);
    expect((await client.call("threads.list", { view: "archive" })).items.map((t) => t.subject)).toContain("Factura octubre");
    expect((await client.call("threads.list", { view: "spam" })).items).toHaveLength(0);
    expect(sqlDb(backend.store).get("SELECT is_read FROM messages WHERE provider_msg_id = 'g1'")).toEqual({ is_read: 1 });
  });

  it("a resync after history expiry also refreshes labels and deletions of cached mail", async () => {
    const { google, backend, client, account } = await connected();
    google.historyExpired = true;
    google.messages.get("g1")!.labelIds = ["INBOX"]; // read elsewhere during the gap
    google.messages.get("g3")!.labelIds = []; // archived elsewhere
    google.messages.delete("g2"); // deleted elsewhere
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get("SELECT is_read FROM messages WHERE provider_msg_id = 'g1'")).toEqual({ is_read: 1 });
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM messages WHERE provider_msg_id = 'g2'")).toEqual({ c: 0 });
    expect((await client.call("threads.list", { view: "archive" })).items.map((t) => t.subject)).toContain("Factura octubre");
  });

  it("expiry recovery also checks cached mail older than the window, and retries on transient errors", async () => {
    const { google, backend, account } = await connected();
    sqlDb(backend.store).run("UPDATE messages SET date = ? WHERE provider_msg_id = 'g5'", Date.now() - 2000 * 86_400_000); // ancient cached mail
    google.historyExpired = true;
    google.messages.delete("g5");
    google.failMinimalOnce = true;
    await backend.syncAccount(account.id); // a transient 503 must not advance the cursor
    expect(sqlDb(backend.store).get<{ s: string }>("SELECT json_extract(sync_state, '$.status') s FROM accounts")!.s).toBe("offline");
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM messages WHERE provider_msg_id = 'g5'")).toEqual({ c: 0 });
  });

  it("falls back to a full resync when history has expired, without duplicates", async () => {
    const { google, backend, account } = await connected();
    google.historyExpired = true;
    google.add({ id: "g7", threadId: "t9", labelIds: ["INBOX"], raw: rawMail({ subject: "Nuevo tras expirar", id: "g@x" }) }, false);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM messages")).toEqual({ c: 6 });
    expect(sqlDb(backend.store).get("SELECT subject FROM messages WHERE provider_msg_id = 'g7'")).toEqual({ subject: "Nuevo tras expirar" });
  });
});

describe("Gmail operations", () => {
  async function connected() {
    const ctx = await setup();
    seed(ctx.google);
    const account = await ctx.client.call("accounts.connectGmail", {});
    await ctx.backend.syncAccount(account.id);
    const thread = (subject: string) => sqlDb(ctx.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE subject = ?", subject)!.thread_id;
    return { ...ctx, account, thread };
  }

  it("archives by removing INBOX from exactly the captured messages, trashes via the trash endpoint", async () => {
    const { google, backend, client, thread } = await connected();
    await client.call("threads.act", { threadIds: [thread("Viaje a Oaxaca")], action: "archive" });
    await client.call("threads.act", { threadIds: [thread("Factura octubre")], action: "trash" });
    await backend.runWorker();
    const modify = google.calls.find((c) => c.path.endsWith("/batchModify"))!;
    expect(modify.body).toEqual({ ids: ["g1", "g2"], addLabelIds: [], removeLabelIds: ["INBOX"] });
    expect(google.calls.some((c) => c.path.endsWith("/messages/g3/trash"))).toBe(true);
    expect(google.messages.get("g1")!.labelIds).not.toContain("INBOX");
    expect(google.messages.get("g3")!.labelIds).toContain("TRASH");
  });

  it("refreshes an expired token once even when many calls fail at the same time", async () => {
    const { google, backend, client, thread } = await connected();
    const before = google.refreshCalls;
    google.expireTokens();
    await client.call("threads.act", { threadIds: [thread("Viaje a Oaxaca")], action: "star" });
    await client.call("threads.act", { threadIds: [thread("Factura octubre")], action: "markUnread" });
    await client.call("threads.act", { threadIds: [thread("Hola mamá")], action: "star" });
    // ops for one account run sequentially; force parallel API calls through a sync too
    await Promise.all([backend.runWorker(), backend.syncAccount(sqlDb(backend.store).get<{ id: number }>("SELECT id FROM accounts")!.id)]);
    expect(google.refreshCalls - before).toBe(1);
    expect(sqlDb(backend.store).all("SELECT state FROM ops WHERE kind != 'send'").every((r) => (r as { state: string }).state === "succeeded")).toBe(true);
  });

  it("treats 429 as retryable", async () => {
    const { google, backend, client, thread } = await connected();
    google.rateLimitNext = 1;
    await client.call("threads.act", { threadIds: [thread("Viaje a Oaxaca")], action: "markRead" });
    await backend.runWorker();
    const [op] = await client.call("ops.list", {});
    expect(op).toMatchObject({ state: "queued", lastError: expect.stringContaining("429") });
  });

  it("keeps Bcc recipients in the message Gmail receives", async () => {
    const { google, backend, client, account } = await connected();
    await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], bcc: [{ name: "", email: "oculto@example.com" }], subject: "Bcc", bodyText: "." });
    await backend.runWorker();
    expect(google.sent[0]!.raw).toMatch(/^Bcc: oculto@example\.com/m);
  });

  it("an accepted send whose response is cut off becomes unknown, never resent", async () => {
    const { google, backend, client, account } = await connected();
    google.truncateSendResponse = true;
    const { opId } = await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "x", bodyText: "y" });
    await backend.runWorker();
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state FROM ops WHERE id = ?", opId)).toEqual({ state: "unknown" });
    expect(google.sent).toHaveLength(1);
  });

  it("a new conversation adopts its Gmail thread id so replies join it", async () => {
    const { google, backend, client, account } = await connected();
    const sent = await client.call("compose.send", { accountId: account.id, to: [{ name: "", email: "ana@example.com" }], subject: "Nuevo hilo", bodyText: "hola" });
    await backend.runWorker();
    const gmailThread = sqlDb(backend.store).get<{ provider_thread_id: string }>("SELECT provider_thread_id FROM threads WHERE id = ?", sent.threadId)!.provider_thread_id;
    expect(gmailThread).toBe("sent-1");
    google.add({ id: "reply-1", threadId: gmailThread, labelIds: ["INBOX", "UNREAD"], raw: rawMail({ subject: "Re: Nuevo hilo", id: "r1@x" }) });
    await backend.syncAccount(account.id);
    expect((await client.call("threads.get", { threadId: sent.threadId })).messages).toHaveLength(2);
  });

  it("sends a reply in the Gmail thread and adopts the server copy from history", async () => {
    const { google, backend, client, account, thread } = await connected();
    const original = (await client.call("threads.get", { threadId: thread("Viaje a Oaxaca") })).messages.at(-1)!;
    await client.call("compose.send", { accountId: account.id, to: [{ name: "Ana", email: "ana@example.com" }], subject: "Re: Viaje a Oaxaca", bodyText: "¡Vamos!", inReplyToMessageId: original.id });
    await backend.runWorker();
    expect(google.sent).toHaveLength(1);
    expect(google.sent[0]!.threadId).toBe("t1");
    expect(google.sent[0]!.raw).toMatch(/In-Reply-To: <b@x>/);
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM messages WHERE is_sent = 1 AND subject = 'Re: Viaje a Oaxaca'")).toEqual({ c: 1 });
    expect((await client.call("threads.get", { threadId: thread("Viaje a Oaxaca") })).messages).toHaveLength(3);
  });
});

describe("Gmail on the web (Google's token model, no refresh token)", () => {
  async function webSetup() {
    const google = await new FakeGoogle().start();
    cleanups.push(() => google.stop());
    const broker = createGmailTokenBroker({ endpoints: google.endpoints() });
    const providers: ProviderRegistry = {
      gmailTokens: broker,
      create: (ctx) => broker.provider(ctx),
      verifyImap: async () => Promise.reject(new Error("desktop only")),
      connectGmail: async () => Promise.reject(new Error("token model only")),
    };
    const dir = mkdtempSync(join(tmpdir(), "unica-gmail-web-"));
    const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers, autoSync: false });
    cleanups.push(async () => {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    return { google, backend, client: new RpcClient(c, { defaultTimeoutMs: 20_000 }) };
  }

  it("connects the mailbox a page-provided token opens (owner, sync); the same mailbox again only renews the token", async () => {
    const { google, backend, client } = await webSetup();
    seed(google);
    const account = await client.call("accounts.connectGmailToken", { accessToken: google.issue(), expiresIn: 3600 });
    expect(account).toMatchObject({ kind: "gmail", email: "luis@gmail.com" });
    expect(await client.call("identity.get", {})).toMatchObject({ email: "luis@gmail.com", verifiedBy: "google_oauth" });
    await backend.syncAccount(account.id);
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM messages")).toEqual({ c: 5 });
    // no secret is stored: the token lives in memory only
    expect(sqlDb(backend.store).get("SELECT count(*) c FROM secrets")).toEqual({ c: 0 });
    const again = await client.call("accounts.connectGmailToken", { accessToken: google.issue(), expiresIn: 3600 });
    expect(again.id).toBe(account.id);
    expect((await client.call("app.bootstrap", {})).accounts).toHaveLength(1);
    await expect(client.call("accounts.connectGmailToken", { accessToken: "not-a-token", expiresIn: 3600 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("without a live token, sync and actions wait (retryable) behind reconnecting, then go through", async () => {
    const { google, backend, client } = await webSetup();
    seed(google);
    const account = await client.call("accounts.connectGmailToken", { accessToken: google.issue(), expiresIn: 3600 });
    await backend.syncAccount(account.id);
    google.expireTokens();
    const thread = sqlDb(backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE subject = 'Viaje a Oaxaca'")!.thread_id;
    await client.call("threads.act", { threadIds: [thread], action: "archive" });
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state, last_error FROM ops")).toEqual({ state: "queued", last_error: GMAIL_RECONNECT });
    await backend.syncAccount(account.id);
    expect((await client.call("app.bootstrap", {})).accounts[0]!.syncState).toMatchObject({ status: "offline", lastError: GMAIL_RECONNECT });
    await client.call("accounts.connectGmailToken", { accessToken: google.issue(), expiresIn: 3600 });
    sqlDb(backend.store).run("UPDATE ops SET next_attempt_at = 0");
    await backend.runWorker();
    expect(sqlDb(backend.store).get("SELECT state FROM ops")).toEqual({ state: "succeeded" });
    expect(google.messages.get("g1")!.labelIds).not.toContain("INBOX");
  });

  it("sends through the API with the portable MIME builder (UTF-8 subject and names, Bcc kept for Gmail)", async () => {
    const { google, backend, client } = await webSetup();
    const account = await client.call("accounts.connectGmailToken", { accessToken: google.issue(), expiresIn: 3600 });
    await client.call("compose.send", { accountId: account.id, to: [{ name: "Ana Pérez", email: "ana@example.com" }], bcc: [{ name: "", email: "oculto@example.com" }], subject: "Reunión mañana", bodyText: "¿Nos vemos?\nSaludos" });
    await backend.runWorker();
    const raw = google.sent[0]!.raw;
    expect(raw).toMatch(/^Bcc: oculto@example\.com/m);
    const { parseRaw } = await import("@unica/mail");
    const parsed = await parseRaw(raw);
    expect(parsed).toMatchObject({ subject: "Reunión mañana", to: [{ name: "Ana Pérez", email: "ana@example.com" }], text: expect.stringMatching(/^¿Nos vemos\?\r?\nSaludos$/) });
    expect(sqlDb(backend.store).get("SELECT state FROM ops WHERE kind = 'send'")).toEqual({ state: "succeeded" });
  });
});

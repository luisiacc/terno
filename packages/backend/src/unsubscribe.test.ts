import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, ingestMessages, sqlDb, type IncomingMessage } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { TEST_TLS_CA, TEST_TLS_CERT, TEST_TLS_KEY } from "./test/icons-tls";
import { browserUnsubscribeTransport, postAllowed, type UnsubscribeTransport } from "./unsubscribe";
import { createNetworkPolicy } from "./net-policy";
import { nodeUnsubscribeTransport } from "./unsubscribe-node";

const NOW = Date.UTC(2026, 9, 31, 12);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let n = 0;
function incoming(accountId: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  n++;
  return {
    accountId,
    providerMsgId: `u${n}`,
    providerThreadId: null,
    rfcMessageId: `u${n}@x`,
    inReplyTo: null,
    references: [],
    from: { name: "The Weekly", email: "news@weekly.example" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: `Issue ${n}`,
    date: NOW - 60_000,
    snippet: "",
    bodyText: "This week",
    bodyHtml: null,
    bodyState: "full",
    listId: "weekly.example",
    isRead: false,
    isStarred: false,
    inInbox: true,
    isSent: false,
    isDraft: false,
    isTrash: false,
    isSpam: false,
    hasAttachments: false,
    size: 100,
    ...over,
  };
}

type Posted = { url: string };
function recorder(answer: (url: URL) => Promise<{ status: number } | { opaque: true }> = async () => ({ status: 200 })) {
  const posted: Posted[] = [];
  const transport: UnsubscribeTransport = { post: async (url) => (posted.push({ url: url.href }), answer(url)) };
  return { posted, transport };
}

async function setup(o: { transport?: UnsubscribeTransport | null; localMode?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-unsub-"));
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, iconTransport: null, unsubscribeTransport: o.transport === undefined ? recorder().transport : o.transport });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  if (o.localMode !== undefined) await client.call("settings.update", { localMode: o.localMode });
  const db = sqlDb(backend.store);
  const account = createAccount(db, { kind: "imap", email: "me@example.com", displayName: "Me", color: "indigo" }).id;
  const thread = (over: Partial<IncomingMessage>) => [...ingestMessages(db, [incoming(account, over)]).touchedThreads][0]!;
  return { backend, client, db, account, thread };
}

const ONE_CLICK = { oneClick: "https://weekly.example/u/1", url: "https://weekly.example/u/1" };

describe("unsubscribe (plan 96)", () => {
  it("one-click: offered by host, POSTed once, said as done on a 2xx (also in local mode)", async () => {
    const { posted, transport } = recorder();
    const { client, thread } = await setup({ transport, localMode: true });
    const t = thread({ unsubscribe: ONE_CLICK });
    const offer = await client.call("unsubscribe.find", { threadId: t });
    expect(offer).toEqual({ messageId: expect.any(Number), method: "oneClick", target: "weekly.example", name: "The Weekly" });
    // the renderer is never handed the URL of a request it doesn't make
    expect(JSON.stringify(offer)).not.toContain("/u/1");
    expect(posted).toEqual([]);
    expect(await client.call("unsubscribe.run", { threadId: t, ...offer! })).toEqual({ outcome: "unsubscribed", target: "weekly.example" });
    expect(posted).toEqual([{ url: "https://weekly.example/u/1" }]);
  });

  it("a redirect or an opaque answer is a request sent, not a confirmed unsubscribe", async () => {
    for (const answer of [{ status: 302 }, { opaque: true as const }]) {
      const { client, thread } = await setup({ transport: recorder(async () => answer).transport });
      const t = thread({ unsubscribe: ONE_CLICK });
      const offer = (await client.call("unsubscribe.find", { threadId: t }))!;
      expect(await client.call("unsubscribe.run", { threadId: t, ...offer })).toEqual({ outcome: "requested", target: "weekly.example" });
    }
  });

  it("a refused or failed POST opens the page when there is one, else says so", async () => {
    const refused = await setup({ transport: recorder(async () => ({ status: 500 })).transport });
    const t1 = refused.thread({ unsubscribe: ONE_CLICK });
    const o1 = (await refused.client.call("unsubscribe.find", { threadId: t1 }))!;
    expect(await refused.client.call("unsubscribe.run", { threadId: t1, ...o1 })).toEqual({ outcome: "open", target: "weekly.example", url: "https://weekly.example/u/1", failed: true });

    const broken = await setup({ transport: recorder(async () => Promise.reject(new Error("ECONNRESET"))).transport });
    // a stored value with only the one-click URI: nothing to fall back to
    const t2 = broken.thread({});
    broken.db.run("UPDATE messages SET unsubscribe = ? WHERE thread_id = ?", JSON.stringify({ oneClick: "https://weekly.example/u/2", url: "ftp://nope" }), t2);
    const o2 = (await broken.client.call("unsubscribe.find", { threadId: t2 }))!;
    expect(o2.method).toBe("oneClick");
    await expect(broken.client.call("unsubscribe.run", { threadId: t2, ...o2 })).rejects.toThrow(/Couldn’t unsubscribe: weekly.example/);
  });

  it("never POSTs to this Mac or its networks: the page opens instead", async () => {
    const { posted, transport } = recorder();
    const { client, thread } = await setup({ transport });
    const t = thread({ unsubscribe: { oneClick: "https://192.168.1.1/u", url: "https://192.168.1.1/u" } });
    const offer = (await client.call("unsubscribe.find", { threadId: t }))!;
    expect(await client.call("unsubscribe.run", { threadId: t, ...offer })).toMatchObject({ outcome: "open", failed: true });
    expect(posted).toEqual([]);
  });

  it("a host that can't POST opens the page, without calling it a failure", async () => {
    const { client, thread } = await setup({ transport: null });
    const t = thread({ unsubscribe: ONE_CLICK });
    const offer = (await client.call("unsubscribe.find", { threadId: t }))!;
    expect(await client.call("unsubscribe.run", { threadId: t, ...offer })).toEqual({ outcome: "open", target: "weekly.example", url: "https://weekly.example/u/1", failed: false });
  });

  it("mail: queued from the account the mail came to, with the URI's subject and body only", async () => {
    const { client, thread, db, account } = await setup();
    const t = thread({ unsubscribe: { mailto: "mailto:off@weekly.example?subject=Stop&body=list%3D7&cc=boss@corp.example" } });
    const offer = (await client.call("unsubscribe.find", { threadId: t }))!;
    expect(offer).toMatchObject({ method: "mailto", target: "off@weekly.example" });
    const out = await client.call("unsubscribe.run", { threadId: t, ...offer });
    expect(out).toEqual({ outcome: "queued", target: "off@weekly.example", opId: expect.any(String) });
    const sent = db.get<{ account_id: number; to_json: string; cc_json: string; subject: string }>("SELECT account_id, to_json, cc_json, subject FROM messages WHERE is_sent = 1");
    expect(sent).toMatchObject({ account_id: account, subject: "Stop", cc_json: "[]" });
    expect(JSON.parse(sent!.to_json)).toEqual([{ name: "", email: "off@weekly.example" }]);
  });

  it("a page, or the link in the mail, is handed back to open", async () => {
    const { client, thread } = await setup();
    const header = thread({ unsubscribe: { url: "https://weekly.example/prefs" } });
    const o1 = (await client.call("unsubscribe.find", { threadId: header }))!;
    expect(o1.url).toBe("https://weekly.example/prefs");
    expect(await client.call("unsubscribe.run", { threadId: header, ...o1 })).toEqual({ outcome: "open", target: "weekly.example", url: "https://weekly.example/prefs", failed: false });
    const link = thread({ listId: null, from: { name: "", email: "shop@shop.example" }, bodyHtml: '<p>Hi</p><a href="https://shop.example/bye">Unsubscribe</a>' });
    expect(await client.call("unsubscribe.find", { threadId: link })).toEqual({ messageId: expect.any(Number), method: "page", target: "shop.example", name: "shop@shop.example", url: "https://shop.example/bye" });
  });

  it("nothing to offer: personal mail, and conversations of only your own mail", async () => {
    const { client, thread } = await setup();
    expect(await client.call("unsubscribe.find", { threadId: thread({ listId: null, from: { name: "Ana", email: "ana@friends.example" }, bodyText: "Lunch?" }) })).toBeNull();
    expect(await client.call("unsubscribe.find", { threadId: thread({ from: { name: "Me", email: "me@example.com" }, isSent: true, unsubscribe: ONE_CLICK }) })).toBeNull();
  });

  it("runs only what was shown: a conversation that changed since is refused", async () => {
    const { posted, transport } = recorder();
    const { client, thread, db, account } = await setup({ transport });
    const t = thread({ rfcMessageId: "first@x", unsubscribe: { url: "https://weekly.example/prefs" } });
    const shown = (await client.call("unsubscribe.find", { threadId: t }))!;
    // newer mail in the conversation asks for something else (one-click), before the click
    ingestMessages(db, [incoming(account, { rfcMessageId: "second@x", inReplyTo: "first@x", references: ["first@x"], date: NOW, unsubscribe: ONE_CLICK })]);
    await expect(client.call("unsubscribe.run", { threadId: t, ...shown })).rejects.toMatchObject({ code: "STALE" });
    expect(posted).toEqual([]);
  });
});

describe("where a one-click POST may go (plan 96)", () => {
  it("https on the default port to a public name or address, without credentials", () => {
    for (const ok of ["https://weekly.example/u", "https://list.news.example.com/u?t=1", "https://93.184.216.34/u", "https://[2606:2800:220:1::1]/u"]) expect(postAllowed(new URL(ok)), ok).toBe(true);
    for (const no of ["http://weekly.example/u", "https://weekly.example:8443/u", "https://a:b@weekly.example/u", "https://127.0.0.1/u", "https://10.0.0.5/u", "https://[::1]/u", "https://[::ffff:192.168.0.1]/u", "https://localhost/u", "https://printer/u", "https://nas.local/u", "https://router.home.arpa/u", "https://svc.internal/u"]) expect(postAllowed(new URL(no)), no).toBe(false);
  });
});

describe("the web's transport (plan 96, Codex review #2)", () => {
  /** what a browser's fetch would get: the init it was handed, and an answer */
  const browser = (answer: (init: RequestInit) => Response | Promise<Response>) => {
    const asked: RequestInit[] = [];
    const net = createNetworkPolicy({ localMode: () => true, fetch: async (_input, init) => (asked.push(init ?? {}), answer(init ?? {})) });
    return { asked, policed: net.fetchFor("unsubscribe") };
  };

  it("sends a cors-mode form POST that never follows a redirect (a browser refuses no-cors with manual redirects)", async () => {
    const { asked, policed } = browser(() => new Response(null, { status: 204 }));
    expect(await browserUnsubscribeTransport(policed, () => true).post(new URL("https://weekly.example/u"), AbortSignal.timeout(1000))).toEqual({ status: 204 });
    expect(asked).toMatchObject([{ method: "POST", mode: "cors", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", body: "List-Unsubscribe=One-Click" }]);
    // the Fetch Standard's rule this must never break
    expect(asked.every((i) => !(i.mode === "no-cors" && i.redirect !== "follow"))).toBe(true);
  });

  it("an unreadable answer (the sender doesn't allow this origin) is sent; offline it failed", async () => {
    const { policed } = browser(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await browserUnsubscribeTransport(policed, () => true).post(new URL("https://weekly.example/u"), AbortSignal.timeout(1000))).toEqual({ opaque: true });
    await expect(browserUnsubscribeTransport(policed, () => false).post(new URL("https://weekly.example/u"), AbortSignal.timeout(1000))).rejects.toThrow("Failed to fetch");
  });
});

describe("the Node transport (plan 96)", () => {
  let server: Server;
  let port = 0;
  const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  beforeAll(async () => {
    server = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (req.url === "/moved") res.writeHead(302, { location: "https://elsewhere.example.com/" }).end();
        else res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => void seen.splice(0));

  const loopback = async () => [{ address: "127.0.0.1", family: 4 }];

  it("POSTs exactly the RFC 8058 body, with no cookies or referrer, and never follows a redirect", async () => {
    const t = nodeUnsubscribeTransport({ lookup: loopback, allowAddress: () => true, ca: TEST_TLS_CA, port });
    expect(await t.post(new URL("https://news.example.com/u?id=1"), AbortSignal.timeout(5000))).toEqual({ status: 204 });
    expect(await t.post(new URL("https://news.example.com/moved"), AbortSignal.timeout(5000))).toEqual({ status: 302 });
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([["POST", "/u?id=1", "List-Unsubscribe=One-Click"], ["POST", "/moved", "List-Unsubscribe=One-Click"]]);
    expect(seen[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.referer).toBeUndefined();
  });

  it("refuses a name with any non-public answer, and an address literal, before a socket opens", async () => {
    const mixed = nodeUnsubscribeTransport({ lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.10", family: 4 }], ca: TEST_TLS_CA, port });
    await expect(mixed.post(new URL("https://news.example.com/u"), AbortSignal.timeout(5000))).rejects.toThrow(/never go to/);
    const strict = nodeUnsubscribeTransport({ lookup: loopback, ca: TEST_TLS_CA, port });
    await expect(strict.post(new URL("https://news.example.com/u"), AbortSignal.timeout(5000))).rejects.toThrow(/never go to/);
    await expect(strict.post(new URL("https://127.0.0.1/u"), AbortSignal.timeout(5000))).rejects.toThrow(/never go to/);
    expect(seen).toEqual([]);
  });
});

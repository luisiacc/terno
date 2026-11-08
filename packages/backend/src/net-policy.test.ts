import dc from "node:diagnostics_channel";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNetworkPolicy, NetworkPolicyError, type LookupAll, type NetDecision, type NetPurpose } from "./net-policy";

/** Every outbound TCP connect in this process, as seen by Node itself (not by our code). */
const connects: string[] = [];
const onUndici = (m: unknown) => connects.push(`undici:${(m as { connectParams: { hostname: string } }).connectParams.hostname}`);
const onSocket = () => connects.push("net:socket");

let server: Server;
let port = 0;
const seen: { host: string | undefined; url: string | undefined }[] = [];
let accepted = 0;

beforeAll(async () => {
  dc.subscribe("undici:client:beforeConnect", onUndici);
  dc.subscribe("net.client.socket", onSocket);
  server = createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  server.on("connection", () => accepted++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  dc.unsubscribe("undici:client:beforeConnect", onUndici);
  dc.unsubscribe("net.client.socket", onSocket);
  server.close();
});
beforeEach(() => {
  connects.length = 0;
  seen.length = 0;
  accepted = 0;
});

function policy(dns: Record<string, string[]> = {}) {
  const lookups: string[] = [];
  const lookup: LookupAll = async (host) => {
    lookups.push(host);
    const addrs = dns[host];
    if (!addrs) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  // non-keep-alive so each allowed request is a fresh, countable connection
  const fetchNoReuse: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), connection: "close" } });
  return { net: createNetworkPolicy({ lookup, fetch: fetchNoReuse }), lookups };
}

describe("network policy (plan 97: local mode means mail is kept here; no purpose is refused for it)", () => {
  it("lets mail and every other purpose through unchanged: no lookups, no pinning", async () => {
    const { net, lookups } = policy();
    expect((await net.fetchFor("mail")(`http://127.0.0.1:${port}/gmail`)).status).toBe(200);
    for (const purpose of ["ai", "cloud", "telemetry", "update", "remote-content"] as NetPurpose[]) {
      expect((await net.fetchFor(purpose, { providerLocality: "cloud" })(`http://127.0.0.1:${port}/${purpose}`)).status).toBe(200);
    }
    expect(lookups).toEqual([]);
    expect(seen.map((s) => s.url)).toEqual(["/gmail", "/ai", "/cloud", "/telemetry", "/update", "/remote-content"]);
  });

  it("cloud AI and a provider declared local both pass, wherever they are (the provider is the user's choice)", async () => {
    const { net } = policy();
    await expect(net.assert("ai", "https://api.anthropic.com/v1", { providerLocality: "cloud" })).resolves.toEqual({});
    await expect(net.assert("ai", "http://192.168.1.20:11434/api/tags", { providerLocality: "local" })).resolves.toEqual({});
  });

  it("plan 161: an observer hears every decision, a refused icon included", async () => {
    const decisions: NetDecision[] = [];
    const net = createNetworkPolicy({ lookup: async () => [{ address: "127.0.0.1", family: 4 }], fetch: (input, init) => fetch(input, { ...init, headers: { connection: "close" } }), observe: (d) => decisions.push(d), siteIcons: () => false });
    await net.fetchFor("ai")(`http://127.0.0.1:${port}/v1/chat/completions`);
    await expect(net.assert("icons", "https://example.com/favicon.ico")).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(decisions).toEqual([
      { purpose: "ai", url: `http://127.0.0.1:${port}/v1/chat/completions`, allowed: true },
      { purpose: "icons", url: "https://example.com/favicon.ico", allowed: false },
    ]);
  });
});

describe("redirects", () => {
  /** A: a loopback "AI server" that redirects; B: where the redirect points. */
  async function pair() {
    const seenB: { method: string; auth: string | undefined; body: string }[] = [];
    let bConnections = 0;
    const b = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seenB.push({ method: req.method!, auth: req.headers.authorization ?? req.headers["api-key"]?.toString() ?? req.headers["x-api-key"]?.toString(), body: data });
        res.writeHead(200, { "content-type": "application/json" }).end('{"from":"b"}');
      });
    });
    b.on("connection", () => bConnections++);
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    const bPort = (b.address() as AddressInfo).port;
    const a = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/same") return void res.writeHead(307, { location: "/final" }).end();
        if (req.url === "/final") return void res.writeHead(200).end("final");
        res.writeHead(307, { location: `http://localhost:${bPort}/steal` }).end();
      });
    });
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
    const aUrl = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
    return { aUrl, seenB, bConnections: () => bConnections, close: () => (a.close(), b.close()) };
  }

  it("allowed redirects are followed hop by hop; credentials never cross origins, bodies survive 307", async () => {
    const p = await pair();
    try {
      const { net } = policy();
      const res = await net.fetchFor("ai", { providerLocality: "cloud" })(`${p.aUrl}/v1`, { method: "POST", body: "payload" });
      expect(await res.json()).toEqual({ from: "b" });
      const mail = await net.fetchFor("mail")(`${p.aUrl}/v1`, { method: "POST", body: "payload", headers: { authorization: "Bearer gmail-token" } });
      expect(await mail.json()).toEqual({ from: "b" });
      expect(p.seenB).toEqual([
        { method: "POST", auth: undefined, body: "payload" },
        { method: "POST", auth: undefined, body: "payload" },
      ]);
      const same = await net.fetchFor("mail")(`${p.aUrl}/same`);
      expect(await same.text()).toBe("final");
    } finally {
      p.close();
    }
  });

  it("plan 125: a request that refuses redirects gets none, so a token in its body never reaches another host", async () => {
    const p = await pair();
    try {
      const { net } = policy();
      await expect(net.fetchFor("mail")(`${p.aUrl}/revoke`, { method: "POST", body: "token=synthetic-token", redirect: "error" })).rejects.toThrow();
      await expect(net.fetchFor("mail")(`${p.aUrl}/same`, { redirect: "error" })).rejects.toThrow();
      expect(p.seenB).toEqual([]);
    } finally {
      p.close();
    }
  });

  it("an AI request carrying a key follows no redirect at all, to another origin or its own: the key stays where it was bound", async () => {
    const p = await pair();
    try {
      const { net } = policy();
      const ai = net.fetchFor("ai", { providerLocality: "cloud" });
      // Bearer (OpenAI-style APIs, Anthropic), Azure's api-key, x-api-key; as a plain object, a Headers or a Request
      const keyed: [string, RequestInit | Request][] = [
        ["/v1", { method: "POST", body: "{}", headers: { authorization: "Bearer sk-secret" } }],
        ["/v1", { method: "POST", body: "{}", headers: new Headers({ "api-key": "azure-secret" }) }],
        ["/v1", new Request(`${p.aUrl}/v1`, { method: "POST", body: "{}", headers: { "x-api-key": "sk-ant-secret" } })],
        ["/same", { headers: { authorization: "Bearer sk-secret" } }],
      ];
      for (const [path, init] of keyed) {
        const err = await (init instanceof Request ? ai(init) : ai(`${p.aUrl}${path}`, init)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NetworkPolicyError);
        expect((err as Error).message).toMatch(/doesn’t follow redirects for requests that carry your API key/);
      }
      expect(p.seenB).toEqual([]);
    } finally {
      p.close();
    }
  });

  it("Azure through the SDK: a 307 from its endpoint ends in a clear error, and the key never reaches the redirect's target", async () => {
    const { createAi } = await import("@terno/ai");
    const p = await pair();
    try {
      const { net } = policy();
      const azure = createAi({ id: "compatible", preset: "azure", model: "dep", apiKey: "azure-secret", baseURL: p.aUrl, fetch: net.fetchFor("ai", { providerLocality: "cloud" }), timeoutMs: 5000, maxRetries: 1 });
      await expect(azure.generateFilter("archiva lo de uber", { now: 0, categories: [], accounts: [] })).rejects.toMatchObject({ message: expect.stringMatching(/redirect to localhost:\d+: Terno doesn’t follow redirects/), i18n: { key: "errors.net.redirect" } });
      expect(p.seenB).toEqual([]);
    } finally {
      p.close();
    }
  });
});

describe("network policy without DNS (the browser)", () => {
  const browser = () => createNetworkPolicy({ fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), connection: "close" } }) });

  it("follows redirects as the browser does, for AI without a key and for mail", async () => {
    const hop = createServer((_req, res) => void res.writeHead(307, { location: `http://127.0.0.1:${port}/elsewhere` }).end());
    await new Promise<void>((r) => hop.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/v1`;
      expect((await browser().fetchFor("mail")(url)).status).toBe(200);
      expect((await browser().fetchFor("ai", { providerLocality: "local" })(url)).status).toBe(200);
    } finally {
      hop.close();
    }
  });

  it("an AI request carrying a key is never redirected (a browser would re-send api-key to the target)", async () => {
    const hop = createServer((_req, res) => void res.writeHead(307, { location: `http://127.0.0.1:${port}/elsewhere` }).end());
    await new Promise<void>((r) => hop.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/openai/deployments/dep/chat/completions`;
      for (const headers of [{ "api-key": "azure-secret" }, { authorization: "Bearer sk-secret" }, { "x-api-key": "sk-ant-secret" }]) {
        await expect(browser().fetchFor("ai", { providerLocality: "cloud" })(url, { method: "POST", body: "{}", headers })).rejects.toThrow(/doesn’t follow redirects/);
      }
      expect(seen).toEqual([]);
    } finally {
      hop.close();
    }
  });

  it("plan 96: an unsubscribe request never follows a redirect", async () => {
    const asked: RequestInit[] = [];
    const net = createNetworkPolicy({ fetch: async (_input, init) => (asked.push(init ?? {}), new Response(null, { status: 204 })) });
    await expect(net.assert("unsubscribe", "https://news.example/u")).resolves.toEqual({});
    await net.fetchFor("unsubscribe")("https://news.example/u", { method: "POST", body: "List-Unsubscribe=One-Click" });
    expect(asked.map((i) => i.redirect)).toEqual(["manual"]);
  });
});

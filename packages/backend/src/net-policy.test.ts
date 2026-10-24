import dc from "node:diagnostics_channel";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNetworkPolicy, NetworkPolicyError, type LookupAll, type NetPurpose } from "./net-policy";

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

function policy(localMode: boolean, dns: Record<string, string[]> = {}) {
  const lookups: string[] = [];
  const lookup: LookupAll = async (host) => {
    lookups.push(host);
    const addrs = dns[host];
    if (!addrs) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  // non-keep-alive so each allowed request is a fresh, countable connection
  const fetchNoReuse: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), connection: "close" } });
  return { net: createNetworkPolicy({ localMode: () => localMode, lookup, fetch: fetchNoReuse }), lookups };
}

describe("network policy in local mode", () => {
  it("always allows mail traffic", async () => {
    const { net } = policy(true);
    const res = await net.fetchFor("mail")(`http://127.0.0.1:${port}/gmail`);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("rejects cloud AI before resolving or connecting anything", async () => {
    const { net, lookups } = policy(true, { "api.openai.com": ["127.0.0.1"] });
    const err = await net.fetchFor("ai", { providerLocality: "cloud" })(`http://127.0.0.1:${port}/v1/chat/completions`).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkPolicyError);
    expect(err).toMatchObject({ purpose: "ai" });
    expect(lookups).toEqual([]);
    expect(accepted).toBe(0);
    expect(connects).toEqual([]);
  });

  it("rejects a 'local' provider whose host resolves to the LAN, with zero connections", async () => {
    const { net } = policy(true, { "ollama.lan": ["10.0.0.5"] });
    await expect(net.fetchFor("ai", { providerLocality: "local" })(`http://ollama.lan:${port}/v1/models`)).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(net.fetchFor("ai", { providerLocality: "local" })("http://192.168.1.20:11434/api/tags")).rejects.toThrow(/no es una dirección local/);
    await expect(net.fetchFor("ai", { providerLocality: "local" })("http://unresolvable.invalid/v1")).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(connects).toEqual([]);
  });

  it("rejects a host with any non-loopback address (no mixed answers)", async () => {
    const { net } = policy(true, { "mixed.test": ["127.0.0.1", "93.184.216.34"] });
    await expect(net.assert("ai", "http://mixed.test/v1", { providerLocality: "local" })).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it("connects a loopback-resolving name to the IP it checked (DNS rebinding can't redirect it)", async () => {
    const { net, lookups } = policy(true, { "my-llm.test": ["::1", "127.0.0.1"] });
    const res = await net.fetchFor("ai", { providerLocality: "local" })(`http://my-llm.test:${port}/v1/models?x=1`);
    expect(await res.json()).toEqual({ ok: true });
    expect(lookups).toEqual(["my-llm.test"]);
    // the request went to the pinned IPv4 address, not the name (path and query intact)
    expect(seen).toEqual([{ host: `127.0.0.1:${port}`, url: "/v1/models?x=1" }]);
    expect(connects.filter((c) => c.startsWith("undici:"))).toEqual(["undici:127.0.0.1"]);
  });

  it("allows localhost and loopback literals, including Request inputs", async () => {
    const { net } = policy(true, { localhost: ["127.0.0.1"] });
    const ai = net.fetchFor("ai", { providerLocality: "local" });
    expect((await ai(`http://localhost:${port}/a`)).status).toBe(200);
    expect((await ai(new Request(`http://127.0.0.1:${port}/b`, { method: "POST", body: "{}" }))).status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(["/a", "/b"]);
    await expect(net.assert("ai", "http://[::1]:1234/v1", { providerLocality: "local" })).resolves.toEqual({ pinnedHost: "::1" });
  });

  it("denies remote content, telemetry, updates and cloud identity outright", async () => {
    const { net } = policy(true);
    for (const purpose of ["remote-content", "telemetry", "update", "cloud"] as NetPurpose[]) {
      await expect(net.fetchFor(purpose)(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ name: "NetworkPolicyError", purpose });
    }
    expect(accepted).toBe(0);
  });
});

describe("network policy with local mode off", () => {
  it("lets every purpose through unchanged (no lookups, no pinning)", async () => {
    const { net, lookups } = policy(false);
    for (const purpose of ["ai", "cloud", "telemetry"] as NetPurpose[]) {
      expect((await net.fetchFor(purpose, { providerLocality: "cloud" })(`http://127.0.0.1:${port}/${purpose}`)).status).toBe(200);
    }
    expect(lookups).toEqual([]);
    expect(seen.map((s) => s.url)).toEqual(["/ai", "/cloud", "/telemetry"]);
  });

  it("re-reads the switch on every request", async () => {
    let on = false;
    const net = createNetworkPolicy({ localMode: () => on });
    await expect(net.assert("ai", "https://api.anthropic.com/v1", { providerLocality: "cloud" })).resolves.toEqual({});
    on = true;
    await expect(net.assert("ai", "https://api.anthropic.com/v1", { providerLocality: "cloud" })).rejects.toBeInstanceOf(NetworkPolicyError);
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
        seenB.push({ method: req.method!, auth: req.headers.authorization ?? req.headers["api-key"] ?? req.headers["x-api-key"], body: data });
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

  it("local mode checks every hop: a loopback server can't forward the prompt to another host", async () => {
    const p = await pair();
    try {
      // the redirect target is a name that (per DNS) is not on this Mac
      const { net } = policy(true, { localhost: ["10.0.0.5"] });
      const err = await net
        .fetchFor("ai", { providerLocality: "local" })(`${p.aUrl}/v1/chat/completions`, { method: "POST", body: '{"prompt":"secret"}', headers: { "content-type": "application/json" } })
        .catch((e) => e);
      expect(err).toBeInstanceOf(NetworkPolicyError);
      expect(p.bConnections()).toBe(0);
      expect(p.seenB).toEqual([]);
    } finally {
      p.close();
    }
  });

  it("allowed redirects are followed hop by hop; credentials never cross origins, bodies survive 307", async () => {
    const p = await pair();
    try {
      const { net } = policy(false);
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

  it("an AI request carrying a key follows no redirect at all, to another origin or its own: the key stays where it was bound", async () => {
    const p = await pair();
    try {
      const { net } = policy(false);
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
        expect((err as Error).message).toMatch(/no sigue redirecciones de peticiones que llevan tu API key/);
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
      const { net } = policy(false);
      const azure = createAi({ id: "compatible", preset: "azure", model: "dep", apiKey: "azure-secret", baseURL: p.aUrl, fetch: net.fetchFor("ai", { providerLocality: "cloud" }), timeoutMs: 5000, maxRetries: 1 });
      await expect(azure.generateFilter("archiva lo de uber", { now: 0, categories: [], accounts: [] })).rejects.toMatchObject({ message: expect.stringMatching(/redirección a localhost:\d+: Terno no sigue redirecciones/) });
      expect(p.seenB).toEqual([]);
    } finally {
      p.close();
    }
  });
});

describe("network policy without DNS (the browser)", () => {
  const browser = (localMode: boolean) => createNetworkPolicy({ localMode: () => localMode, fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), connection: "close" } }) });

  it("counts only literal loopback hosts as local: names it can't resolve are refused, nothing is pinned", async () => {
    const net = browser(true);
    await expect(net.assert("ai", "http://127.0.0.1:11434/v1", { providerLocality: "local" })).resolves.toEqual({ pinnedHost: "127.0.0.1" });
    await expect(net.assert("ai", "http://[::1]:1234/v1", { providerLocality: "local" })).resolves.toEqual({ pinnedHost: "::1" });
    await expect(net.assert("ai", "http://localhost:1234/v1", { providerLocality: "local" })).resolves.toMatchObject({});
    await expect(net.assert("ai", "http://my-llm.test:1234/v1", { providerLocality: "local" })).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(net.assert("ai", "http://192.168.1.4:1234/v1", { providerLocality: "local" })).rejects.toBeInstanceOf(NetworkPolicyError);
    const res = await net.fetchFor("ai", { providerLocality: "local" })(`http://127.0.0.1:${port}/v1`);
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.host)).toEqual([`127.0.0.1:${port}`]);
  });

  it("a vetted request may not be redirected at all (a browser hides where it would go)", async () => {
    const hop = createServer((_req, res) => void res.writeHead(307, { location: `http://127.0.0.1:${port}/elsewhere` }).end());
    await new Promise<void>((r) => hop.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/v1`;
      await expect(browser(true).fetchFor("ai", { providerLocality: "local" })(url)).rejects.toThrow();
      expect(seen).toEqual([]);
      // mail (always allowed) and anything outside local mode follow redirects as the browser does
      expect((await browser(true).fetchFor("mail")(url)).status).toBe(200);
      expect((await browser(false).fetchFor("ai", { providerLocality: "cloud" })(url)).status).toBe(200);
    } finally {
      hop.close();
    }
  });

  it("an AI request carrying a key is never redirected outside local mode either (a browser would re-send api-key to the target)", async () => {
    const hop = createServer((_req, res) => void res.writeHead(307, { location: `http://127.0.0.1:${port}/elsewhere` }).end());
    await new Promise<void>((r) => hop.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/openai/deployments/dep/chat/completions`;
      for (const headers of [{ "api-key": "azure-secret" }, { authorization: "Bearer sk-secret" }, { "x-api-key": "sk-ant-secret" }]) {
        await expect(browser(false).fetchFor("ai", { providerLocality: "cloud" })(url, { method: "POST", body: "{}", headers })).rejects.toThrow(/no sigue redirecciones/);
      }
      expect(seen).toEqual([]);
    } finally {
      hop.close();
    }
  });
});

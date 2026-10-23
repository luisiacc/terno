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

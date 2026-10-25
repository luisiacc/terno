/**
 * The AI surface of the backend: settings and profiles, keys that never leave
 * the backend, local-mode enforcement with zero connections, and the ai.* RPCs.
 */
import dc from "node:diagnostics_channel";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient, RpcError } from "@terno/core/rpc";
import { setSetting, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import type { LookupAll } from "./net-policy";

const WIRE = {
  name: "Uber",
  explanation: "Archiva recibos de Uber",
  match: "all",
  conditions: [{ field: "fromDomain", op: "equals", value: "uber.com", negate: false }],
  actions: [{ type: "archive", categoryId: null }],
};

/** One stub that speaks the OpenAI, Ollama and Anthropic dialects, counting every TCP connection. */
let server: Server;
let port = 0;
let connections = 0;
let hang = false;
const requests: { url: string; headers: IncomingHttpHeaders; body: any }[] = [];
const hung: import("node:http").ServerResponse[] = [];
const connects: string[] = [];
const onConnect = (m: unknown) => connects.push((m as { connectParams: { hostname: string } }).connectParams.hostname);

beforeAll(async () => {
  dc.subscribe("undici:client:beforeConnect", onConnect);
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({ url: req.url!, headers: req.headers, body });
      if (hang) return void hung.push(res);
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/api/tags") return json(200, { models: [{ name: "qwen3:8b", size: 5e9 }] });
      if (req.url === "/api/ps") return json(200, { models: [] });
      if (req.url === "/api/show") return json(200, { model_info: { "qwen3.context_length": 40960 } });
      if (req.url?.startsWith("/v1/messages")) {
        return json(200, { id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: JSON.stringify(WIRE) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
      }
      if (req.url?.endsWith("/chat/completions")) {
        const content = body?.response_format?.json_schema?.name === "probe" ? '{"ok":true}' : JSON.stringify(WIRE);
        return json(200, { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null } }] });
      }
      json(404, { error: { message: "not found" } });
    });
  });
  server.on("connection", () => connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  dc.unsubscribe("undici:client:beforeConnect", onConnect);
  server.closeAllConnections();
  server.close();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  hang = false;
  for (const r of hung.splice(0)) r.destroy();
  requests.length = 0;
  connects.length = 0;
  connections = 0;
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(options: { dns?: Record<string, string[]>; localMode?: boolean; onPolicy?: (p: { localMode: boolean }) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-ai-"));
  const lookup: LookupAll = async (host) => {
    const addrs = options.dns?.[host] ?? (host === "localhost" ? ["127.0.0.1"] : undefined);
    if (!addrs) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, lookup, demoAi: true, onPolicy: options.onPolicy });
  if (options.localMode === false) setSetting(sqlDb(backend.store), "app", { localMode: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  const client = new RpcClient(c);
  const [mc, ms] = createMemoryTransportPair();
  backend.connect(ms, { clientId: "mcp", origin: "mcp" });
  const mcp = new RpcClient(mc);
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client, mcp };
}

const url = (host = "127.0.0.1") => `http://${host}:${port}`;
const generate = (client: RpcClient) => client.call("filters.generate", { prompt: "archiva lo de uber.com" });
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: RpcError) => e);

describe("settings: providers and profiles", () => {
  it("new installs start in local mode with AI off; switching providers keeps each profile", async () => {
    const { client } = setup();
    const boot = await client.call("app.bootstrap", {});
    expect(boot.settings.localMode).toBe(true);
    expect(boot.settings.ai).toMatchObject({ provider: "none", hasKey: false, local: true });
    await client.call("settings.update", { ai: { provider: "ollama", model: "qwen3:8b" } });
    await client.call("settings.update", { ai: { provider: "lmstudio", model: "mistral", baseURL: "http://127.0.0.1:4321/v1" } });
    const back = await client.call("settings.update", { ai: { provider: "ollama" } });
    expect(back.ai).toMatchObject({ provider: "ollama", model: "qwen3:8b", baseURL: null, local: true });
    expect(back.ai.profiles.lmstudio).toEqual({ model: "mistral", baseURL: "http://127.0.0.1:4321/v1" });
  });

  it("refuses to select a cloud provider (or a remote endpoint) while local mode is on", async () => {
    const { client } = setup({ dns: { "llm.lan": ["10.0.0.5"], "llm.test": ["127.0.0.1"] } });
    for (const ai of [{ provider: "openai" as const }, { provider: "anthropic" as const }, { provider: "compatible" as const, preset: "openrouter" as const }, { provider: "compatible" as const, baseURL: "http://llm.lan:8080/v1" }]) {
      expect(await errorOf(client.call("settings.update", { ai }))).toMatchObject({ code: "BAD_REQUEST" });
    }
    expect((await client.call("app.bootstrap", {})).settings.ai.provider).toBe("none");
    // a custom endpoint whose name resolves to loopback is a server on this Mac
    await expect(client.call("settings.update", { ai: { provider: "compatible", baseURL: "http://llm.test:8080/v1" } })).resolves.toMatchObject({ ai: { provider: "compatible", preset: "custom" } });
    expect(await errorOf(client.call("settings.update", { ai: { baseURL: "not a url" } }))).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("turning local mode on keeps a cloud provider dormant (paused), and off restores it", async () => {
    const { client } = setup({ localMode: false });
    await client.call("settings.update", { ai: { provider: "openai", model: "gpt-x", baseURL: `${url()}/v1` } });
    await client.call("ai.setKey", { provider: "openai", value: "sk-dormant-0000-1111" });
    const on = await client.call("settings.update", { localMode: true });
    expect(on.ai).toMatchObject({ provider: "openai", local: false });
    expect(await errorOf(generate(client))).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "blocked" }, message: expect.stringMatching(/paused by local mode/), i18n: { key: "errors.ai.pausedByLocalMode", params: { provider: "OpenAI" } } });
    await client.call("settings.update", { localMode: false });
    await expect(generate(client)).resolves.toMatchObject({ name: "Uber" });
  });

  it("tells the host (Electron main's renderer fence) when local mode changes, and only then", async () => {
    const seen: boolean[] = [];
    const { backend, client } = setup({ onPolicy: (p) => seen.push(p.localMode) });
    await backend.publishPolicy();
    await client.call("settings.update", { theme: "dark" });
    await client.call("settings.update", { localMode: false });
    await client.call("settings.update", { localMode: false });
    await client.call("settings.update", { localMode: true });
    expect(seen).toEqual([true, false, true]);
  });

  it("maps pre-v3 settings into the new shape", async () => {
    const { backend, client } = setup();
    setSetting(sqlDb(backend.store), "app", { aiProvider: "anthropic", aiModel: "claude-legacy", theme: "dark" });
    const s = (await client.call("app.bootstrap", {})).settings;
    expect(s.ai).toMatchObject({ provider: "anthropic", model: "claude-legacy" });
    expect(s.theme).toBe("dark");
    expect(JSON.stringify(s)).not.toMatch(/aiProvider|aiModel/);
    // an old install that saved a key but never touched the selector used Anthropic, the old default
    setSetting(sqlDb(backend.store), "app", { localMode: false });
    await backend.setSecret("ai:anthropic:apiKey", "sk-ant-legacy-key-0001");
    expect((await client.call("app.bootstrap", {})).settings.ai).toMatchObject({ provider: "anthropic", hasKey: true });
  });
});

describe("keys never leave the backend", () => {
  it("stores the key through the cipher and exposes only hasKey and its last 4 characters", async () => {
    const { backend, client } = setup({ localMode: false });
    const KEY = "sk-proj-SECRET-abcdef-1234-zzzz-a1b2";
    // the key is saved for the endpoint in use (the stub), and only goes there
    await client.call("settings.update", { ai: { provider: "openai", model: "gpt-x", baseURL: `${url()}/v1` } });
    const results: unknown[] = [];
    results.push(await client.call("ai.setKey", { provider: "openai", value: KEY }));
    // encrypted at rest (plaintextCipher marks what it wrapped); decrypts back for the backend only
    const blob = sqlDb(backend.store).get<{ blob: Uint8Array }>("SELECT blob FROM secrets WHERE name = 'ai:openai:apiKey'")!.blob;
    expect(new TextDecoder().decode(blob)).toBe(`plain:${KEY}`);
    expect(await backend.getSecret("ai:openai:apiKey")).toBe(KEY);
    results.push(await client.call("app.bootstrap", {}));
    results.push(await client.call("settings.update", { theme: "dark" }));
    results.push(await client.call("ai.providers", {}));
    results.push(await client.call("ai.test", { provider: "openai", model: "gpt-x", baseURL: `${url()}/v1` }));
    results.push(await client.call("ai.listModels", { provider: "openai", baseURL: `${url()}/v1` }).catch((e) => e));
    for (const r of results) expect(JSON.stringify(r)).not.toContain("SECRET");
    expect((results[1] as { settings: { ai: object } }).settings.ai).toMatchObject({ hasKey: true, keyHint: "a1b2" });
    // ...but it is what the provider receives
    expect(requests.find((r) => r.url === "/v1/chat/completions")!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("keeps one key per provider and preset; an empty value deletes it", async () => {
    const { backend, client } = setup({ localMode: false });
    await client.call("ai.setKey", { provider: "compatible", preset: "groq", value: "gsk_groq_key_000000001" });
    await client.call("ai.setKey", { provider: "compatible", preset: "openrouter", value: "sk-or-key-00000000002" });
    const groq = await client.call("settings.update", { ai: { provider: "compatible", preset: "groq" } });
    expect(groq.ai).toMatchObject({ hasKey: true, keyHint: "0001" });
    const cleared = await client.call("ai.setKey", { provider: "compatible", preset: "groq", value: "" });
    expect(cleared.ai).toMatchObject({ hasKey: false, keyHint: null });
    expect(await backend.getSecret("ai:compatible:groq:apiKey")).toBeNull();
    expect(await backend.getSecret("ai:compatible:openrouter:apiKey")).toBe("sk-or-key-00000000002");
  });

  it("settings.setSecret no longer accepts AI keys", async () => {
    const { client } = setup();
    expect(await errorOf(client.call("settings.setSecret", { name: "anthropicApiKey" as never, value: "x" }))).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("local mode enforcement (zero connections)", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    it(`${provider} pointed at a reachable stub is blocked without opening a socket`, async () => {
      const { client } = setup({ localMode: false });
      await client.call("settings.update", { ai: { provider, model: "m", baseURL: provider === "openai" ? `${url()}/v1` : url() } });
      await client.call("ai.setKey", { provider, value: "sk-test-key-000000000" });
      await client.call("settings.update", { localMode: true });
      connects.length = 0;
      const err = await errorOf(generate(client));
      expect(err).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "blocked" } });
      const listed = await errorOf(client.call("ai.listModels", { provider, baseURL: url() }));
      expect(listed).toMatchObject({ details: { aiErrorKind: "blocked" } });
      const tested = await client.call("ai.test", { provider, model: "m", baseURL: url() });
      expect(tested).toMatchObject({ ok: false, error: { kind: "blocked" } });
      expect(connections).toBe(0);
      expect(requests).toEqual([]);
      expect(connects).toEqual([]);
    });
  }

  it("a compatible endpoint whose name resolves to the LAN is blocked; one resolving to loopback goes to the IP", async () => {
    const { client } = setup({ dns: { "gpu-box.lan": ["10.0.0.5"], "my-llm.test": ["127.0.0.1"] } });
    await client.call("settings.update", { ai: { provider: "compatible", baseURL: `http://my-llm.test:${port}/v1`, model: "m" } });
    // the saved endpoint later points somewhere else (e.g. edited config): checked again at call time
    await client.call("settings.update", { localMode: false });
    await client.call("settings.update", { ai: { baseURL: `http://gpu-box.lan:${port}/v1` } });
    await client.call("settings.update", { localMode: true });
    expect(await errorOf(generate(client))).toMatchObject({ details: { aiErrorKind: "blocked" } });
    expect(connections).toBe(0);

    await client.call("settings.update", { ai: { baseURL: `http://my-llm.test:${port}/v1` } });
    await expect(generate(client)).resolves.toMatchObject({ name: "Uber" });
    expect(requests.at(-1)!.headers.host).toBe(`127.0.0.1:${port}`);
    expect(connects.every((h) => h === "127.0.0.1")).toBe(true);
  });

  it("an Ollama server on localhost works in local mode end to end (discovery, test, generate)", async () => {
    const { client } = setup();
    await client.call("settings.update", { ai: { provider: "ollama", baseURL: `${url("localhost")}/v1`, model: "qwen3:8b" } });
    const { models } = await client.call("ai.listModels", { provider: "ollama", baseURL: `${url("localhost")}/v1` });
    expect(models).toEqual([{ id: "qwen3:8b", sizeBytes: 5e9, loaded: false, contextTokens: 40960 }]);
    const test = await client.call("ai.test", { provider: "ollama", model: "qwen3:8b", baseURL: `${url("localhost")}/v1` });
    expect(test, JSON.stringify(test)).toMatchObject({ ok: true, capabilities: { output: "json_schema", contextTokens: 40960, probedAt: expect.any(Number) } });
    expect((await client.call("app.bootstrap", {})).settings.ai.capabilities).toMatchObject({ output: "json_schema", contextTokens: 40960 });
    await expect(generate(client)).resolves.toMatchObject({ rule: { conditions: [{ field: "fromDomain", value: "uber.com" }] } });
    expect(requests.at(-1)!.headers.authorization).toBe("Bearer local");
  });
});

describe("ai RPCs", () => {
  it("explains what is missing instead of failing vaguely", async () => {
    const { client } = setup({ localMode: false });
    expect(await errorOf(generate(client))).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "not_configured" } });
    await client.call("settings.update", { ai: { provider: "openai", model: "gpt-x" } });
    expect(await errorOf(generate(client))).toMatchObject({ details: { aiErrorKind: "not_configured" }, message: "Save your OpenAI API key in Settings → AI.", i18n: { key: "errors.ai.keyMissing", params: { provider: "OpenAI" } } });
  });

  it("a newer filters.generate from the same client aborts the previous one", async () => {
    const { client } = setup();
    await client.call("settings.update", { ai: { provider: "ollama", baseURL: `${url()}/v1`, model: "qwen3:8b" } });
    hang = true;
    const first = errorOf(generate(client));
    await new Promise((r) => setTimeout(r, 50));
    hang = false;
    const second = generate(client);
    expect(await first).toMatchObject({ code: "CANCELLED" });
    await expect(second).resolves.toMatchObject({ name: "Uber" });
  });

  it("caches discovered models for a minute per endpoint", async () => {
    const { client } = setup();
    await client.call("ai.listModels", { provider: "ollama", baseURL: `${url()}/v1` });
    const after = requests.length;
    const again = await client.call("ai.listModels", { provider: "ollama", baseURL: `${url()}/v1` });
    expect(requests.length).toBe(after);
    expect(again.models).toHaveLength(1);
    expect(await errorOf(client.call("ai.listModels", { provider: "lmstudio", baseURL: "http://127.0.0.1:1/v1" }))).toMatchObject({ details: { aiErrorKind: "unavailable" } });
  });

  it("only offers the demo model on hosts that allow it", async () => {
    const { client } = setup();
    expect((await client.call("ai.providers", {})).providers.map((p) => p.id)).toContain("fake");
  });

  it("agents (MCP) can't touch AI settings or keys", async () => {
    const { mcp } = setup();
    for (const m of ["ai.providers", "ai.listModels", "ai.test", "ai.setKey", "settings.update"] as const) {
      expect(await errorOf(mcp.call(m, {} as never))).toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

/**
 * The web build runs these transports in a page's worker with the user's
 * own key. The SDKs refuse a browser-like environment unless told otherwise,
 * Anthropic answers a browser only with its opt-in header, and a browser
 * can't tell a server that is down from one refusing the page's origin.
 * The browser is simulated (a `window` with a document, as the SDKs detect
 * it); every request goes to a stub on 127.0.0.1.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAi, discoverModels } from "./tasks";
import type { FilterGenerationContext, ProviderConfig } from "./types";

const ORIGIN = "https://terno.example";
const ctx: FilterGenerationContext = { now: Date.UTC(2026, 9, 22), categories: [{ id: 3, name: "Facturas" }], accounts: [{ id: 1, email: "yo@example.com", displayName: "Yo" }] };
const WIRE = { name: "Uber", explanation: "Archiva recibos de Uber", match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com", negate: false }], actions: [{ type: "addCategory", categoryId: 3 }] };

let server: Server;
let url = "";
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ path: req.url!.split("?")[0]!, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      const text = JSON.stringify(WIRE);
      res.end(
        JSON.stringify(
          req.url!.startsWith("/v1/messages")
            ? { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
            : { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text, refusal: null } }] },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  seen.length = 0;
  // what both SDKs take for a browser
  vi.stubGlobal("window", { document: {} });
});
afterEach(() => vi.unstubAllGlobals());

const base = { fetch, timeoutMs: 5000, maxRetries: 0 };
const providers: [string, Omit<ProviderConfig, "fetch" | "timeoutMs" | "maxRetries">, string][] = [
  ["OpenAI", { id: "openai", model: "gpt-x", apiKey: "sk-user", baseURL: "" }, "/v1/chat/completions"],
  ["OpenRouter", { id: "compatible", preset: "openrouter", model: "x/y", apiKey: "sk-user", baseURL: "" }, "/v1/chat/completions"],
  ["Azure OpenAI", { id: "compatible", preset: "azure", model: "dep", apiKey: "az-user", baseURL: "" }, "/openai/deployments/dep/chat/completions"],
  ["Anthropic", { id: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-user", baseURL: "" }, "/v1/messages"],
];

describe("in a browser (the web build's worker)", () => {
  for (const [name, provider, path] of providers) {
    it(`${name}: a request with the user's own key goes out from the page's worker`, async () => {
      const baseURL = provider.id === "openai" || provider.preset === "openrouter" ? `${url}/v1` : url;
      const f = await createAi({ ...base, ...provider, baseURL, browserOrigin: ORIGIN }).generateFilter("archiva lo de uber", ctx);
      expect(f.name).toBe("Uber");
      expect(seen.map((r) => r.path)).toEqual([path]);
      const key = provider.apiKey!;
      const h = seen[0]!.headers;
      expect(h.authorization === `Bearer ${key}` || h["x-api-key"] === key || h["api-key"] === key).toBe(true);
      // without it the Anthropic API refuses the browser's request (CORS)
      if (provider.id === "anthropic") expect(h["anthropic-dangerous-direct-browser-access"]).toBe("true");
    });
  }

  it("without the page's origin the OpenAI SDK refuses to run there, and nothing is sent", async () => {
    await expect(createAi({ ...base, id: "openai", model: "gpt-x", apiKey: "sk-user", baseURL: `${url}/v1` }).generateFilter("x", ctx)).rejects.toThrow(/browser/);
    expect(seen).toEqual([]);
  });

  it("Ollama refusing the page's origin (or not running) says how to allow it: OLLAMA_ORIGINS", async () => {
    // what a browser's fetch gives for a CORS refusal and for a closed port alike
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const ollama: ProviderConfig = { ...base, fetch: failing, id: "ollama", model: "qwen3", apiKey: null, browserOrigin: ORIGIN };
    const hint = `permite el origen ${ORIGIN} en Ollama: OLLAMA_ORIGINS=${ORIGIN}`;
    await expect(discoverModels(ollama, new AbortController().signal)).rejects.toThrow(hint);
    await expect(createAi(ollama).generateFilter("x", ctx)).rejects.toThrow(hint);
    // LM Studio has a switch for it; a cloud API that fails says what it may be
    await expect(createAi({ ...ollama, id: "lmstudio" }).generateFilter("x", ctx)).rejects.toThrow(/activa CORS en LM Studio/);
    await expect(createAi({ ...ollama, id: "openai", apiKey: "sk-user" }).generateFilter("x", ctx)).rejects.toThrow(/no acepta peticiones desde una página web \(CORS\)/);
  });
});

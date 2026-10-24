/**
 * Provider contract: every wire protocol and preset behaves the same towards
 * tasks. Each provider runs the same suite against a local stub HTTP server
 * that speaks its dialect; nothing here leaves 127.0.0.1.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAi, discoverModels, probe } from "./tasks";
import type { FilterGenerationContext, ProviderConfig } from "./types";
import type { WireFilter } from "./wire";

const ctx: FilterGenerationContext = {
  now: Date.UTC(2026, 9, 22),
  categories: [{ id: 3, name: "Facturas" }],
  accounts: [{ id: 1, email: "luis@acme.studio", displayName: "Acme" }],
};
const WIRE: WireFilter = {
  name: "Uber",
  explanation: "Archiva recibos de Uber",
  match: "all",
  conditions: [{ field: "fromDomain", op: "equals", value: "uber.com", negate: false }],
  actions: [{ type: "addCategory", categoryId: 3 }],
};
const INVALID: WireFilter = { ...WIRE, actions: [] };

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
}
type Reply = { status: number; json?: unknown; headers?: Record<string, string> } | "hang";

/** A programmable stand-in for a provider's HTTP API. */
class Stub {
  server!: Server;
  requests: Recorded[] = [];
  connections = 0;
  private hung: import("node:http").ServerResponse[] = [];
  handle: (req: Recorded) => Reply = () => ({ status: 500, json: { error: { message: "unscripted" } } });

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const rec: Recorded = { method: req.method!, url: req.url!, headers: req.headers, body: data ? JSON.parse(data) : null };
        this.requests.push(rec);
        const out = this.handle(rec);
        if (out === "hang") return void this.hung.push(res);
        res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
        res.end(out.json === undefined ? "" : JSON.stringify(out.json));
      });
    });
    this.server.on("connection", () => this.connections++);
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  reset() {
    this.requests = [];
    // only hung requests: closing idle keep-alive sockets races the client's connection reuse
    for (const res of this.hung.splice(0)) res.destroy();
  }
  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }
}

type Stop = "end" | "length" | "refusal";

/** How a provider's dialect looks on the wire. */
interface Dialect {
  chatPath: string;
  reply(text: string, stop?: Stop): unknown;
  error(status: number, message: string): unknown;
  system(body: any): string;
  structured(body: any): boolean;
  lastUser(body: any): string;
}

const openaiDialect = (chatPath: string): Dialect => ({
  chatPath,
  reply: (text, stop = "end") => ({
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, finish_reason: stop === "length" ? "length" : "stop", message: { role: "assistant", content: stop === "refusal" ? null : text, refusal: stop === "refusal" ? "I can't help with that." : null } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }),
  error: (status, message) => ({ error: { message, type: status === 401 ? "invalid_request_error" : "error", code: null } }),
  system: (b) => b.messages[0].content,
  structured: (b) => b.response_format?.type === "json_schema",
  lastUser: (b) => b.messages.at(-1).content,
});

const anthropicDialect: Dialect = {
  chatPath: "/v1/messages",
  reply: (text, stop = "end") => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: stop === "refusal" ? [] : [{ type: "text", text }],
    stop_reason: stop === "refusal" ? "refusal" : stop === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  }),
  error: (status, message) => ({ type: "error", error: { type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "invalid_request_error", message } }),
  system: (b) => b.system,
  structured: (b) => b.output_config?.format?.type === "json_schema",
  lastUser: (b) => b.messages.at(-1).content,
};

interface Contract {
  name: string;
  dialect: Dialect;
  config: (url: string) => Pick<ProviderConfig, "id" | "baseURL" | "preset" | "apiKey" | "model" | "capabilities">;
  checkRequest: (req: Recorded) => void;
}

function describeProviderContract(c: Contract) {
  describe(`${c.name} provider contract`, () => {
    const stub = new Stub();
    let url = "";
    beforeAll(async () => {
      url = await stub.start();
    });
    afterEach(() => stub.reset());
    afterAll(() => stub.stop());

    const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ ...c.config(url), fetch, timeoutMs: 5000, maxRetries: 0, ...over });
    const chat = (fn: (req: Recorded, n: number) => Reply) => {
      let n = 0;
      stub.handle = (req) => (req.url.split("?")[0] === c.dialect.chatPath ? fn(req, n++) : { status: 404, json: c.dialect.error(404, `no route ${req.url}`) });
    };
    const ok = (wire: unknown = WIRE): Reply => ({ status: 200, json: c.dialect.reply(JSON.stringify(wire)) });

    it("sends a well-formed structured request and returns a validated filter", async () => {
      chat(() => ok());
      const f = await createAi(config()).generateFilter("archiva lo de uber en facturas", ctx);
      expect(f).toEqual({
        name: "Uber",
        explanation: "Archiva recibos de Uber",
        rule: { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "uber.com" }], actions: [{ type: "addCategory", categoryId: 3 }] },
      });
      const req = stub.requests[0]!;
      expect(req.method).toBe("POST");
      c.checkRequest(req);
      expect(c.dialect.structured(req.body)).toBe(true);
      expect(c.dialect.system(req.body)).toContain("Facturas");
      expect(c.dialect.lastUser(req.body)).toBe("archiva lo de uber en facturas");
    });

    it("feeds the validation error back in a repair turn", async () => {
      chat((_, n) => ok(n === 0 ? INVALID : WIRE));
      await createAi(config()).generateFilter("x", ctx);
      expect(stub.requests).toHaveLength(2);
      expect(c.dialect.lastUser(stub.requests[1]!.body)).toMatch(/invalid: .*actions/);
    });

    it("maps 401 to auth", async () => {
      chat(() => ({ status: 401, json: c.dialect.error(401, "bad key") }));
      await expect(createAi(config()).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "auth" });
    });

    it("maps 429 to rate_limited after honouring retry-after", async () => {
      chat(() => ({ status: 429, json: c.dialect.error(429, "slow down"), headers: { "retry-after": "0" } }));
      await expect(createAi(config({ maxRetries: 1 })).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "rate_limited" });
      expect(stub.requests).toHaveLength(2);
    });

    it("maps a hanging server to timeout", async () => {
      chat(() => "hang");
      const started = performance.now();
      await expect(createAi(config({ timeoutMs: 200 })).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "timeout" });
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it("maps refusals to refused and truncation to invalid_output", async () => {
      chat(() => ({ status: 200, json: c.dialect.reply("", "refusal") }));
      await expect(createAi(config()).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "refused" });
      chat(() => ({ status: 200, json: c.dialect.reply('{"name": "Ub', "length") }));
      await expect(createAi(config()).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "invalid_output" });
    });

    it("rejects quickly when aborted", async () => {
      chat(() => "hang");
      const controller = new AbortController();
      const started = performance.now();
      const pending = createAi(config()).generateFilter("x", ctx, controller.signal);
      setTimeout(() => controller.abort(), 30);
      await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
      expect(performance.now() - started).toBeLessThan(500);
    });

    it("downgrades to a schema-in-prompt request when the server rejects structured output", async () => {
      const outputs: string[] = [];
      chat((req, n) => {
        if (n === 0) return { status: 400, json: c.dialect.error(400, "response_format json_schema is not supported by this model") };
        return ok();
      });
      await createAi(config(), { onCapabilities: (cap) => outputs.push(cap.output) }).generateFilter("x", ctx);
      expect(stub.requests).toHaveLength(2);
      expect(c.dialect.structured(stub.requests[1]!.body)).toBe(false);
      expect(c.dialect.system(stub.requests[1]!.body)).toMatch(/JSON Schema[\s\S]*"conditions"[\s\S]*Example:/);
      expect(outputs).toEqual(["json_object"]);
    });

    it("handles <think> blocks and code fences from text-mode models", async () => {
      chat(() => ({ status: 200, json: c.dialect.reply(`<think>uber → facturas</think>\n\`\`\`json\n${JSON.stringify(WIRE)}\n\`\`\``) }));
      const ai = createAi(config({ capabilities: { output: "text", contextTokens: null, embeddings: false, probedAt: 1 } }));
      await expect(ai.generateFilter("x", ctx)).resolves.toMatchObject({ name: "Uber" });
      expect(c.dialect.structured(stub.requests[0]!.body)).toBe(false);
    });

    it("sends malformed JSON to repair", async () => {
      chat((_, n) => (n === 0 ? { status: 200, json: c.dialect.reply("{ not json") } : ok()));
      await expect(createAi(config({ capabilities: { output: "json_object", contextTokens: null, embeddings: false, probedAt: 1 } })).generateFilter("x", ctx)).resolves.toMatchObject({
        name: "Uber",
      });
      expect(c.dialect.lastUser(stub.requests[1]!.body)).toMatch(/malformed JSON|no JSON object/);
    });
  });
}

const PROBED_SCHEMA = { output: "json_schema", contextTokens: null, embeddings: false, probedAt: 1 } as const;
const openaiAuth = (key: string) => (req: Recorded) => expect(req.headers.authorization).toBe(`Bearer ${key}`);

describeProviderContract({
  name: "anthropic",
  dialect: anthropicDialect,
  config: (url) => ({ id: "anthropic", baseURL: url, apiKey: "sk-ant-test", model: "claude-opus-5-5" }),
  checkRequest: (req) => {
    expect(req.url).toBe("/v1/messages?beta=true");
    expect(req.headers.authorization).toBe("Bearer sk-ant-test");
    expect(req.body.model).toBe("claude-opus-5-5");
    expect(req.body.output_config.effort).toBe("low");
    expect(req.body.output_config.format.schema.properties.conditions).toBeDefined();
  },
});

describeProviderContract({
  name: "openai",
  dialect: openaiDialect("/v1/chat/completions"),
  config: (url) => ({ id: "openai", baseURL: `${url}/v1`, apiKey: "sk-openai-test", model: "gpt-5.2-mini" }),
  checkRequest: (req) => {
    openaiAuth("sk-openai-test")(req);
    expect(req.headers["openai-organization"]).toBeUndefined();
    expect(req.headers["openai-project"]).toBeUndefined();
    expect(req.body.model).toBe("gpt-5.2-mini");
    expect(req.body.max_completion_tokens).toBeGreaterThan(0);
    expect(req.body.response_format.json_schema).toMatchObject({ name: "filter", strict: true });
  },
});

describeProviderContract({
  name: "compatible (OpenRouter)",
  dialect: openaiDialect("/api/v1/chat/completions"),
  // as after a successful Test connection: compatible servers are not assumed to do json_schema
  config: (url) => ({ id: "compatible", preset: "openrouter", baseURL: `${url}/api/v1`, apiKey: "sk-or-test", model: "qwen/qwen3-32b", capabilities: PROBED_SCHEMA }),
  checkRequest: (req) => {
    openaiAuth("sk-or-test")(req);
    expect(req.headers["http-referer"]).toBe("https://terno.app");
    expect(req.headers["x-title"]).toBe("Terno");
    expect(req.body.max_tokens).toBeGreaterThan(0);
    expect(req.body.response_format.json_schema).toMatchObject({ name: "filter", strict: true });
  },
});

describeProviderContract({
  name: "compatible (Azure)",
  dialect: openaiDialect("/openai/deployments/terno-gpt/chat/completions"),
  config: (url) => ({ id: "compatible", preset: "azure", baseURL: url, apiKey: "azure-key", model: "terno-gpt", capabilities: PROBED_SCHEMA }),
  checkRequest: (req) => {
    expect(req.headers["api-key"]).toBe("azure-key");
    expect(req.headers.authorization).toBeUndefined();
    expect(new URL(req.url, "http://x").searchParams.get("api-version")).toBe("2024-10-21");
    expect(req.body.response_format.json_schema).toMatchObject({ name: "filter", strict: true });
  },
});

describeProviderContract({
  name: "ollama",
  dialect: openaiDialect("/v1/chat/completions"),
  config: (url) => ({ id: "ollama", baseURL: `${url}/v1`, apiKey: null, model: "qwen3:8b" }),
  checkRequest: (req) => {
    // no user key exists for local servers: only the SDK-required placeholder is sent
    openaiAuth("local")(req);
    expect(req.body.model).toBe("qwen3:8b");
    expect(req.body.response_format.json_schema).toMatchObject({ name: "filter", strict: true });
  },
});

describeProviderContract({
  name: "lmstudio",
  dialect: openaiDialect("/v1/chat/completions"),
  config: (url) => ({ id: "lmstudio", baseURL: `${url}/v1`, apiKey: null, model: "qwen2.5-7b-instruct" }),
  checkRequest: (req) => {
    openaiAuth("local")(req);
    expect(req.body.response_format.json_schema).toMatchObject({ name: "filter", strict: true });
  },
});

describe("model discovery", () => {
  const stub = new Stub();
  let url = "";
  beforeAll(async () => {
    url = await stub.start();
  });
  afterEach(() => stub.reset());
  afterAll(() => stub.stop());
  const cfg = (over: Partial<ProviderConfig>): ProviderConfig => ({ id: "ollama", model: "", apiKey: null, fetch, timeoutMs: 3000, maxRetries: 0, baseURL: `${url}/v1`, ...over });

  it("Ollama: lists /api/tags, marks loaded models and reads the selected model's context from /api/show", async () => {
    stub.handle = (req) => {
      if (req.url === "/api/tags") return { status: 200, json: { models: [{ name: "qwen3:8b", size: 5_200_000_000 }, { name: "llama3.2:latest", size: 2_000_000_000 }] } };
      if (req.url === "/api/ps") return { status: 200, json: { models: [{ name: "qwen3:8b" }] } };
      if (req.url === "/api/show") return { status: 200, json: { model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 } } };
      return { status: 404 };
    };
    const models = await discoverModels(cfg({ model: "qwen3:8b" }), AbortSignal.timeout(2000));
    expect(models).toEqual([
      { id: "qwen3:8b", sizeBytes: 5_200_000_000, loaded: true, contextTokens: 40960 },
      { id: "llama3.2:latest", sizeBytes: 2_000_000_000, loaded: false },
    ]);
    expect(stub.requests.find((r) => r.url === "/api/show")!.body).toEqual({ model: "qwen3:8b" });
  });

  it("LM Studio: prefers /api/v0 (context, loaded state, no embedding models)", async () => {
    stub.handle = (req) =>
      req.url === "/api/v0/models"
        ? {
            status: 200,
            json: {
              data: [
                { id: "qwen2.5-7b-instruct", type: "llm", state: "loaded", max_context_length: 32768 },
                { id: "nomic-embed", type: "embeddings", state: "not-loaded", max_context_length: 2048 },
              ],
            },
          }
        : { status: 404 };
    expect(await discoverModels(cfg({ id: "lmstudio" }), AbortSignal.timeout(2000))).toEqual([{ id: "qwen2.5-7b-instruct", contextTokens: 32768, loaded: true }]);
  });

  it("LM Studio: falls back to /v1/models when /api/v0 is missing", async () => {
    stub.handle = (req) =>
      req.url === "/v1/models" ? { status: 200, json: { object: "list", data: [{ id: "mistral-7b", object: "model", created: 0, owned_by: "x" }] } } : { status: 404, json: {} };
    expect(await discoverModels(cfg({ id: "lmstudio" }), AbortSignal.timeout(2000))).toEqual([{ id: "mistral-7b" }]);
    expect(stub.requests.map((r) => r.url)).toEqual(["/api/v0/models", "/v1/models"]);
  });

  it("OpenAI-compatible: paginates /v1/models with the key and keeps context lengths servers add", async () => {
    stub.handle = () => ({ status: 200, json: { object: "list", data: [{ id: "qwen/qwen3-32b", name: "Qwen3 32B", context_length: 131072, object: "model", created: 0, owned_by: "x" }] } });
    const models = await discoverModels(cfg({ id: "compatible", preset: "openrouter", apiKey: "sk-or", baseURL: `${url}/api/v1` }), AbortSignal.timeout(2000));
    expect(models).toEqual([{ id: "qwen/qwen3-32b", label: "Qwen3 32B", contextTokens: 131072 }]);
    expect(stub.requests[0]!.headers.authorization).toBe("Bearer sk-or");
  });

  it("a closed local port is 'unavailable' with a hint, in well under 100 ms", async () => {
    const closed = new Stub();
    const closedUrl = await closed.start();
    closed.stop();
    await new Promise((r) => setTimeout(r, 10));
    const started = performance.now();
    const err = await discoverModels(cfg({ baseURL: `${closedUrl}/v1` }), AbortSignal.timeout(2000)).catch((e) => e);
    expect(performance.now() - started).toBeLessThan(100);
    expect(err).toMatchObject({ kind: "unavailable", message: expect.stringMatching(/No encontramos Ollama en 127\.0\.0\.1:\d+/) });
    const chatErr = await createAi(cfg({ baseURL: `${closedUrl}/v1`, model: "qwen3:8b" })).generateFilter("x", ctx).catch((e) => e);
    expect(chatErr).toMatchObject({ kind: "unavailable" });
  });

  it("an unprobed compatible server is asked for json_object; the strict schema sent to json_schema servers is pinned", async () => {
    let schema: unknown;
    stub.handle = (req) => {
      if (req.body.response_format?.type === "json_schema") schema = req.body.response_format.json_schema.schema;
      return { status: 200, json: openaiDialect("").reply(JSON.stringify(WIRE)) };
    };
    await createAi(cfg({ id: "compatible", preset: "custom", model: "m" })).generateFilter("x", ctx);
    expect(stub.requests[0]!.body.response_format).toEqual({ type: "json_object" });
    await createAi(cfg({ id: "openai", apiKey: "k", model: "m" })).generateFilter("x", ctx);
    expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|format|pattern)"/);
    expect(schema).toMatchSnapshot();
  });

  it("probe walks the ladder from the top and reports latency, real output mode and a context warning", async () => {
    stub.handle = (req) => {
      if (req.url === "/v1/chat/completions") {
        if (req.body.response_format?.type === "json_schema") return { status: 400, json: { error: { message: "Invalid schema for response_format 'probe'" } } };
        return { status: 200, json: openaiDialect("").reply('{"ok": true}') };
      }
      if (req.url === "/api/tags") return { status: 200, json: { models: [{ name: "tiny:1b", size: 1 }] } };
      if (req.url === "/api/show") return { status: 200, json: { model_info: { "llama.context_length": 2048 } } };
      return { status: 404, json: {} };
    };
    const result = await probe(cfg({ model: "tiny:1b" }), AbortSignal.timeout(3000));
    expect(result.capabilities).toMatchObject({ output: "json_object", contextTokens: 2048, embeddings: true, probedAt: expect.any(Number) });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.warning).toMatch(/2048|2\.048/);
  });
});

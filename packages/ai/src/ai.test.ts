import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeTransport } from "./fake";
import { extractJsonObject } from "./json";
import { createAi } from "./tasks";
import { AiError, type CompletionRequest, type FilterGenerationContext, type ModelTransport, type ProviderConfig } from "./types";
import { convertWireFilter, wireFilterSchema, type WireFilter } from "./wire";

const ctx: FilterGenerationContext = {
  now: Date.UTC(2026, 9, 22),
  categories: [{ id: 3, name: "Facturas" }],
  accounts: [{ id: 1, email: "luis@acme.studio", displayName: "Acme" }],
};

const wire = (over: Partial<WireFilter> = {}): WireFilter => ({
  name: "Uber",
  explanation: "Archiva recibos de Uber",
  match: "all",
  conditions: [{ field: "fromDomain", op: "equals", value: "uber.com", negate: false }],
  actions: [{ type: "archive", categoryId: null }],
  ...over,
});

describe("convertWireFilter", () => {
  it("converts typed values and drops false negations", () => {
    const r = convertWireFilter(
      wire({
        conditions: [
          { field: "hasAttachment", op: "is", value: "true", negate: false },
          { field: "ageDays", op: "gt", value: "30", negate: true },
          { field: "account", op: "is", value: "1", negate: false },
        ],
        actions: [{ type: "addCategory", categoryId: 3 }],
      }),
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      name: "Uber",
      explanation: "Archiva recibos de Uber",
      rule: {
        match: "all",
        conditions: [
          { field: "hasAttachment", op: "is", value: true },
          { field: "ageDays", op: "gt", value: 30, negate: true },
          { field: "account", op: "is", value: 1 },
        ],
        actions: [{ type: "addCategory", categoryId: 3 }],
      },
    });
  });

  it("reports every problem in one message (fed back to the model)", () => {
    const r = convertWireFilter(
      wire({
        conditions: [
          { field: "account", op: "is", value: "99", negate: false },
          { field: "subject", op: "gt", value: "x", negate: false },
        ],
        actions: [{ type: "addCategory", categoryId: 42 }],
      }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("account 99 does not exist");
      expect(r.error).toContain("addCategory needs an existing categoryId");
      expect(r.error).toContain("conditions.1");
    }
    const conflicting = convertWireFilter(wire({ actions: [{ type: "archive", categoryId: null }, { type: "spam", categoryId: null }] }), ctx);
    expect(conflicting.ok === false && conflicting.error).toContain("only move mail to one place");
  });
});

describe("wire schema", () => {
  it("stays primitive for strict grammars (no integer bounds) and its JSON Schema doesn't drift", () => {
    const schema = z.toJSONSchema(wireFilterSchema);
    expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|format|pattern)"/);
    expect(schema).toMatchSnapshot();
  });

  it("rejects fractional ids and days that the schema now lets through", () => {
    const r = convertWireFilter(
      wire({ conditions: [{ field: "ageDays", op: "gt", value: "2.5", negate: false }], actions: [{ type: "addCategory", categoryId: 3.5 }] }),
      ctx,
    );
    expect(r.ok === false && r.error).toMatch(/ageDays value must be a whole number.*addCategory needs an existing categoryId/);
  });
});

describe("extractJsonObject", () => {
  it("strips reasoning and code fences and takes the first balanced object", () => {
    expect(extractJsonObject('<think>maybe {"a": 1}?</think>\nSure:\n```json\n{"a": {"b": "}"}, "c": 2}\n```\nmore {"d":3}')).toBe('{"a": {"b": "}"}, "c": 2}');
    expect(extractJsonObject('</think>{"x":"\\"}"}')).toBe('{"x":"\\"}"}');
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject('{"open": true')).toBeNull();
  });
});

/** A transport that replays scripted replies and records every request. */
function scripted(replies: (string | Error | ((req: CompletionRequest) => string | Error))[]): ModelTransport & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] });
      const next = replies.shift();
      if (next === undefined) throw new Error("no more scripted replies");
      const out = typeof next === "function" ? next(req) : next;
      if (out instanceof Error) throw out;
      return { text: out, stop: "end" };
    },
  };
}

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "ollama",
  model: "qwen3:8b",
  apiKey: null,
  fetch,
  timeoutMs: 1000,
  maxRetries: 0,
  ...over,
});

const good = JSON.stringify(wire());

describe("the fallback ladder", () => {
  it("repairs once in json_schema mode, feeding the validation error back", async () => {
    const t = scripted([JSON.stringify(wire({ actions: [] })), good]);
    const out = await createAi(config(), { transport: t }).generateFilter("archiva uber", ctx);
    expect(out.rule.actions).toEqual([{ type: "archive" }]);
    expect(t.requests).toHaveLength(2);
    const repair = t.requests[1]!.messages;
    expect(repair.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repair[2]!.content).toMatch(/invalid: .*actions/);
  });

  it("gives up after the repair budget with a typed error", async () => {
    const bad = JSON.stringify(wire({ conditions: [] }));
    const t = scripted([bad, bad, bad]);
    await expect(createAi(config(), { transport: t }).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(t.requests).toHaveLength(2); // json_schema: 1 repair
  });

  it("downgrades json_schema → json_object on rejection without spending a repair, and reports it", async () => {
    const seen: string[] = [];
    const t = scripted([new AiError("response_format json_schema is not supported", "unsupported"), "not json", JSON.stringify(wire({ actions: [] })), good]);
    const ai = createAi(config(), { transport: t, onCapabilities: (c) => seen.push(c.output) });
    await expect(ai.generateFilter("archiva uber", ctx)).resolves.toMatchObject({ name: "Uber" });
    expect(t.requests.map((r) => r.output)).toEqual(["json_schema", "json_object", "json_object", "json_object"]);
    expect(seen).toEqual(["json_object"]);
    // weaker modes carry the schema and an example in the system prompt
    expect(t.requests[1]!.system).toContain('"conditions"');
    expect(t.requests[1]!.system).toContain("Example:");
    expect(t.requests[0]!.system).not.toContain("Example:");
    // the session remembers: the next call starts at json_object
    t.requests.length = 0;
    const again = scripted([good]);
    const ai2 = createAi(config({ capabilities: { output: "json_object", contextTokens: null, embeddings: false, probedAt: 1 } }), { transport: again });
    await ai2.generateFilter("x", ctx);
    expect(again.requests[0]!.output).toBe("json_object");
  });

  it("falls to text mode and extracts JSON from reasoning and fences", async () => {
    const t = scripted([
      new AiError("response_format is not supported", "unsupported"),
      new AiError("json_object is not supported", "unsupported"),
      `<think>The user wants uber.</think>\n\`\`\`json\n${good}\n\`\`\``,
    ]);
    await expect(createAi(config(), { transport: t }).generateFilter("x", ctx)).resolves.toMatchObject({ rule: { match: "all" } });
    expect(t.requests.map((r) => r.output)).toEqual(["json_schema", "json_object", "text"]);
  });

  it("sends malformed JSON and wrong shapes to repair instead of throwing", async () => {
    const t = scripted(['{"name": "Uber", ', JSON.stringify({ name: 1 }), good]);
    const ai = createAi(config({ capabilities: { output: "text", contextTokens: null, embeddings: false, probedAt: 1 } }), { transport: t });
    await expect(ai.generateFilter("x", ctx)).resolves.toMatchObject({ name: "Uber" });
    expect(t.requests[1]!.messages.at(-1)!.content).toMatch(/no JSON object|malformed/);
    expect(t.requests[2]!.messages.at(-1)!.content).toMatch(/name/);
  });

  it("maps refusal and truncation to typed errors without repairing", async () => {
    const refusal: ModelTransport = { complete: async () => ({ text: "", stop: "refusal" }) };
    await expect(createAi(config(), { transport: refusal }).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "refused" });
    const cut: ModelTransport = { complete: async () => ({ text: '{"name":', stop: "length" }) };
    await expect(createAi(config(), { transport: cut }).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("propagates non-downgradable transport errors as they are", async () => {
    const t = scripted([new AiError("bad key", "auth")]);
    await expect(createAi(config(), { transport: t }).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "auth" });
    expect(t.requests).toHaveLength(1);
  });

  it("aborts quickly and enforces the total deadline across steps", async () => {
    const hang: ModelTransport = {
      complete: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    };
    const controller = new AbortController();
    const started = performance.now();
    const pending = createAi(config(), { transport: hang }).generateFilter("x", ctx, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(performance.now() - started).toBeLessThan(500);
    await expect(createAi(config(), { transport: hang, deadlineMs: 50 }).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("fake model", () => {
  it("runs through the real ladder, exercises the repair path and understands Spanish prompts", async () => {
    const transport = fakeTransport({ failFirstAttempt: true });
    const f = await createAi(config({ id: "fake" }), { transport }).generateFilter('Borra los correos de promo@tienda.mx con "oferta" de más de 30 días', ctx);
    expect(transport.calls).toBe(2);
    expect(f.rule).toEqual({
      match: "all",
      conditions: [
        { field: "from", op: "equals", value: "promo@tienda.mx" },
        { field: "subject", op: "contains", value: "oferta" },
        { field: "ageDays", op: "gt", value: 30 },
      ],
      actions: [{ type: "trash" }],
    });
  });

  it("reads categories from the same system prompt a real model gets", async () => {
    const f = await createAi(config({ id: "fake" })).generateFilter("archiva lo de uber.com en facturas", ctx);
    expect(f.rule.actions).toEqual([{ type: "archive" }, { type: "addCategory", categoryId: 3 }]);
  });
});

describe("classify", () => {
  it("labels items through the ladder and repairs missing or invented ids", async () => {
    const labels = ["Facturas", "Viajes"] as const;
    const t = scripted([
      JSON.stringify({ results: [{ id: "a", label: "Facturas", confidence: 1.4 }, { id: "zz", label: null, confidence: 0 }] }),
      JSON.stringify({ results: [{ id: "a", label: "Facturas", confidence: 1.4 }, { id: "b", label: null, confidence: 0.1 }] }),
    ]);
    const out = await createAi(config(), { transport: t }).classify({ items: [{ id: "a", text: "Tu factura" }, { id: "b", text: "Hola" }], labels, instructions: "Email triage." });
    expect(out).toEqual([
      { id: "a", label: "Facturas", confidence: 1 },
      { id: "b", label: null, confidence: 0.1 },
    ]);
    expect(t.requests[1]!.messages.at(-1)!.content).toMatch(/missing ids b; unknown ids zz/);
    // the label set is enforced by the schema, not trusted from the model
    const strict = scripted([JSON.stringify({ results: [{ id: "a", label: "Spam", confidence: 1 }] }), JSON.stringify({ results: [{ id: "a", label: "Viajes", confidence: 1 }] })]);
    await expect(createAi(config(), { transport: strict }).classify({ items: [{ id: "a", text: "x" }], labels, instructions: "" })).resolves.toEqual([{ id: "a", label: "Viajes", confidence: 1 }]);
  });
});

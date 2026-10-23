import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "./anthropic";
import { createFakeProvider } from "./fake";
import { generateWithRepair, type WireCall } from "./generate";
import { AiError, type FilterGenerationContext } from "./types";
import { convertWireFilter, type WireFilter } from "./wire";

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

describe("generateWithRepair", () => {
  it("retries once with the validation error and succeeds", async () => {
    const seen: (string | undefined)[] = [];
    const call: WireCall = async ({ repair }) => {
      seen.push(repair?.error);
      return repair ? wire() : wire({ actions: [] });
    };
    const out = await generateWithRepair(call, "archiva uber", ctx);
    expect(out.rule.actions).toEqual([{ type: "archive" }]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/actions/);
  });

  it("gives up after the repair attempt with a typed error", async () => {
    const call: WireCall = async () => wire({ conditions: [] });
    await expect(generateWithRepair(call, "x", ctx)).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("fake provider exercises the repair path and understands Spanish prompts", async () => {
    const ai = createFakeProvider({ failFirstAttempt: true }) as ReturnType<typeof createFakeProvider> & { calls: number };
    const f = await ai.generateFilter('Borra los correos de promo@tienda.mx con "oferta" de más de 30 días', ctx);
    expect(ai.calls).toBe(2);
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
});

describe("anthropic provider (against a local stub of the Messages API)", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function stub(handler: (body: any) => { status: number; json: unknown }) {
    const requests: any[] = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data);
        requests.push({ body, headers: req.headers, url: req.url });
        const out = handler(body);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { baseURL: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, requests };
  }

  const message = (text: string, stop_reason = "end_turn") => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });

  it("sends a structured-output request and returns a validated filter", async () => {
    const { baseURL, requests } = await stub(() => ({ status: 200, json: message(JSON.stringify(wire())) }));
    const ai = createAnthropicProvider({ apiKey: "sk-test", baseURL });
    const f = await ai.generateFilter("archiva todo lo de uber", ctx);
    expect(f.rule.conditions).toEqual([{ field: "fromDomain", op: "equals", value: "uber.com" }]);
    const req = requests[0]!;
    expect(req.url).toContain("/v1/messages");
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.body.model).toBe("claude-opus-5-5");
    expect(req.body.output_config.format.type).toBe("json_schema");
    expect(req.body.output_config.effort).toBe("low");
    expect(req.body.fallbacks).toBe("default");
    expect(req.body.system).toContain("Facturas");
  });

  it("feeds validation errors back in a repair turn", async () => {
    let n = 0;
    const { baseURL, requests } = await stub(() => ({
      status: 200,
      json: message(JSON.stringify(n++ === 0 ? wire({ actions: [] }) : wire())),
    }));
    await createAnthropicProvider({ apiKey: "k", baseURL }).generateFilter("x", ctx);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.messages.at(-1).content).toMatch(/invalid/);
  });

  it("maps refusals and auth errors to typed AiErrors", async () => {
    const refusal = await stub(() => ({ status: 200, json: message("", "refusal") }));
    await expect(createAnthropicProvider({ apiKey: "k", baseURL: refusal.baseURL }).generateFilter("x", ctx)).rejects.toMatchObject({ kind: "refused" });
    server!.close();
    const auth = await stub(() => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "bad key" } } }));
    const err = await createAnthropicProvider({ apiKey: "k", baseURL: auth.baseURL }).generateFilter("x", ctx).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe("auth");
  });
});

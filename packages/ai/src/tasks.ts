import { z } from "zod";
import { anthropicTransport } from "./anthropic";
import { fakeTransport } from "./fake";
import { runStructured, type StructuredTask } from "./ladder";
import { describeProvider, isLocalProvider } from "./providers";
import { AiError, type AiTasks, type Capabilities, type ClassifyInput, type ModelInfo, type ModelTransport, type OutputMode, type ProviderConfig } from "./types";
import { convertWireFilter, EXAMPLE_WIRE_FILTER, systemPrompt, wireFilterSchema } from "./wire";

/** Rough size of the filter system prompt + schema, for the context-window warning. */
export const FILTER_PROMPT_TOKENS = 1500;
export const FILTER_MAX_TOKENS = 4000;
/** One filters.generate, downgrades and repairs included; below the 120 s RPC timeout. */
export const GENERATE_DEADLINE_MS = 100_000;

export function transportFor(config: ProviderConfig): ModelTransport {
  switch (config.id) {
    case "anthropic":
      return anthropicTransport(config);
    case "openai":
    case "compatible":
    case "ollama":
    case "lmstudio":
      throw new AiError("OpenAI-compatible providers are not available yet.", "not_configured");
    case "fake":
      return fakeTransport();
    case "none":
      throw new AiError("La IA está desactivada.", "not_configured");
  }
}

/** Runs fn under the caller's signal plus a total deadline, mapping aborts to typed errors. */
async function withDeadline<T>(outer: AbortSignal | undefined, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  const signal = outer ? AbortSignal.any([outer, deadline]) : deadline;
  try {
    return await fn(signal);
  } catch (error) {
    if (outer?.aborted) throw new AiError("Cancelado.", "cancelled");
    if (deadline.aborted) throw new AiError("La IA tardó demasiado en responder.", "timeout");
    if (error instanceof AiError) throw error;
    throw new AiError(error instanceof Error ? error.message : String(error), "unavailable");
  }
}

export interface AiOptions {
  /** total time per task call (all ladder steps); defaults to GENERATE_DEADLINE_MS */
  deadlineMs?: number;
  /** the ladder learned the server can't do the current output mode */
  onCapabilities?: (capabilities: Capabilities) => void;
  /** tests inject a scripted transport */
  transport?: ModelTransport;
}

export function createAi(config: ProviderConfig, options: AiOptions = {}): AiTasks {
  const descriptor = describeProvider(config.id);
  const transport = options.transport ?? transportFor(config);
  let capabilities: Capabilities = config.capabilities ?? { output: descriptor.declared.output, contextTokens: null, embeddings: descriptor.declared.embeddings, probedAt: null };
  const run = <W, T>(task: StructuredTask<W, T>, signal?: AbortSignal) =>
    withDeadline(signal, options.deadlineMs ?? GENERATE_DEADLINE_MS, (s) =>
      runStructured(transport, task, {
        output: capabilities.output,
        signal: s,
        onDowngrade: (output: OutputMode) => {
          capabilities = { ...capabilities, output };
          options.onCapabilities?.(capabilities);
        },
      }),
    );

  return {
    providerId: config.id,
    local: isLocalProvider(config),

    generateFilter(prompt, ctx, signal) {
      return run(
        {
          system: systemPrompt(ctx),
          prompt,
          schema: { name: "filter", zod: wireFilterSchema },
          example: EXAMPLE_WIRE_FILTER,
          maxTokens: FILTER_MAX_TOKENS,
          validate: (wire) => {
            const r = convertWireFilter(wire, ctx);
            return r.ok ? { ok: true, value: { name: r.name, rule: r.rule, explanation: r.explanation } } : r;
          },
        },
        signal,
      );
    },

    classify<L extends string>(input: ClassifyInput<L>, signal?: AbortSignal) {
      if (input.labels.length === 0) throw new AiError("classify needs at least one label", "invalid_output");
      const ids = input.items.map((i) => i.id);
      const zod = z.object({
        results: z.array(z.object({ id: z.string(), label: z.enum(input.labels as [L, ...L[]]).nullable(), confidence: z.number() })),
      });
      return run(
        {
          system: `You assign each item exactly one of the given labels, or null when none fits. ${input.instructions}`,
          prompt: `Labels: ${JSON.stringify(input.labels)}\nItems: ${JSON.stringify(input.items)}`,
          schema: { name: "classification", zod },
          example: { results: [{ id: ids[0] ?? "1", label: input.labels[0]!, confidence: 0.8 }] },
          maxTokens: Math.min(8000, 200 + 60 * input.items.length),
          validate: ({ results }) => {
            const byId = new Map(results.map((r) => [r.id, r]));
            const missing = ids.filter((id) => !byId.has(id));
            const unknown = results.filter((r) => !ids.includes(r.id)).map((r) => r.id);
            if (missing.length || unknown.length) {
              return { ok: false, error: [missing.length && `missing ids ${missing.join(", ")}`, unknown.length && `unknown ids ${unknown.join(", ")}`].filter(Boolean).join("; ") };
            }
            return { ok: true, value: ids.map((id) => ({ id, label: byId.get(id)!.label, confidence: Math.max(0, Math.min(1, byId.get(id)!.confidence)) })) };
          },
        },
        signal,
      );
    },
  };
}

export function discoverModels(config: ProviderConfig, signal: AbortSignal, transport: ModelTransport = transportFor(config)): Promise<ModelInfo[]> {
  return withDeadline(signal, config.timeoutMs, async (s) => (transport.listModels ? transport.listModels(s) : []));
}

export interface ProbeResult {
  latencyMs: number;
  capabilities: Capabilities;
  /** e.g. the model's context window is smaller than the filter prompt needs */
  warning?: string;
}

/**
 * Test connection: a tiny structured request that walks the ladder from the
 * top, so the saved capability is what this server and model actually do.
 */
export async function probe(config: ProviderConfig, signal: AbortSignal, transport: ModelTransport = transportFor(config)): Promise<ProbeResult> {
  const descriptor = describeProvider(config.id);
  let output: OutputMode = "json_schema";
  const started = performance.now();
  await withDeadline(signal, config.timeoutMs * 3, (s) =>
    runStructured(
      transport,
      {
        system: 'This is a connectivity test. Reply with the JSON object {"ok": true}.',
        prompt: "ping",
        schema: { name: "probe", zod: z.object({ ok: z.boolean() }) },
        example: { ok: true },
        maxTokens: 512,
        validate: (v) => ({ ok: true, value: v }),
      },
      { output, signal: s, onDowngrade: (m) => (output = m) },
    ),
  );
  const latencyMs = Math.round(performance.now() - started);
  const models = transport.listModels ? await transport.listModels(signal).catch(() => []) : [];
  const contextTokens = models.find((m) => m.id === config.model)?.contextTokens ?? null;
  const capabilities: Capabilities = { output, contextTokens, embeddings: descriptor.declared.embeddings, probedAt: Date.now() };
  const needed = FILTER_PROMPT_TOKENS + FILTER_MAX_TOKENS;
  const warning = contextTokens !== null && contextTokens < needed ? `El modelo admite ${contextTokens.toLocaleString("es")} tokens de contexto; los filtros necesitan unos ${needed.toLocaleString("es")}.` : undefined;
  return { latencyMs, capabilities, warning };
}

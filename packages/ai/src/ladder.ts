import { z } from "zod";
import { parseModelJson } from "./json";
import { L } from "@terno/i18n";
import { AiError, type ChatMsg, type Effort, type ModelTransport, type OutputMode, type PromptBlock, type PromptText } from "./types";

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StructuredTask<W, T> {
  system: string;
  /**
   * Plan 291: `system` is byte-identical across calls and recurs within minutes (a worker's drain, an Ask sitting), so
   * a cacheable prefix ends after it. Only where it pays: long enough to be cached and read before it expires.
   */
  cache?: boolean;
  /** Plan 291: what closes the system prompt but differs per call (a mail's arrival), read after `system` and a blank line, after any cached prefix. */
  systemTail?: string;
  prompt: string;
  /** Plan 291: the user turn's head, the same across calls (categorizing's labels and what they hold): it ends a cached prefix, and `prompt` follows it. */
  promptHead?: string;
  schema: { name: string; zod: z.ZodType<W> };
  /** domain checks after the shape parses; the error text is fed back in the repair turn */
  validate: (wire: W, attempt?: { last: boolean }) => Validation<T>;
  /** one valid instance, shown to models without native structured output */
  example: W;
  maxTokens: number;
  effort?: Effort;
  reasoningEffort?: Effort;
  verbosity?: "low" | "medium" | "high";
}

export interface LadderOptions {
  output: OutputMode;
  signal: AbortSignal;
  /** the server rejected a mode: remember the weaker one for this session (and persist it) */
  onDowngrade?: (output: OutputMode) => void;
}

const REPAIR_ERROR_CHARS = 400;
const WEAKER: Record<OutputMode, OutputMode | null> = { json_schema: "json_object", json_object: "text", text: null };
/** json_schema output is grammar-constrained, so one repair suffices; free-form modes get two */
const REPAIRS: Record<OutputMode, number> = { json_schema: 1, json_object: 2, text: 2 };

/** The system prompt: plain text, or (plan 291) blocks with the cached prefix first and what differs per call after it. */
function systemFor<W>(task: StructuredTask<W, unknown>, output: OutputMode): PromptText {
  const schema =
    output === "json_schema"
      ? null
      : [
          "Respond with a single JSON object and nothing else (no prose, no code fences).",
          `It must match this JSON Schema:\n${JSON.stringify(z.toJSONSchema(task.schema.zod))}`,
          `Example:\n${JSON.stringify(task.example)}`,
        ].join("\n");
  if (!task.cache && task.systemTail === undefined) return schema ? `${task.system}\n\n${schema}` : task.system;
  // one text cut in parts: each part but the last carries the blank line before the next, so every server reads that text
  const parts: PromptBlock[] = [{ text: task.system, ...(task.cache ? { cache: true } : {}) }, ...(task.systemTail !== undefined ? [{ text: task.systemTail }] : []), ...(schema ? [{ text: schema }] : [])];
  return parts.map((p, i) => (i < parts.length - 1 ? { ...p, text: `${p.text}\n\n` } : p));
}

function check<W, T>(task: StructuredTask<W, T>, text: string, last: boolean): Validation<T> {
  const json = parseModelJson(text);
  if (!json.ok) return json;
  const shape = task.schema.zod.safeParse(json.value);
  if (!shape.success) return { ok: false, error: shape.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  return task.validate(shape.data, { last });
}

/**
 * The shared fallback ladder every task runs through:
 *   json_schema → (server rejects it) json_object → text with JSON extraction.
 * A downgrade is not a repair. Malformed JSON, wrong shapes and domain errors
 * all go to the repair loop, with the error fed back to the model.
 */
export async function runStructured<W, T>(transport: ModelTransport, task: StructuredTask<W, T>, options: LadderOptions): Promise<T> {
  let output = options.output;
  let repairsLeft = REPAIRS[output];
  const messages: ChatMsg[] = [{ role: "user", content: task.promptHead === undefined ? task.prompt : [{ text: task.promptHead, cache: true }, { text: task.prompt }] }];
  for (;;) {
    options.signal.throwIfAborted();
    let completion;
    try {
      completion = await transport.complete({
        system: systemFor(task, output),
        messages,
        output,
        schema: { name: task.schema.name, zod: task.schema.zod },
        maxTokens: task.maxTokens,
        signal: options.signal,
        ...(task.effort ? { effort: task.effort } : {}),
        ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}),
        ...(task.verbosity ? { verbosity: task.verbosity } : {}),
      });
    } catch (error) {
      const weaker = WEAKER[output];
      if (error instanceof AiError && error.kind === "unsupported" && weaker) {
        output = weaker;
        repairsLeft = REPAIRS[output];
        options.onDowngrade?.(output);
        continue;
      }
      throw error;
    }
    if (completion.stop === "refusal") throw new AiError(L("errors.ai.refused"), "refused");
    if (completion.stop === "length") throw new AiError(L("errors.ai.truncated"), "invalid_output");
    const result = check(task, completion.text, repairsLeft <= 0);
    if (result.ok) return result.value;
    if (repairsLeft-- <= 0) throw new AiError(L("errors.ai.invalidOutput", { detail: result.error }), "invalid_output");
    messages.push(
      { role: "assistant", content: completion.text },
      // bounded: a validation's own words can't fill a small window
      { role: "user", content: `That output is invalid: ${result.error.slice(0, REPAIR_ERROR_CHARS)}. Return only the corrected JSON object.` },
    );
  }
}

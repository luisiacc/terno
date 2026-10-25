import { z } from "zod";
import { parseModelJson } from "./json";
import { L } from "@terno/i18n";
import { AiError, type ChatMsg, type ModelTransport, type OutputMode } from "./types";

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StructuredTask<W, T> {
  system: string;
  prompt: string;
  schema: { name: string; zod: z.ZodType<W> };
  /** domain checks after the shape parses; the error text is fed back in the repair turn */
  validate: (wire: W) => Validation<T>;
  /** one valid instance, shown to models without native structured output */
  example: W;
  maxTokens: number;
}

export interface LadderOptions {
  output: OutputMode;
  signal: AbortSignal;
  /** the server rejected a mode: remember the weaker one for this session (and persist it) */
  onDowngrade?: (output: OutputMode) => void;
}

const WEAKER: Record<OutputMode, OutputMode | null> = { json_schema: "json_object", json_object: "text", text: null };
/** json_schema output is grammar-constrained, so one repair suffices; free-form modes get two */
const REPAIRS: Record<OutputMode, number> = { json_schema: 1, json_object: 2, text: 2 };

function systemFor<W>(task: StructuredTask<W, unknown>, output: OutputMode): string {
  if (output === "json_schema") return task.system;
  return [
    task.system,
    "",
    "Respond with a single JSON object and nothing else (no prose, no code fences).",
    `It must match this JSON Schema:\n${JSON.stringify(z.toJSONSchema(task.schema.zod))}`,
    `Example:\n${JSON.stringify(task.example)}`,
  ].join("\n");
}

function check<W, T>(task: StructuredTask<W, T>, text: string): Validation<T> {
  const json = parseModelJson(text);
  if (!json.ok) return json;
  const shape = task.schema.zod.safeParse(json.value);
  if (!shape.success) return { ok: false, error: shape.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  return task.validate(shape.data);
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
  const messages: ChatMsg[] = [{ role: "user", content: task.prompt }];
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
    const result = check(task, completion.text);
    if (result.ok) return result.value;
    if (repairsLeft-- <= 0) throw new AiError(L("errors.ai.invalidOutput", { detail: result.error }), "invalid_output");
    messages.push(
      { role: "assistant", content: completion.text },
      { role: "user", content: `That output is invalid: ${result.error}. Return only the corrected JSON object.` },
    );
  }
}

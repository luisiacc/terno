import { textRef, type AiErrorKind, type AiProviderId, type Capabilities, type CompatiblePreset, type FilterRule, type ModelInfo, type OutputMode, type TextRef } from "@terno/core";
import type { Localized } from "@terno/i18n";
import type { z } from "zod";
import type { SummarizeInput, ThreadSummaryResult } from "./summarize";
import type { ComposeInput, ComposeOptions, ComposeResult, JudgeVoiceInput, JudgeVoiceResult, ParseIntentInput, ParseIntentResult } from "./writing";

export type { AiErrorKind, AiProviderId, Capabilities, CompatiblePreset, ModelInfo, OutputMode, PresetDescriptor, ProviderDescriptor } from "@terno/core";

export interface ProviderConfig {
  id: AiProviderId;
  model: string;
  baseURL?: string;
  preset?: CompatiblePreset;
  apiKey: string | null;
  capabilities?: Capabilities;
  /** ALWAYS the backend's network-policy fetch: SDKs never get to open sockets on their own */
  fetch: typeof fetch;
  /**
   * The page's origin when the backend runs in a browser (the web build's
   * worker). The SDKs then opt in to running there (they refuse by default to
   * keep a site's own key out of its pages; this key is the user's, kept on
   * this device), and a failed connection may be a server that doesn't allow
   * this origin (CORS): local servers say how to allow it.
   */
  browserOrigin?: string;
  timeoutMs: number;
  maxRetries: number;
}

/** A stretch of a prompt. `cache`: end a cacheable prefix here (Anthropic's breakpoints; other servers just concatenate). */
export interface PromptBlock {
  text: string;
  cache?: boolean;
}

export type PromptText = string | readonly PromptBlock[];

/** A prompt's text in order, for servers with no notion of blocks. */
export function promptText(content: PromptText): string {
  return typeof content === "string" ? content : content.map((b) => b.text).join("\n\n");
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: PromptText;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** tokens served from the provider's prompt cache (cheaper), and written to it */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type Effort = "low" | "medium" | "high";

export interface CompletionRequest {
  system: PromptText;
  messages: ChatMsg[];
  output: OutputMode;
  schema?: { name: string; zod: z.ZodType };
  maxTokens: number;
  signal: AbortSignal;
  /** how hard to think, where the model takes it; default low */
  effort?: Effort;
}

export interface Completion {
  text: string;
  stop: "end" | "length" | "refusal";
  usage?: Usage;
}

/**
 * What a stream yields: text deltas, then exactly one `done`. Failures throw an
 * AiError. Text already yielded before a throw is the caller's to keep or drop.
 */
export type StreamEvent = { type: "delta"; text: string } | { type: "done"; stop: Completion["stop"]; usage?: Usage };

/** One wire protocol. Transports know nothing about tasks (filters, classification). */
export interface ModelTransport {
  complete(req: CompletionRequest): Promise<Completion>;
  /** optional: streamCompletion falls back to one chunk from complete() */
  stream?(req: CompletionRequest): AsyncIterable<StreamEvent>;
  listModels?(signal: AbortSignal): Promise<ModelInfo[]>;
}

export interface FilterGenerationContext {
  now: number;
  categories: { id: number; name: string }[];
  accounts: { id: number; email: string; displayName: string }[];
}

export interface GeneratedFilter {
  name: string;
  rule: FilterRule;
  explanation: string;
}

/** What a choice means, shown beside its label as data (never as instructions): plan 134. */
export interface LabelEvidence {
  name: string;
  samples: { fromName: string; fromDomain: string; subject: string }[];
}

export interface ClassifyInput<L extends string> {
  /** Opaque IDs must be unique within this batch. */
  items: { id: string; text: string }[];
  labels: readonly L[];
  instructions: string;
  /** by label */
  evidence?: Partial<Record<L, LabelEvidence>>;
}

/** What backend handlers use. Tasks are a prompt + schema run through the shared ladder. */
export interface AiTasks {
  readonly providerId: AiProviderId;
  readonly local: boolean;
  /** the model these tasks run on, for provenance and budgets */
  readonly model: string;
  /** its reported confidence can decide on its own (hosted or keyed JEV); others only suggest (plan 134) */
  readonly calibrated: boolean;
  /** the model's context window, when known */
  readonly contextTokens: number | null;
  /** the endpoint they talk to: one model id can sit behind several (plan 132 revision 5) */
  readonly endpoint: string | null;
  generateFilter(prompt: string, ctx: FilterGenerationContext, signal?: AbortSignal): Promise<GeneratedFilter>;
  /** plan 132: a conversation's summary; items citing a message that isn't in it are dropped */
  summarize(input: SummarizeInput, signal?: AbortSignal): Promise<ThreadSummaryResult>;
  /** plan 133: a draft in the user's voice, streamed; a refusal throws, and text past a failure is the caller's to keep */
  compose(input: ComposeInput, options: ComposeOptions): Promise<ComposeResult>;
  /** plan 133: what counting can't say about how someone writes; the notes come back through the local screen */
  judgeVoice(input: JudgeVoiceInput, signal?: AbortSignal): Promise<JudgeVoiceResult>;
  /** plan 133: who an instruction is for, from the names it matched. Carries no mail. */
  parseIntent(input: ParseIntentInput, signal?: AbortSignal): Promise<ParseIntentResult>;
  /** One result per input, in input order; malformed responses are repaired or rejected as a whole. */
  classify<L extends string>(input: ClassifyInput<L>, signal?: AbortSignal): Promise<{ id: string; label: L | null; confidence: number }[]>;
  /** declared only; built with the categorization agent */
  embed?: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;
}

export class AiError extends Error {
  /** the provider (or the configuration) said no: shown to the user, never reported */
  readonly expected = true;
  /** set when the message is a catalog message (L()): the renderer translates it */
  readonly i18n?: TextRef;
  constructor(
    message: string | Localized,
    readonly kind: AiErrorKind,
  ) {
    super(typeof message === "string" ? message : message.message);
    this.name = "AiError";
    const i18n = textRef(message);
    if (i18n) this.i18n = i18n;
  }
}

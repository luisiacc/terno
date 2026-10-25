import type { AiErrorKind, AiProviderId, Capabilities, CompatiblePreset, FilterRule, ModelInfo, OutputMode } from "@terno/core";
import type { z } from "zod";

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

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMsg[];
  output: OutputMode;
  schema?: { name: string; zod: z.ZodType };
  maxTokens: number;
  signal: AbortSignal;
}

export interface Completion {
  text: string;
  stop: "end" | "length" | "refusal";
}

/** One wire protocol. Transports know nothing about tasks (filters, classification). */
export interface ModelTransport {
  complete(req: CompletionRequest): Promise<Completion>;
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

export interface ClassifyInput<L extends string> {
  items: { id: string; text: string }[];
  labels: readonly L[];
  instructions: string;
}

/** What backend handlers use. Tasks are a prompt + schema run through the shared ladder. */
export interface AiTasks {
  readonly providerId: AiProviderId;
  readonly local: boolean;
  generateFilter(prompt: string, ctx: FilterGenerationContext, signal?: AbortSignal): Promise<GeneratedFilter>;
  classify<L extends string>(input: ClassifyInput<L>, signal?: AbortSignal): Promise<{ id: string; label: L | null; confidence: number }[]>;
  /** declared only; built with the categorization agent */
  embed?: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;
}

export class AiError extends Error {
  /** the provider (or the configuration) said no: shown to the user, never reported */
  readonly expected = true;
  constructor(
    message: string,
    readonly kind: AiErrorKind,
  ) {
    super(message);
    this.name = "AiError";
  }
}

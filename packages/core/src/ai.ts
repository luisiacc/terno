/** AI provider vocabulary shared by the backend, the RPC contract and the renderer. */
export const AI_PROVIDER_IDS = ["anthropic", "openai", "compatible", "ollama", "lmstudio", "fake", "none"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const COMPATIBLE_PRESETS = ["openrouter", "groq", "together", "azure", "custom"] as const;
export type CompatiblePreset = (typeof COMPATIBLE_PRESETS)[number];

/** How the model is asked for JSON, strongest first (see the fallback ladder). */
export type OutputMode = "json_schema" | "json_object" | "text";

/** Static registry entry; also sent to the UI. */
export interface ProviderDescriptor {
  id: AiProviderId;
  label: string;
  /** compatible is "by-url": a loopback endpoint makes it local */
  locality: "local" | "cloud" | "by-url";
  needsKey: boolean;
  defaultBaseURL?: string;
  presets?: CompatiblePreset[];
  declared: { output: OutputMode; embeddings: boolean };
  discovery: "openai" | "ollama" | "lmstudio" | "anthropic" | "none";
}

export interface PresetDescriptor {
  id: CompatiblePreset;
  label: string;
  baseURL?: string;
  needsKey: boolean;
}

export interface Capabilities {
  output: OutputMode;
  contextTokens: number | null;
  embeddings: boolean;
  /** null: declared by the provider, never observed by Test connection */
  probedAt: number | null;
}

export interface ModelInfo {
  id: string;
  label?: string;
  contextTokens?: number;
  sizeBytes?: number;
  loaded?: boolean;
}

export type AiErrorKind =
  | "invalid_output"
  | "refused"
  | "auth"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "blocked"
  | "not_configured"
  | "unsupported"
  | "cancelled";

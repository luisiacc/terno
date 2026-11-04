/** AI provider vocabulary shared by the backend, the RPC contract and the renderer. */
export const AI_PROVIDER_IDS = ["anthropic", "openai", "compatible", "ollama", "lmstudio", "jev", "fake", "none"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** What a provider and model can be chosen for (plan 131). */
export const AI_TASK_NAMES = ["summary", "writing", "categorize"] as const;
export type AiTaskName = (typeof AI_TASK_NAMES)[number];

/** Which provider and model runs a task, when the user chose. */
export interface AiTaskTarget {
  provider: AiProviderId;
  model: string;
}

/** The defaults the user decided (plan 131 §2); a choice in Settings wins. */
export const WRITING_CLAUDE_MODEL = "claude-sonnet-5-5";
export const SUMMARY_DEFAULT_MODEL = "gpt-6-luna";
/** "Use Claude" for summaries: they run on every new mail, so never the install's default Opus. */
export const SUMMARY_CLAUDE_MODEL = "claude-haiku-5-5";
export const INTENT_CLAUDE_MODEL = "claude-haiku-5-5";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** Plan 132: what a summary can point out. */
export const SUMMARY_ITEM_KINDS = ["decision", "date", "action", "question"] as const;
export type SummaryItemKind = (typeof SUMMARY_ITEM_KINDS)[number];

export interface AiSummaryItem {
  kind: SummaryItemKind;
  text: string;
  /** the message it's in: never one the thread doesn't hold */
  messageId: number;
}

/** A conversation's summary, as the reader shows it. Plain text, never HTML. */
export interface AiSummary {
  threadId: number;
  summary: string;
  items: AiSummaryItem[];
  /** who wrote it, for its tooltip */
  provider: AiProviderId;
  model: string;
  generatedAt: number;
}

/** `stale`: there was one, but the conversation has changed since. */
export type AiSummaryRead = { state: "none" } | { state: "stale" } | { state: "ready"; summary: AiSummary };

/** `consent`: this would be the first text sent to this cloud provider by hand; `waitingBody`: the newest message's text isn't here yet. */
export type AiSummarizeResult = { status: "ready"; summary: AiSummary } | { status: "consent"; provider: AiProviderId } | { status: "waitingBody" };

/** What Settings says about the automatic summaries: `blockedBy` while they've stopped, `lastError` after one failed. */
export interface AiSummariesStatus {
  pending: number;
  blockedBy: { kind: AiErrorKind; message: string; i18n?: import("./rpc/envelope").I18nRef; limit?: "daily" | "monthly" } | null;
  lastError: AiErrorKind | null;
}

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
  discovery: "openai" | "ollama" | "lmstudio" | "anthropic" | "jev" | "none";
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

import { aiFeaturesAvailable, aiReady, ASK_CLAUDE_MODEL, chosenTargetReady, DIGEST_CLAUDE_MODEL, DIGEST_OPENAI_MODEL, FOLLOWUP_CLAUDE_MODEL, FOLLOWUP_OPENAI_MODEL, SUMMARY_DEFAULT_MODEL, WRITING_CLAUDE_MODEL, type AiErrorKind, type AiProviderId, type CompatiblePreset, type OutputMode } from "@terno/core";
import type { AiSettings, AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";

/** What the AI tab's selector shows: compatible appears twice (a server on this Mac, or a cloud API). */
export type ProviderChoice = Exclude<AiProviderId, "compatible" | "jev"> | "local-server" | "compatible";

export const LOCAL_CHOICES: ProviderChoice[] = ["ollama", "lmstudio", "local-server"];
export const CLOUD_CHOICES: ProviderChoice[] = ["anthropic", "openai", "compatible"];

// brand names stay as they are; the rest is read in the current language
const CHOICE_LABEL = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "local-server": "ai.choice.localServer",
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  compatible: "ai.choice.compatible",
  fake: "ai.choice.fake",
  none: "ai.choice.none",
} as const satisfies Record<ProviderChoice, string>;

export function choiceLabel(choice: ProviderChoice): string {
  const label = CHOICE_LABEL[choice];
  return label.startsWith("ai.") ? t(label as Extract<typeof label, `ai.${string}`>) : label;
}

export const PRESETS: readonly CompatiblePreset[] = ["openrouter", "groq", "together", "azure", "custom"];

export function presetLabel(preset: CompatiblePreset): string {
  return preset === "custom" ? t("ai.preset.custom") : { openrouter: "OpenRouter", groq: "Groq", together: "Together", azure: "Azure OpenAI" }[preset];
}

export const DEFAULT_ENDPOINT: Partial<Record<ProviderChoice, string>> = {
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  "local-server": "http://127.0.0.1:8080/v1",
};

export const PRESET_ENDPOINT: Partial<Record<CompatiblePreset, string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
};

const CLOUD_HOST: Partial<Record<AiProviderId, string>> = { anthropic: "api.anthropic.com", openai: "api.openai.com" };

export function choiceOf(ai: Pick<AiSettings, "provider" | "preset" | "local">): ProviderChoice {
  if (ai.provider === "compatible") return ai.preset === "custom" && ai.local ? "local-server" : "compatible";
  // JEV is never the main provider (the contract refuses it): it only categorizes
  return ai.provider === "jev" ? "none" : ai.provider;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

/** The endpoint requests actually go to (saved, or the provider's default). */
export function endpointOf(ai: Pick<AiSettings, "provider" | "preset" | "baseURL" | "local">): string | null {
  if (ai.baseURL) return ai.baseURL;
  const choice = choiceOf(ai);
  if (ai.provider === "compatible") return ai.preset ? (PRESET_ENDPOINT[ai.preset] ?? null) : null;
  return DEFAULT_ENDPOINT[choice] ?? null;
}

export function hostOf(ai: Pick<AiSettings, "provider" | "preset" | "baseURL" | "local">): string | null {
  const url = endpointOf(ai);
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }
  return CLOUD_HOST[ai.provider] ?? null;
}

export function providerName(ai: Pick<AiSettings, "provider" | "preset" | "local">): string {
  if (ai.provider === "compatible" && ai.preset && ai.preset !== "custom") return presetLabel(ai.preset);
  return choiceLabel(choiceOf(ai));
}

export { aiReady };

/**
 * Plan 131 §2 and plan 132 §2: what summaries run on, by the same rule as the backend's `AiService.targetFor`. A
 * default never moves mail to a paid provider the user didn't pick: with only another cloud provider set up, it asks.
 */
export type SummaryTarget = { state: "ready"; provider: AiProviderId; model: string } | { state: "ask"; provider: AiProviderId } | { state: "none" };

export function summaryTarget(ai: AiSettings): SummaryTarget {
  const chosen = ai.tasks.summary;
  if (chosen) return { state: "ready", provider: chosen.provider, model: chosen.model };
  if (ai.keys.openai?.hasKey) return { state: "ready", provider: "openai", model: SUMMARY_DEFAULT_MODEL };
  if (ai.provider === "none") return { state: "none" };
  return ai.local ? { state: "ready", provider: ai.provider, model: ai.model } : { state: "ask", provider: ai.provider };
}

/** Plan 141 §6: where a question goes, by the backend's rule: the task's own choice, else the configured provider (Sonnet on Claude). */
export function askTarget(ai: AiSettings): { provider: AiProviderId; model: string } {
  const chosen = ai.tasks.ask;
  if (chosen) return chosen;
  return { provider: ai.provider, model: ai.provider === "anthropic" ? ASK_CLAUDE_MODEL : ai.model };
}

/** Plan 142: by the backend's rule: its own choice, the summaries' row, else a small model on the configured provider. */
export function followupTarget(ai: AiSettings): { provider: AiProviderId; model: string } {
  const chosen = ai.tasks.followup ?? ai.tasks.summary;
  if (chosen) return chosen;
  return { provider: ai.provider, model: ai.provider === "anthropic" ? FOLLOWUP_CLAUDE_MODEL : ai.provider === "openai" ? FOLLOWUP_OPENAI_MODEL : ai.model };
}

/** Plan 145: the digest's own row, else the summaries', else the small model on what's set up. */
export function digestTarget(ai: AiSettings): { provider: AiProviderId; model: string } {
  const chosen = ai.tasks.digest ?? ai.tasks.summary;
  if (chosen) return chosen;
  return { provider: ai.provider, model: ai.provider === "anthropic" ? DIGEST_CLAUDE_MODEL : ai.provider === "openai" ? DIGEST_OPENAI_MODEL : ai.model };
}

/** Whether a question can go: Ask's own target if it has one, whatever the main provider is. */
export function askReady(ai: AiSettings | null | undefined): boolean {
  if (!ai) return false;
  const chosen = ai.tasks.ask;
  return chosen ? chosenTargetReady(ai, chosen) : aiReady(ai);
}

/** Whether a summary has somewhere to go, or a provider to ask about (`summaryTarget`'s "ask": the block then says where). */
export function summaryReady(ai: AiSettings | null | undefined): boolean {
  if (!ai) return false;
  const chosen = ai.tasks.summary;
  return chosen ? chosenTargetReady(ai, chosen) : ai.keys.openai?.hasKey === true || aiReady(ai);
}

const LOCAL_PROVIDERS: readonly AiProviderId[] = ["ollama", "lmstudio", "fake"];
/** A provider that runs on this Mac (plan 161, pass 2: what an error tells the user to do differs). */
export const localProvider = (provider: AiProviderId): boolean => LOCAL_PROVIDERS.includes(provider);

/**
 * Plan 133: what drafts run on, by the backend's rule (`AiService.targetFor`): the task's own choice, else the
 * configured provider. Whether asking can work, and whether mail would leave this Mac; the backend has the last word.
 */
export function writingTarget(ai: AiSettings | null | undefined): { ready: boolean; provider: AiProviderId; local: boolean } {
  if (!ai) return { ready: false, provider: "none", local: true };
  const chosen = ai.tasks.writing;
  if (!chosen) return { ready: aiReady(ai), provider: ai.provider, local: ai.local };
  const local = LOCAL_PROVIDERS.includes(chosen.provider) || (chosen.provider === ai.provider && ai.local);
  return { ready: local || chosen.provider === "compatible" || ai.keys[chosen.provider]?.hasKey === true, provider: chosen.provider, local };
}

/** What the AI features' gates read of the app: its state, as `useApp` and `getApp` both give it. */
interface AiOffer {
  devAi: unknown;
  settings: AppSettings | null;
}

/** Plan 147: on a local build Dev mode's switch decides, whatever the profile has saved. Elsewhere there's nothing to ask yet (plan 85: no entitlement). */
export const aiAllowed = (s: AiOffer): boolean => s.devAi === null || s.settings?.devAi === true;

/** Plan 147: an AI feature shows only where it can run: a free install with nothing set up sees none, and Settings → AI is the way in. */
export const summariesOffered = (s: AiOffer): boolean => aiAllowed(s) && summaryReady(s.settings?.ai);
export const draftingOffered = (s: AiOffer): boolean => aiAllowed(s) && writingTarget(s.settings?.ai).ready;
export const askOffered = (s: AiOffer): boolean => aiAllowed(s) && s.settings?.ask?.enabled === true && askReady(s.settings?.ai);
/** Today's own rule (plan 145), with the switch. `todayOffered` adds its row's setting. */
export const todayAvailable = (s: AiOffer): boolean => aiAllowed(s) && aiFeaturesAvailable(s.settings);
export const todayOffered = (s: AiOffer): boolean => todayAvailable(s) && s.settings?.today?.show !== false;
/** These two need a provider to turn on, and what they found stays readable when a key goes. */
export const followupsOffered = (s: AiOffer): boolean => aiAllowed(s) && s.settings?.followups?.enabled === true;
export const repliesOffered = (s: AiOffer): boolean => aiAllowed(s) && s.settings?.replies?.enabled === true;

/** A provider by name, wherever it's named outside its own settings. */
export function providerLabel(provider: AiProviderId, ai?: Pick<AiSettings, "provider" | "preset" | "local">): string {
  if (provider === "compatible") return ai?.provider === "compatible" ? providerName(ai) : choiceLabel("compatible");
  return provider === "jev" ? "JEV" : choiceLabel(provider);
}

const MODEL_NAME: Record<string, string> = { [SUMMARY_DEFAULT_MODEL]: "GPT Luna", [WRITING_CLAUDE_MODEL]: "Claude Sonnet 5.5" };

/** A model as people say it; an id nobody named as itself. */
export const modelName = (id: string): string => MODEL_NAME[id] ?? id;

/** One line on what leaves the Mac when generating a filter. Never message content. */
export function privacyLine(ai: AiSettings): string {
  if (ai.provider === "none") return t("ai.privacy.off");
  if (ai.local) return t("ai.privacy.local");
  return t("ai.privacy.cloud", { host: hostOf(ai) ?? providerName(ai) });
}

/** How a model answers (keys: read with t()). */
export const OUTPUT_LABEL = {
  json_schema: "ai.output.jsonSchema",
  json_object: "ai.output.jsonObject",
  text: "ai.output.text",
} as const satisfies Record<OutputMode, string>;

/** Help that depends on why the AI failed. */
export function errorHelp(kind: AiErrorKind | undefined, ai: Pick<AiSettings, "provider" | "preset" | "local">): string | null {
  switch (kind) {
    case "auth":
      return t("ai.help.auth");
    case "rate_limited":
      return t("ai.help.rateLimited");
    case "unavailable":
      return ai.local ? t("ai.help.unavailableLocal", { provider: providerName(ai) }) : t("ai.help.unavailable");
    case "timeout":
      return ai.local ? t("ai.help.timeoutLocal") : t("ai.help.timeout");
    case "blocked":
      return t("ai.help.blocked");
    case "invalid_output":
      return t("ai.help.invalidOutput");
    case "refused":
      return t("ai.help.refused");
    default:
      return null;
  }
}

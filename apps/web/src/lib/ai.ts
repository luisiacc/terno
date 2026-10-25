import type { AiErrorKind, AiProviderId, CompatiblePreset, OutputMode } from "@terno/core";
import type { AiSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";

/** What the AI tab's selector shows: compatible appears twice (a server on this Mac, or a cloud API). */
export type ProviderChoice = Exclude<AiProviderId, "compatible"> | "local-server" | "compatible";

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
  return ai.provider;
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

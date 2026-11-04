import { keyRef } from "@terno/i18n";
import type { AiProviderId, CompatiblePreset, PresetDescriptor, ProviderConfig, ProviderDescriptor } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    locality: "cloud",
    needsKey: true,
    defaultBaseURL: "https://api.anthropic.com",
    declared: { output: "json_schema", embeddings: false },
    discovery: "anthropic",
  },
  {
    id: "openai",
    label: "OpenAI",
    locality: "cloud",
    needsKey: true,
    defaultBaseURL: "https://api.openai.com/v1",
    declared: { output: "json_schema", embeddings: true },
    discovery: "openai",
  },
  {
    id: "compatible",
    label: keyRef("ai.choice.compatible"),
    locality: "by-url",
    needsKey: true,
    presets: ["openrouter", "groq", "together", "azure", "custom"],
    // never assume an arbitrary server honours json_schema: Test connection upgrades it when it does
    declared: { output: "json_object", embeddings: false },
    discovery: "openai",
  },
  {
    id: "ollama",
    label: "Ollama",
    locality: "local",
    needsKey: false,
    defaultBaseURL: "http://127.0.0.1:11434/v1",
    declared: { output: "json_schema", embeddings: true },
    discovery: "ollama",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    locality: "local",
    needsKey: false,
    defaultBaseURL: "http://127.0.0.1:1234/v1",
    declared: { output: "json_schema", embeddings: true },
    discovery: "lmstudio",
  },
  // JEV only picks among choices: never in the main provider list, only for categorization (plan 134)
  {
    id: "jev",
    label: "JEV",
    locality: "cloud",
    needsKey: true,
    defaultBaseURL: "https://api.typesafe.ai",
    declared: { output: "json_schema", embeddings: false },
    discovery: "jev",
  },
  { id: "fake", label: keyRef("ai.choice.fake"), locality: "local", needsKey: false, declared: { output: "json_schema", embeddings: false }, discovery: "none" },
  { id: "none", label: keyRef("ai.choice.none"), locality: "local", needsKey: false, declared: { output: "text", embeddings: false }, discovery: "none" },
];

export const PRESETS: Record<CompatiblePreset, PresetDescriptor> = {
  openrouter: { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", needsKey: true },
  groq: { id: "groq", label: "Groq", baseURL: "https://api.groq.com/openai/v1", needsKey: true },
  together: { id: "together", label: "Together", baseURL: "https://api.together.xyz/v1", needsKey: true },
  azure: { id: "azure", label: "Azure OpenAI", needsKey: true },
  custom: { id: "custom", label: keyRef("ai.preset.custom"), needsKey: false },
};

export function describeProvider(id: AiProviderId): ProviderDescriptor {
  return PROVIDERS.find((p) => p.id === id)!;
}

/** Literal loopback hosts only; the network policy additionally resolves names before connecting. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function resolveBaseURL(config: Pick<ProviderConfig, "id" | "baseURL" | "preset">): string | undefined {
  if (config.baseURL) return config.baseURL;
  if (config.id === "compatible") return config.preset ? PRESETS[config.preset].baseURL : undefined;
  return describeProvider(config.id).defaultBaseURL;
}

/** Local means the model runs on this Mac: by declaration, or a custom endpoint on loopback. */
/**
 * Whether the provider runs on this machine: its endpoint is loopback. A
 * local kind (Ollama, LM Studio) pointed at another machine isn't (plan 97:
 * nothing stops that now, so what's disclosed follows where it goes).
 */
export function isLocalProvider(config: Pick<ProviderConfig, "id" | "baseURL" | "preset">): boolean {
  const d = describeProvider(config.id);
  if (d.locality === "cloud") return false;
  if (config.preset && config.preset !== "custom") return false;
  const url = resolveBaseURL(config);
  // no endpoint at all (the fake model, "none"): nothing to reach
  if (!url) return d.locality === "local";
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function needsKey(config: Pick<ProviderConfig, "id" | "preset">): boolean {
  if (config.id === "compatible") return PRESETS[config.preset ?? "custom"].needsKey;
  return describeProvider(config.id).needsKey;
}

/** Secret name for a provider's API key (one per compatible preset, so switching keeps each). */
export function keySecretName(id: AiProviderId, preset?: CompatiblePreset | null): string {
  return id === "compatible" ? `ai:compatible:${preset ?? "custom"}:apiKey` : `ai:${id}:apiKey`;
}

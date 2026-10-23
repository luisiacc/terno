import type { AiErrorKind, AiProviderId, CompatiblePreset, OutputMode } from "@unica/core";
import type { AiSettings } from "@unica/core/rpc";

/** What the AI tab's selector shows: compatible appears twice (a server on this Mac, or a cloud API). */
export type ProviderChoice = Exclude<AiProviderId, "compatible"> | "local-server" | "compatible";

export const LOCAL_CHOICES: ProviderChoice[] = ["ollama", "lmstudio", "local-server"];
export const CLOUD_CHOICES: ProviderChoice[] = ["anthropic", "openai", "compatible"];

export const CHOICE_LABEL: Record<ProviderChoice, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "local-server": "Servidor local",
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  compatible: "Compatible con OpenAI",
  fake: "Demo sin conexión",
  none: "Desactivada",
};

export const PRESET_LABEL: Record<CompatiblePreset, string> = {
  openrouter: "OpenRouter",
  groq: "Groq",
  together: "Together",
  azure: "Azure OpenAI",
  custom: "Personalizado",
};

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
  if (ai.provider === "compatible" && ai.preset && ai.preset !== "custom") return PRESET_LABEL[ai.preset];
  return CHOICE_LABEL[choiceOf(ai)];
}

/** One line on what leaves the Mac when generating a filter. Never message content. */
export function privacyLine(ai: AiSettings): string {
  if (ai.provider === "none") return "La IA está desactivada.";
  if (ai.local) return "Nada sale de este Mac.";
  return `Se envía a ${hostOf(ai) ?? providerName(ai)}: tu descripción, los correos y nombres de tus cuentas, los nombres de tus categorías y la fecha de hoy. Nunca el contenido de tus mensajes.`;
}

export const OUTPUT_LABEL: Record<OutputMode, string> = {
  json_schema: "salida estructurada ✓",
  json_object: "modo JSON",
  text: "texto",
};

/** Help that depends on why the AI failed. */
export function errorHelp(kind: AiErrorKind | undefined, ai: Pick<AiSettings, "provider" | "preset" | "local">): string | null {
  switch (kind) {
    case "auth":
      return "Revisa la API key: puede estar mal copiada o revocada.";
    case "rate_limited":
      return "El proveedor está limitando las peticiones. Espera un momento y vuelve a probar.";
    case "unavailable":
      return ai.local ? `Abre ${providerName(ai)} y comprueba el endpoint.` : "Comprueba tu conexión y el endpoint.";
    case "timeout":
      return ai.local ? "Los modelos locales tardan más la primera vez, mientras se cargan en memoria. Vuelve a probar." : "El proveedor tardó demasiado. Vuelve a probar.";
    case "blocked":
      return "El modo local solo permite modelos de este Mac.";
    case "invalid_output":
      return "El modelo no devolvió un filtro válido. Prueba un modelo instruct de 7B o más.";
    case "refused":
      return "El modelo rechazó la petición. Reformúlala o prueba otro modelo.";
    default:
      return null;
  }
}

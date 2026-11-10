import { aiCanRun, aiFeaturesAvailable, aiReady, AI_JOBS, routedByKeys, routeFor, SUMMARY_DEFAULT_MODEL, WRITING_CLAUDE_MODEL, type AiErrorKind, type AiJob, type AiProviderId, type AiRoute, type CompatiblePreset, type OutputMode } from "@terno/core";
import type { AiSettings, AppSettings } from "@terno/core/rpc";
import { getLocale, t } from "@terno/i18n";

/**
 * What the AI tab's selector shows: compatible appears twice (a server on this Mac, or a cloud API), and Claude and
 * OpenAI are one item, `keys` (plan 168: the keys saved decide what runs, so which of the two is stored chooses nothing).
 */
export type ProviderChoice = Exclude<AiProviderId, "compatible" | "jev"> | "local-server" | "compatible" | "keys";

export const LOCAL_CHOICES: ProviderChoice[] = ["ollama", "lmstudio", "local-server"];
export const CLOUD_CHOICES: ProviderChoice[] = ["keys", "compatible"];
/** Plan 168: the providers reached by key, in the order their key rows show. */
export const KEYED: readonly ("anthropic" | "openai")[] = ["anthropic", "openai"];

// brand names stay as they are; the rest is read in the current language
const CHOICE_LABEL = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "local-server": "ai.choice.localServer",
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  compatible: "ai.choice.compatible",
  keys: "ai.choice.keys",
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
  if (routedByKeys(ai.provider)) return "keys";
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
  // the provider itself, never the item that holds both
  if (routedByKeys(ai.provider)) return choiceLabel(ai.provider);
  return choiceLabel(choiceOf(ai));
}

export { aiReady };

/** Plan 168: what runs a job, by `routeFor` (the backend's rule); provider "none" when nothing can. */
export function routeOf(job: AiJob, ai: AiSettings): AiRoute {
  return routeFor(job, ai) ?? { provider: "none", model: "" };
}

export const askReady = (ai: AiSettings | null | undefined): boolean => aiCanRun("ask", ai);
export const summaryReady = (ai: AiSettings | null | undefined): boolean => aiCanRun("summary", ai);

const LOCAL_PROVIDERS: readonly AiProviderId[] = ["ollama", "lmstudio", "fake"];
/** A provider that runs on this Mac (plan 161, pass 2: what an error tells the user to do differs). */
export const localProvider = (provider: AiProviderId): boolean => LOCAL_PROVIDERS.includes(provider);

/** The model drafts run on, as the backend picks it (plan 168's `routeFor`). */
export function writingModel(ai: AiSettings): string {
  return routeOf("writing", ai).model;
}

/** Plan 133: where drafts go, by the backend's rule: whether it can run, and whether mail would leave this Mac. */
export function writingTarget(ai: AiSettings | null | undefined): { ready: boolean; provider: AiProviderId; local: boolean } {
  if (!ai) return { ready: false, provider: "none", local: true };
  const { provider } = routeOf("writing", ai);
  return { ready: aiCanRun("writing", ai), provider, local: provider === "none" || targetOf(ai, provider).local };
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
  // plan 168: where a filter's description goes, which on keys may be the other provider than the one stored
  const { provider } = routeOf("filter", ai);
  if (provider === "none") return ai.provider === "none" ? t("ai.privacy.off") : t("ai.privacy.cloud", { host: providerName(ai) });
  const target = targetOf(ai, provider);
  if (target.local) return t("ai.privacy.local");
  // plan 162 (after ai162-r03): the provider by name, as every other AI surface says it ("Claude (Anthropic)", never
  // api.anthropic.com); only a server of the user's own is said by its address
  return t("ai.privacy.cloud", { host: destinationName(ai, target) });
}

type Target = { provider: AiProviderId; preset: CompatiblePreset | null; baseURL: string | null; local: boolean };

/**
 * A task's target as the backend resolves it (`AiService.targetFor`'s `profiled`): the configured provider as it is set
 * up, another with its own saved preset and endpoint. Local only on loopback, as `isLocalProvider` says: Ollama or LM
 * Studio on another machine isn't (Codex critique 1).
 */
function targetOf(ai: AiSettings, provider: AiProviderId): Target {
  if (provider === ai.provider) return { provider, preset: ai.preset ?? null, baseURL: ai.baseURL ?? null, local: ai.local };
  const profile = ai.profiles?.[provider];
  const preset = profile?.preset ?? null;
  const baseURL = profile?.baseURL ?? null;
  const at = (url: string | null | undefined) => Boolean(url && isLoopbackUrl(url));
  const local =
    provider === "fake" ||
    (provider === "ollama" || provider === "lmstudio" ? at(baseURL ?? DEFAULT_ENDPOINT[provider]) : provider === "compatible" && (!preset || preset === "custom") && at(baseURL));
  return { provider, preset, baseURL, local };
}

/**
 * Who receives it, by name: a server of no fixed name (a custom or Azure endpoint, a local kind elsewhere) by its host
 * (Codex critique 2); a named one by its name, with the host beside it when its endpoint isn't its own (a relay in front
 * of OpenAI: Codex code review).
 */
function destinationName(ai: AiSettings, t: Target): string {
  const host = t.baseURL && URL.canParse(t.baseURL) ? new URL(t.baseURL).host : null;
  const named = t.provider === "compatible" ? !t.preset || t.preset === "custom" || t.preset === "azure" : t.provider === "ollama" || t.provider === "lmstudio";
  if (named && host) return host;
  const name = t.provider === "compatible" && t.preset && t.preset !== "custom" ? presetLabel(t.preset) : t.provider === ai.provider ? providerName(ai) : providerLabel(t.provider);
  const own = t.provider === "compatible" ? (t.preset ? PRESET_ENDPOINT[t.preset] : undefined) : CLOUD_HOST[t.provider] ? `https://${CLOUD_HOST[t.provider]}` : undefined;
  const ownHost = own && URL.canParse(own) ? new URL(own).host : null;
  return host && host !== ownHost ? `${name} (${host})` : name;
}

/**
 * Plan 131, the owner's decision (no per-use consent): every place off this Mac AI may send mail to, by the backend's
 * rule (plan 168's `routeFor` over every job), each with its own profile. On keys before one is saved, both: whichever
 * key comes first receives it. Named where AI is turned on, since nothing asks again when a feature runs.
 */
export function mailDestinations(ai: AiSettings): string[] {
  const providers = new Set<AiProviderId>();
  // drafting's first: the provider most of it goes to is named first
  for (const job of ["writing", ...AI_JOBS] as const) {
    const route = routeFor(job, ai);
    if (route) providers.add(route.provider);
  }
  if (routedByKeys(ai.provider) && !KEYED.some((p) => providers.has(p))) for (const p of KEYED) providers.add(p);
  const targets = [...providers].map((p) => targetOf(ai, p));
  return [...new Set(targets.filter((t) => t.provider !== "none" && !t.local).map((t) => destinationName(ai, t)))];
}

/**
 * Plan 168's one quiet line: who runs what, from `routeFor`, so it can't drift from what runs. On keys, the only split
 * the table has is summaries; JEV sorts with its key. Null where it would only repeat the provider row (one local model).
 */
export function routingLine(ai: AiSettings): string | null {
  if (!routedByKeys(ai.provider)) return null;
  const summary = routeFor("summary", ai);
  const writing = routeFor("writing", ai);
  if (!summary || !writing) return null;
  const main = summary.provider === writing.provider ? t("ai.route.one", { provider: providerLabel(writing.provider) }) : t("ai.route.split", { summaries: providerLabel(summary.provider), rest: providerLabel(writing.provider) });
  return routeFor("categorize", ai)?.provider === "jev" ? `${main} ${t("ai.route.jev")}` : main;
}

/** A list as the language says it: "Claude (Anthropic) and OpenAI". */
export const namesList = (names: readonly string[]): string => new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(names);

/** Settings → AI: where mail goes, and what goes there. `privacyLine` stays the AI filter's, which sends no mail. */
export function disclosureLine(ai: AiSettings): string {
  const names = mailDestinations(ai);
  if (names.length) return t("ai.disclosure.cloud", { count: names.length, providers: namesList(names) });
  return ai.provider === "none" ? t("ai.privacy.off") : t("ai.privacy.local");
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

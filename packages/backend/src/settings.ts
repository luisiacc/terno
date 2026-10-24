import {
  DEFAULT_ANTHROPIC_MODEL,
  describeProvider,
  isLocalProvider,
  keySecretName,
  resolveBaseURL,
  type AiProviderId,
  type Capabilities,
  type CompatiblePreset,
} from "@terno/ai";
import { AI_PROVIDER_IDS, builtinMode, canonicalThemeId, COMPATIBLE_PRESETS, CUSTOM_PREFIX, DEFAULT_THEME, type CustomTheme, type ThemeMode } from "@terno/core";
import type { AiProfile, AiSettings, AppSettings, SettingsPatch } from "@terno/core/rpc";
import type { MailStore } from "@terno/store";

/** The part of the store settings live in. */
export type SettingsStore = Pick<MailStore, "settings" | "secrets">;

type General = Omit<AppSettings, "ai" | "gmailClientSecretSet">;

/** What is persisted under settings.app. The renderer only ever sees AppSettings. */
interface StoredSettings extends Partial<General> {
  ai?: {
    provider?: AiProviderId;
    profiles?: Partial<Record<AiProviderId, AiProfile>>;
    /** observed by Test connection (or a ladder downgrade), per provider + endpoint + model */
    capabilities?: Record<string, Capabilities>;
  };
  /** pre-v3 shape, mapped on read */
  aiProvider?: "anthropic" | "fake" | "none";
  aiModel?: string;
}

export const DEFAULT_SETTINGS: General = {
  // new installs start local; migration v3 writes false for installs that predate it
  localMode: true,
  theme: "system",
  lightTheme: DEFAULT_THEME.light,
  darkTheme: DEFAULT_THEME.dark,
  motionMs: 75,
  htmlMailAppearance: "auto",
  customThemes: [],
  density: "comfortable",
  remoteImages: "ask",
  allowAgentSend: false,
  gmailClientId: "",
  syncWindowDays: 90,
  autoCategorize: "auto",
  aiCategorize: false,
};

const DEFAULT_PROVIDER: AiProviderId = "none";
const DEFAULT_PROFILES: Partial<Record<AiProviderId, AiProfile>> = {
  anthropic: { model: DEFAULT_ANTHROPIC_MODEL },
  openai: { model: "" },
  ollama: { model: "" },
  lmstudio: { model: "" },
  compatible: { model: "", preset: "custom" },
  fake: { model: "demo" },
};

/** The last 4 characters of each saved key, so the UI can say which key is stored without ever seeing it. */
const KEY_HINTS = "ai:keyHints";
/** The endpoint origin each saved key was saved (or confirmed) for: a key never goes anywhere else. */
const KEY_ORIGINS = "ai:keyOrigins";

/** Where a provider profile sends its requests (and so its key), as an origin. */
export function endpointOrigin(provider: AiProviderId, profile: Pick<AiProfile, "baseURL" | "preset"> | undefined): string | null {
  const url = resolveBaseURL({ id: provider, baseURL: profile?.baseURL, preset: profile?.preset });
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function keyOrigins(store: SettingsStore): Promise<Record<string, string>> {
  return store.settings.get<Record<string, string>>(KEY_ORIGINS, {});
}

export async function bindKeyOrigin(store: SettingsStore, secretName: string, origin: string | null): Promise<void> {
  await store.settings.update<Record<string, string>, void>(KEY_ORIGINS, {}, (origins) => {
    const next = { ...origins };
    if (origin) next[secretName] = origin;
    else delete next[secretName];
    return { value: next, result: undefined };
  });
}

/**
 * Keys saved before origins were recorded are bound to the endpoint they
 * serve now. Runs before anything can change an endpoint (a settings
 * change, an import), so an unbound key at use time still points where the
 * user saved it.
 */
export async function pinKeyOrigins(store: SettingsStore): Promise<void> {
  const s = await stored(store);
  const { profiles } = aiState(s, false);
  const origins = await keyOrigins(store);
  const missing: [string, string][] = [];
  for (const provider of AI_PROVIDER_IDS) {
    const presets = provider === "compatible" ? COMPATIBLE_PRESETS : [undefined];
    for (const preset of presets) {
      const name = keySecretName(provider, preset);
      if (origins[name] || !(await store.secrets.has(name))) continue;
      const profile = profiles[provider];
      const own = provider !== "compatible" || (profile?.preset ?? "custom") === preset ? profile : { preset };
      const origin = endpointOrigin(provider, own);
      if (origin) missing.push([name, origin]);
    }
  }
  for (const [name, origin] of missing) await bindKeyOrigin(store, name, origin);
}

function stored(store: SettingsStore): Promise<StoredSettings> {
  return store.settings.get<StoredSettings>("app", {});
}

export function capabilityKey(provider: AiProviderId, profile: AiProfile): string {
  return [provider, profile.preset ?? "", profile.baseURL ?? "", profile.model].join("|");
}

function aiState(s: StoredSettings, hasLegacyKey: boolean) {
  // pre-v3 installs that saved an Anthropic key without ever touching the selector were using Anthropic (the old default)
  const legacy = s.aiProvider ?? (hasLegacyKey ? "anthropic" : DEFAULT_PROVIDER);
  const provider: AiProviderId = s.ai?.provider ?? legacy;
  const profiles: Partial<Record<AiProviderId, AiProfile>> = { ...DEFAULT_PROFILES, ...s.ai?.profiles };
  if (!s.ai?.profiles?.anthropic && s.aiModel) profiles.anthropic = { model: s.aiModel };
  return { provider, profiles, capabilities: s.ai?.capabilities ?? {} };
}

/** Read on every ingestion slice: skips the AI and key lookups readSettings does. */
export async function readAutoCategorize(store: SettingsStore): Promise<AppSettings["autoCategorize"]> {
  return (await stored(store)).autoCategorize ?? DEFAULT_SETTINGS.autoCategorize;
}

/** Local mode alone: read on every outbound request, so it skips everything else. */
export async function readLocalMode(store: SettingsStore): Promise<boolean> {
  return (await stored(store)).localMode ?? DEFAULT_SETTINGS.localMode;
}

/** The mode a theme id belongs to, or null when it names nothing (unknown or deleted custom theme). */
function themeMode(id: string, custom: readonly CustomTheme[]): ThemeMode | null {
  if (id.startsWith(CUSTOM_PREFIX)) return custom.find((t) => t.id === id.slice(CUSTOM_PREFIX.length))?.mode ?? null;
  return builtinMode(id);
}

/**
 * Theme ids saved under their Única names read as their successors; a stored
 * id that no longer resolves (or is of the other mode) falls back to the mode's default.
 */
function resolveThemes(g: General): General {
  const customThemes = g.customThemes.map((t) => ({ ...t, extends: canonicalThemeId(t.extends) as CustomTheme["extends"] }));
  const ok = (id: string, mode: ThemeMode) => themeMode(id, customThemes) === mode;
  const [lightTheme, darkTheme] = [canonicalThemeId(g.lightTheme), canonicalThemeId(g.darkTheme)];
  return { ...g, customThemes, lightTheme: ok(lightTheme, "light") ? lightTheme : DEFAULT_THEME.light, darkTheme: ok(darkTheme, "dark") ? darkTheme : DEFAULT_THEME.dark };
}

export async function readSettings(store: SettingsStore): Promise<AppSettings> {
  const s = await stored(store);
  const { aiProvider: _p, aiModel: _m, ai: _ai, ...general } = s;
  const { provider, profiles, capabilities } = aiState(s, s.aiProvider === undefined && !s.ai?.provider && (await store.secrets.has(keySecretName("anthropic"))));
  const profile = profiles[provider] ?? { model: "" };
  const secret = keySecretName(provider, profile.preset);
  const bound = (await keyOrigins(store))[secret] ?? null;
  const ai: AiSettings = {
    provider,
    model: profile.model,
    baseURL: profile.baseURL ?? null,
    preset: profile.preset ?? null,
    hasKey: await store.secrets.has(secret),
    keyHint: (await store.settings.get<Record<string, string>>(KEY_HINTS, {}))[secret] ?? null,
    keyOrigin: bound,
    // unbound: saved before origins were recorded and its endpoint never changed since (pinKeyOrigins)
    keyConfirmed: bound === null || bound === endpointOrigin(provider, profile),
    local: isLocalProvider({ id: provider, baseURL: profile.baseURL, preset: profile.preset }),
    capabilities: capabilities[capabilityKey(provider, profile)] ?? null,
    profiles,
  };
  return { ...resolveThemes({ ...DEFAULT_SETTINGS, ...general }), gmailClientSecretSet: await store.secrets.has("gmailClientSecret"), ai };
}

export class SettingsError extends Error {}

/**
 * Applies a settings patch. Selecting a cloud provider while local mode is on
 * is refused; turning local mode on with a cloud provider keeps it dormant.
 */
export async function updateSettings(store: SettingsStore, patch: SettingsPatch, options: { endpointIsLocal?: boolean } = {}): Promise<AppSettings> {
  if (patch.ai) await pinKeyOrigins(store);
  const hasLegacyKey = await store.secrets.has(keySecretName("anthropic"));
  await store.settings.update<StoredSettings, void>("app", {}, (s) => ({ value: patchedSettings(s, patch, options, hasLegacyKey), result: undefined }));
  return readSettings(store);
}

function patchedSettings(s: StoredSettings, patch: SettingsPatch, options: { endpointIsLocal?: boolean }, hasLegacyKey: boolean): StoredSettings {
  const { ai: aiPatch, ...rest } = patch;
  const general = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const state = aiState(s, hasLegacyKey);
  let { provider } = state;
  const profiles = { ...state.profiles };
  let selecting = false;
  if (aiPatch) {
    if (aiPatch.provider !== undefined) {
      selecting ||= aiPatch.provider !== provider;
      provider = aiPatch.provider;
    }
    const current: AiProfile = { ...(profiles[provider] ?? { model: "" }) };
    if (aiPatch.model !== undefined) current.model = aiPatch.model;
    if (aiPatch.baseURL !== undefined) {
      selecting ||= (aiPatch.baseURL ?? undefined) !== current.baseURL;
      if (aiPatch.baseURL) current.baseURL = aiPatch.baseURL;
      else delete current.baseURL;
    }
    if (aiPatch.preset !== undefined) {
      selecting ||= (aiPatch.preset ?? undefined) !== current.preset;
      if (aiPatch.preset) current.preset = aiPatch.preset;
      else delete current.preset;
    }
    if (provider === "compatible" && !current.preset) current.preset = "custom";
    profiles[provider] = current;
  }
  // a theme must exist and belong to its mode; deleting a custom theme in use falls back on read
  const custom = (general.customThemes as CustomTheme[] | undefined) ?? s.customThemes ?? [];
  for (const [key, mode] of [["lightTheme", "light"], ["darkTheme", "dark"]] as const) {
    const id = general[key] as string | undefined;
    if (id !== undefined && themeMode(id, custom) !== mode) throw new SettingsError(`Tema desconocido para el modo ${mode === "light" ? "claro" : "oscuro"}: ${id}`);
  }
  const localMode = (general.localMode as boolean | undefined) ?? s.localMode ?? DEFAULT_SETTINGS.localMode;
  const profile = profiles[provider] ?? { model: "" };
  // a custom endpoint may be a name that resolves to loopback: the caller checked it (see endpointIsLocal)
  const local = isLocalProvider({ id: provider, baseURL: profile.baseURL, preset: profile.preset }) || (provider === "compatible" && profile.preset === "custom" && options.endpointIsLocal === true);
  if (selecting && localMode && provider !== "none" && !local) {
    throw new SettingsError(`${describeProvider(provider).label} usa la nube y el modo local está activado. Desactívalo en Ajustes → General para usarla.`);
  }
  const { aiProvider: _p, aiModel: _m, ...kept } = s;
  return { ...kept, ...general, ai: { ...s.ai, provider, profiles } };
}

export async function saveCapabilities(store: SettingsStore, provider: AiProviderId, profile: AiProfile, capabilities: Capabilities): Promise<void> {
  await store.settings.update<StoredSettings, void>("app", {}, (s) => {
    const ai = s.ai ?? {};
    return { value: { ...s, ai: { ...ai, capabilities: { ...ai.capabilities, [capabilityKey(provider, profile)]: capabilities } } }, result: undefined };
  });
}

export async function setKeyHint(store: SettingsStore, provider: AiProviderId, preset: CompatiblePreset | null | undefined, hint: string | null): Promise<void> {
  const name = keySecretName(provider, preset);
  await store.settings.update<Record<string, string>, void>(KEY_HINTS, {}, (hints) => {
    const next = { ...hints };
    if (hint) next[name] = hint;
    else delete next[name];
    return { value: next, result: undefined };
  });
}

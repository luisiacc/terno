import {
  DEFAULT_ANTHROPIC_MODEL,
  describeProvider,
  isLocalProvider,
  keySecretName,
  type AiProviderId,
  type Capabilities,
  type CompatiblePreset,
} from "@unica/ai";
import type { AiProfile, AiSettings, AppSettings, SettingsPatch } from "@unica/core/rpc";
import { getSecret, getSetting, setSetting, type Db } from "@unica/db";

type General = Omit<AppSettings, "ai">;

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

function stored(db: Db): StoredSettings {
  return getSetting<StoredSettings>(db, "app", {});
}

export function capabilityKey(provider: AiProviderId, profile: AiProfile): string {
  return [provider, profile.preset ?? "", profile.baseURL ?? "", profile.model].join("|");
}

function aiState(db: Db, s: StoredSettings) {
  // pre-v3 installs that saved an Anthropic key without ever touching the selector were using Anthropic (the old default)
  const legacy = s.aiProvider ?? (getSecret(db, keySecretName("anthropic")) ? "anthropic" : DEFAULT_PROVIDER);
  const provider: AiProviderId = s.ai?.provider ?? legacy;
  const profiles: Partial<Record<AiProviderId, AiProfile>> = { ...DEFAULT_PROFILES, ...s.ai?.profiles };
  if (!s.ai?.profiles?.anthropic && s.aiModel) profiles.anthropic = { model: s.aiModel };
  return { provider, profiles, capabilities: s.ai?.capabilities ?? {} };
}

/** Read on every ingestion slice: skips the AI and key lookups readSettings does. */
export function readAutoCategorize(db: Db): AppSettings["autoCategorize"] {
  return stored(db).autoCategorize ?? DEFAULT_SETTINGS.autoCategorize;
}

/** Local mode alone: read on every outbound request, so it skips everything else. */
export function readLocalMode(db: Db): boolean {
  return stored(db).localMode ?? DEFAULT_SETTINGS.localMode;
}

export function readSettings(db: Db): AppSettings {
  const s = stored(db);
  const { aiProvider: _p, aiModel: _m, ai: _ai, ...general } = s;
  const { provider, profiles, capabilities } = aiState(db, s);
  const profile = profiles[provider] ?? { model: "" };
  const secret = keySecretName(provider, profile.preset);
  const ai: AiSettings = {
    provider,
    model: profile.model,
    baseURL: profile.baseURL ?? null,
    preset: profile.preset ?? null,
    hasKey: getSecret(db, secret) !== null,
    keyHint: getSetting<Record<string, string>>(db, KEY_HINTS, {})[secret] ?? null,
    local: isLocalProvider({ id: provider, baseURL: profile.baseURL, preset: profile.preset }),
    capabilities: capabilities[capabilityKey(provider, profile)] ?? null,
    profiles,
  };
  return { ...DEFAULT_SETTINGS, ...general, ai };
}

export class SettingsError extends Error {}

/**
 * Applies a settings patch. Selecting a cloud provider while local mode is on
 * is refused; turning local mode on with a cloud provider keeps it dormant.
 */
export function updateSettings(db: Db, patch: SettingsPatch, options: { endpointIsLocal?: boolean } = {}): AppSettings {
  const s = stored(db);
  const { ai: aiPatch, ...rest } = patch;
  const general = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const state = aiState(db, s);
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
  const localMode = (general.localMode as boolean | undefined) ?? s.localMode ?? DEFAULT_SETTINGS.localMode;
  const profile = profiles[provider] ?? { model: "" };
  // a custom endpoint may be a name that resolves to loopback: the caller checked it (see endpointIsLocal)
  const local = isLocalProvider({ id: provider, baseURL: profile.baseURL, preset: profile.preset }) || (provider === "compatible" && profile.preset === "custom" && options.endpointIsLocal === true);
  if (selecting && localMode && provider !== "none" && !local) {
    throw new SettingsError(`${describeProvider(provider).label} usa la nube y el modo local está activado. Desactívalo en Ajustes → General para usarla.`);
  }
  const { aiProvider: _p, aiModel: _m, ...kept } = s;
  setSetting(db, "app", { ...kept, ...general, ai: { ...s.ai, provider, profiles } });
  return readSettings(db);
}

export function saveCapabilities(db: Db, provider: AiProviderId, profile: AiProfile, capabilities: Capabilities): void {
  const s = stored(db);
  const ai = s.ai ?? {};
  setSetting(db, "app", { ...s, ai: { ...ai, capabilities: { ...ai.capabilities, [capabilityKey(provider, profile)]: capabilities } } });
}

export function setKeyHint(db: Db, provider: AiProviderId, preset: CompatiblePreset | null | undefined, hint: string | null): void {
  const hints = getSetting<Record<string, string>>(db, KEY_HINTS, {});
  const name = keySecretName(provider, preset);
  if (hint) hints[name] = hint;
  else delete hints[name];
  setSetting(db, KEY_HINTS, hints);
}

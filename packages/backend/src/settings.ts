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
import { AI_PROVIDER_IDS, builtinMode, canonicalThemeId, COMPATIBLE_PRESETS, CUSTOM_PREFIX, DEFAULT_DESIGN, DESIGN_PALETTE, isDesignId, textRef, type CustomTheme, type TextRef, type ThemeMode } from "@terno/core";
import type { AiProfile, AiSettings, AppSettings, SettingsPatch } from "@terno/core/rpc";
import { isLanguageSetting, L, type Localized } from "@terno/i18n";
import type { MailStore } from "@terno/store";
import { unreadableSecrets } from "./keychain";

/** The part of the store settings live in. */
export type SettingsStore = Pick<MailStore, "settings" | "secrets">;

type General = Omit<AppSettings, "ai" | "gmailClientSecretSet" | "gmailClientSecretUnreadable">;

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
  /** plan 15: 2 once the move to designs happened (see migrateAppearance) */
  appearanceVersion?: number;
  /** plan 37: 1 once local mode stopped deciding remote images (see migrateRemoteImages) */
  remoteImagesVersion?: number;
  /** plan 78: 1 once local mode stopped deciding error reports (see migrateErrorReports) */
  errorReportsVersion?: number;
}

export const APPEARANCE_VERSION = 2;

/**
 * Plan 15: everyone moves to the full Lumen look (Lumen and its own colors):
 * the user asked for it to be the default. A palette chosen before is
 * remembered as "previous", one click away under Colors, but no longer
 * applied. Pure: reads apply it until the next write persists it.
 */
export function migrateAppearance(s: StoredSettings): StoredSettings {
  if ((s.appearanceVersion ?? 0) >= APPEARANCE_VERSION) return s;
  const { lightTheme, darkTheme, design: _d, ...rest } = s;
  const previous = (id: string | undefined) => (id && id !== DESIGN_PALETTE ? canonicalThemeId(id) : null);
  return { ...rest, previousLightTheme: previous(lightTheme), previousDarkTheme: previous(darkTheme), appearanceVersion: APPEARANCE_VERSION };
}

export const REMOTE_IMAGES_VERSION = 1;

/**
 * Plan 37: local mode no longer decides remote images. A profile in local
 * mode that stored "always" (chosen while connected) showed the switch off and
 * loaded nothing; it keeps that: "ask". Pure, like migrateAppearance: reads
 * apply it until the next write persists it with the marker.
 */
export function migrateRemoteImages(s: StoredSettings): StoredSettings {
  if ((s.remoteImagesVersion ?? 0) >= REMOTE_IMAGES_VERSION) return s;
  const local = s.localMode ?? DEFAULT_SETTINGS.localMode;
  return { ...s, ...(local && s.remoteImages === "always" ? { remoteImages: "ask" as const } : {}), remoteImagesVersion: REMOTE_IMAGES_VERSION };
}

export const ERROR_REPORTS_VERSION = 1;

/**
 * Plan 78: local mode no longer decides error reports. A profile in local
 * mode that stored "always" (chosen while connected) showed "never" and sent
 * nothing; it doesn't start sending silently: "ask". Pure, like the others.
 */
export function migrateErrorReports(s: StoredSettings): StoredSettings {
  if ((s.errorReportsVersion ?? 0) >= ERROR_REPORTS_VERSION) return s;
  const local = s.localMode ?? DEFAULT_SETTINGS.localMode;
  return { ...s, ...(local && s.errorReports === "always" ? { errorReports: "ask" as const } : {}), errorReportsVersion: ERROR_REPORTS_VERSION };
}

/** Every read-time migration, in order. */
function migrate(s: StoredSettings): StoredSettings {
  return migrateErrorReports(migrateRemoteImages(migrateAppearance(s)));
}

export const DEFAULT_SETTINGS: General = {
  // new installs start local; migration v3 writes false for installs that predate it
  localMode: true,
  theme: "system",
  // plan 15: Lumen, in its own colors
  design: DEFAULT_DESIGN,
  lightTheme: DESIGN_PALETTE,
  darkTheme: DESIGN_PALETTE,
  previousLightTheme: null,
  previousDarkTheme: null,
  motionMs: 75,
  htmlMailAppearance: "auto",
  customThemes: [],
  density: "comfortable",
  // plan 24: nothing changes for anyone who doesn't choose List
  layout: "split",
  remoteImages: "ask",
  allowAgentSend: false,
  gmailClientId: "",
  syncWindowDays: 180,
  autoCategorize: "auto",
  aiCategorize: false,
  errorReports: "ask",
  // new installs follow the system: English unless it's a language Terno ships
  language: "system",
  composeSuggestions: true,
  // plan 22: website icons are on in either mode until turned off
  senderIcons: true,
  googlePhotos: {},
  googlePhotosPending: [],
  // plan 41: like Mail, the count and the notifications are on until turned off
  dockBadge: true,
  notifications: true,
  notificationPreview: true,
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

async function stored(store: SettingsStore): Promise<StoredSettings> {
  return migrate(await store.settings.get<StoredSettings>("app", {}));
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

/** Body suggestions (plan 18), read when autocomplete warms and when the setting changes. */
export async function readComposeSuggestions(store: SettingsStore): Promise<boolean> {
  return (await stored(store)).composeSuggestions ?? DEFAULT_SETTINGS.composeSuggestions;
}

/** Plan 41: the Dock badge and notifications, read at start and when settings change. */
export async function readAttention(store: SettingsStore): Promise<Pick<AppSettings, "dockBadge" | "notifications" | "notificationPreview">> {
  const s = await stored(store);
  return {
    dockBadge: s.dockBadge ?? DEFAULT_SETTINGS.dockBadge,
    notifications: s.notifications ?? DEFAULT_SETTINGS.notifications,
    notificationPreview: s.notificationPreview ?? DEFAULT_SETTINGS.notificationPreview,
  };
}

/** Local mode alone: read on every outbound request, so it skips everything else. */
export async function readLocalMode(store: SettingsStore): Promise<boolean> {
  return (await stored(store)).localMode ?? DEFAULT_SETTINGS.localMode;
}

/** Plan 22: whether website icons may be fetched: in either mode, unless the user turned them off. */
export async function readSiteIcons(store: SettingsStore): Promise<boolean> {
  return (await stored(store)).senderIcons ?? DEFAULT_SETTINGS.senderIcons;
}

/** Plan 22: the Gmail accounts showing photos from Google, and what each was granted. */
export async function readGooglePhotos(store: SettingsStore): Promise<AppSettings["googlePhotos"]> {
  return (await stored(store)).googlePhotos ?? {};
}

/** Plan 22: an account's photo state (null: off), written only by the icons service. */
/** `clearPending`: a consent or the user's off ends any wait (plan 74); the icon service's own updates leave it alone. */
export async function setGooglePhotoState(store: SettingsStore, accountId: number, state: AppSettings["googlePhotos"][string] | null, clearPending = true): Promise<void> {
  await store.settings.update<StoredSettings, void>("app", {}, (raw) => {
    const s = migrate(raw);
    const next = { ...s.googlePhotos };
    if (state) next[String(accountId)] = state;
    else delete next[String(accountId)];
    // plan 74: on (through any flow) or off, it no longer waits for a sign-in
    const pending = clearPending ? (s.googlePhotosPending ?? []).filter((id) => id !== accountId) : (s.googlePhotosPending ?? []);
    return { value: { ...s, googlePhotos: next, googlePhotosPending: pending }, result: undefined };
  });
}

/**
 * Plan 74: a sign-in's consent turns photos on only if the account still waits, read in the same transaction as the
 * write (off at any moment before it wins). True when it turned them on.
 */
export async function consumeGooglePhotosPending(store: SettingsStore, accountId: number, state: AppSettings["googlePhotos"][string]): Promise<boolean> {
  return store.settings.update<StoredSettings, boolean>("app", {}, (raw) => {
    const s = migrate(raw);
    const pending = s.googlePhotosPending ?? [];
    if (!pending.includes(accountId)) return { value: s, result: false };
    return { value: { ...s, googlePhotos: { ...s.googlePhotos, [String(accountId)]: state }, googlePhotosPending: pending.filter((id) => id !== accountId) }, result: true };
  });
}

/** Plan 74: an account's photos switched on to come with its next sign-in with Google (or no longer waiting). */
export async function setGooglePhotosPending(store: SettingsStore, accountId: number, on: boolean): Promise<void> {
  await store.settings.update<StoredSettings, void>("app", {}, (raw) => {
    const s = migrate(raw);
    const rest = (s.googlePhotosPending ?? []).filter((id) => id !== accountId);
    return { value: { ...s, googlePhotosPending: on ? [...rest, accountId] : rest }, result: undefined };
  });
}

/** Plan 74: whether an account's next sign-in with Google should ask for the contacts scopes too. */
export async function googlePhotosPending(store: SettingsStore, accountId: number): Promise<boolean> {
  return ((await stored(store)).googlePhotosPending ?? []).includes(accountId);
}

/** What the host enforces outside the backend: the network fence and whether error reports may go. */
export async function readPolicy(store: SettingsStore): Promise<{ localMode: boolean; errorReports: AppSettings["errorReports"]; language: AppSettings["language"] }> {
  const s = await stored(store);
  return { localMode: s.localMode ?? DEFAULT_SETTINGS.localMode, errorReports: s.errorReports ?? DEFAULT_SETTINGS.errorReports, language: languageOf(s) };
}

/** A stored language Terno no longer ships (or garbage) reads as "system". */
function languageOf(s: StoredSettings): AppSettings["language"] {
  return isLanguageSetting(s.language) ? s.language : DEFAULT_SETTINGS.language;
}

/** The mode a theme id belongs to, or null when it names nothing (unknown or deleted custom theme). */
function themeMode(id: string, custom: readonly CustomTheme[]): ThemeMode | null {
  if (id.startsWith(CUSTOM_PREFIX)) return custom.find((t) => t.id === id.slice(CUSTOM_PREFIX.length))?.mode ?? null;
  return builtinMode(id);
}

/** May `id` fill the `mode` slot: "Style colors" fits both, a palette only its own mode. */
function fitsMode(id: string, mode: ThemeMode, custom: readonly CustomTheme[]): boolean {
  return id === DESIGN_PALETTE || themeMode(id, custom) === mode;
}

/**
 * Theme ids saved under their Única names read as their successors; a stored
 * id that no longer resolves (or is of the other mode) falls back to "Style
 * colors"; a remembered previous palette that no longer resolves is forgotten.
 */
function resolveThemes(g: General): General {
  const customThemes = g.customThemes.map((t) => ({ ...t, extends: canonicalThemeId(t.extends) as CustomTheme["extends"] }));
  const pick = (id: string, mode: ThemeMode) => (fitsMode(canonicalThemeId(id), mode, customThemes) ? canonicalThemeId(id) : DESIGN_PALETTE);
  const previous = (id: string | null, mode: ThemeMode) => (id && id !== DESIGN_PALETTE && themeMode(canonicalThemeId(id), customThemes) === mode ? canonicalThemeId(id) : null);
  return {
    ...g,
    customThemes,
    design: isDesignId(g.design) ? g.design : DEFAULT_DESIGN,
    lightTheme: pick(g.lightTheme, "light"),
    darkTheme: pick(g.darkTheme, "dark"),
    previousLightTheme: previous(g.previousLightTheme, "light"),
    previousDarkTheme: previous(g.previousDarkTheme, "dark"),
  };
}

export async function readSettings(store: SettingsStore): Promise<AppSettings> {
  const s = await stored(store);
  const { aiProvider: _p, aiModel: _m, ai: _ai, appearanceVersion: _v, remoteImagesVersion: _r, errorReportsVersion: _e, ...general } = s;
  const { provider, profiles, capabilities } = aiState(s, s.aiProvider === undefined && !s.ai?.provider && (await store.secrets.has(keySecretName("anthropic"))));
  const profile = profiles[provider] ?? { model: "" };
  const secret = keySecretName(provider, profile.preset);
  const bound = (await keyOrigins(store))[secret] ?? null;
  const unreadable = await unreadableSecrets(store);
  const ai: AiSettings = {
    provider,
    model: profile.model,
    baseURL: profile.baseURL ?? null,
    preset: profile.preset ?? null,
    hasKey: await store.secrets.has(secret),
    keyUnreadable: unreadable.has(secret),
    keyHint: (await store.settings.get<Record<string, string>>(KEY_HINTS, {}))[secret] ?? null,
    keyOrigin: bound,
    // unbound: saved before origins were recorded and its endpoint never changed since (pinKeyOrigins)
    keyConfirmed: bound === null || bound === endpointOrigin(provider, profile),
    local: isLocalProvider({ id: provider, baseURL: profile.baseURL, preset: profile.preset }),
    capabilities: capabilities[capabilityKey(provider, profile)] ?? null,
    profiles,
  };
  return { ...resolveThemes({ ...DEFAULT_SETTINGS, ...general, language: languageOf(s) }), gmailClientSecretSet: await store.secrets.has("gmailClientSecret"), gmailClientSecretUnreadable: unreadable.has("gmailClientSecret"), ai };
}

export class SettingsError extends Error {
  readonly expected = true;
  /** set when the message is a catalog message (L()): the renderer translates it */
  readonly i18n?: TextRef;
  constructor(message: string | Localized) {
    super(typeof message === "string" ? message : message.message);
    this.name = "SettingsError";
    const i18n = textRef(message);
    if (i18n) this.i18n = i18n;
  }
}

/**
 * Applies a settings patch. Selecting a cloud provider while local mode is on
 * is refused; turning local mode on with a cloud provider keeps it dormant.
 */
export async function updateSettings(store: SettingsStore, patch: SettingsPatch, options: { endpointIsLocal?: boolean } = {}): Promise<AppSettings> {
  if (patch.ai) await pinKeyOrigins(store);
  const hasLegacyKey = await store.secrets.has(keySecretName("anthropic"));
  await store.settings.update<StoredSettings, void>("app", {}, (s) => ({ value: patchedSettings(migrate(s), patch, options, hasLegacyKey), result: undefined }));
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
    if (id !== undefined && !fitsMode(id, mode, custom)) throw new SettingsError(L(mode === "light" ? "errors.themeUnknownLight" : "errors.themeUnknownDark", { id }));
  }
  const localMode = (general.localMode as boolean | undefined) ?? s.localMode ?? DEFAULT_SETTINGS.localMode;
  const profile = profiles[provider] ?? { model: "" };
  // a custom endpoint may be a name that resolves to loopback: the caller checked it (see endpointIsLocal)
  const local = isLocalProvider({ id: provider, baseURL: profile.baseURL, preset: profile.preset }) || (provider === "compatible" && profile.preset === "custom" && options.endpointIsLocal === true);
  if (selecting && localMode && provider !== "none" && !local) {
    throw new SettingsError(L("errors.cloudAiLocalMode", { provider: describeProvider(provider).label }));
  }
  const { aiProvider: _p, aiModel: _m, ...kept } = s;
  return { ...kept, ...general, ai: { ...s.ai, provider, profiles } };
}

export async function saveCapabilities(store: SettingsStore, provider: AiProviderId, profile: AiProfile, capabilities: Capabilities): Promise<void> {
  await store.settings.update<StoredSettings, void>("app", {}, (raw) => {
    const s = migrate(raw);
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

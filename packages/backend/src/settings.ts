import {
  DEFAULT_ANTHROPIC_MODEL,
  isLocalProvider,
  keySecretName,
  resolveBaseURL,
  type AiProviderId,
  type Capabilities,
  type CompatiblePreset,
} from "@terno/ai";
import { AI_PROVIDER_IDS, canonicalThemeId, COMPATIBLE_PRESETS, DEFAULT_DESIGN, DESIGN_IDS, DESIGN_PALETTE, DEV_AI_PROVIDERS, fitsMode, isDesignId, isDevAiProvider, JEV_DEFAULT_MODEL, SUMMARY_DEFAULT_MODEL, textRef, type DevAiKeys, themeMode, type AiTaskName, type AiTaskTarget, type CustomTheme, type TextRef, type ThemeMode } from "@terno/core";
import type { AiProfile, AiSettings, AppSettings, SettingsPatch } from "@terno/core/rpc";
import { FAVORITES_MAX, NUDGE_DEFAULT, type FavoriteFolder } from "@terno/core";
import { isLanguageSetting, L, type Localized } from "@terno/i18n";
import type { MailStore } from "@terno/store";
import { unreadableSecrets } from "./keychain";

/** The part of the store settings live in. */
export type SettingsStore = Pick<MailStore, "settings" | "secrets">;

type General = Omit<AppSettings, "ai">;

/** What is persisted under settings.app. The renderer only ever sees AppSettings. */
interface StoredSettings extends Partial<General> {
  ai?: {
    provider?: AiProviderId;
    profiles?: Partial<Record<AiProviderId, AiProfile>>;
    /** observed by Test connection (or a ladder downgrade), per provider + endpoint + model */
    capabilities?: Record<string, Capabilities>;
    /** plan 131 */
    tasks?: Partial<Record<AiTaskName, AiTaskTarget>>;
    monthlyLimitUsd?: number;
  };
  /** plan 123: a Google client of the user's own (before it); dropped on read */
  gmailClientId?: string;
  /** pre-v3 shape, mapped on read */
  aiProvider?: "anthropic" | "fake" | "none";
  aiModel?: string;
  /** plan 15: 2 once the move to designs happened (see migrateAppearance) */
  appearanceVersion?: number;
  /** plan 37: 1 once local mode stopped deciding remote images (see migrateRemoteImages) */
  remoteImagesVersion?: number;
  /** plan 78: 1 once local mode stopped deciding error reports (see migrateErrorReports) */
  errorReportsVersion?: number;
  /** plan 97: 1 once local mode stopped deciding the network (see migrateLocalMail) */
  localMailVersion?: number;
  /** plan 134: 1 once a switch that was on before it sent more mail was turned off (see stampSmartCategorize) */
  smartCategorizeVersion?: number;
}

export const APPEARANCE_VERSION = 3;

/**
 * Plan 15 (v2): everyone moves to the full Lumen look (Lumen and its own
 * colors): the user asked for it to be the default. A palette chosen before is
 * remembered as "previous", one click away under Colors, but no longer
 * applied. Plan 98 (v3): new installs default to the GitHub palettes; a
 * profile that already exists keeps what it shows ("design" where it never
 * chose). `fresh` is read from the raw stored object, before any migration
 * adds a field. Pure: reads apply it until the next write persists it.
 */
export function migrateAppearance(s: StoredSettings, fresh = Object.keys(s).length === 0): StoredSettings {
  const version = s.appearanceVersion ?? 0;
  if (version >= APPEARANCE_VERSION) return s;
  let next = s;
  if (version < 2) {
    const { lightTheme, darkTheme, design: _d, ...rest } = next;
    const previous = (id: string | undefined) => (id && id !== DESIGN_PALETTE ? canonicalThemeId(id) : null);
    next = { ...rest, previousLightTheme: previous(lightTheme), previousDarkTheme: previous(darkTheme) };
  }
  if (!fresh) next = { ...next, lightTheme: next.lightTheme ?? DESIGN_PALETTE, darkTheme: next.darkTheme ?? DESIGN_PALETTE };
  return { ...next, appearanceVersion: APPEARANCE_VERSION };
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

export const LOCAL_MAIL_VERSION = 1;

/**
 * Plan 97: local mode means Terno keeps its copy of your mail here; it no
 * longer blocks cloud AI. A cloud provider chosen before local mode was
 * turned on was paused, not in use: it doesn't start sending mail text on
 * its own. It goes back to "none" (its profile and saved key stay, so
 * choosing it again is one click), and so does AI categorizing. Pure, like
 * the others.
 */
export function migrateLocalMail(s: StoredSettings): StoredSettings {
  if ((s.localMailVersion ?? 0) >= LOCAL_MAIL_VERSION) return s;
  const local = s.localMode ?? DEFAULT_SETTINGS.localMode;
  const provider = s.ai?.provider ?? s.aiProvider;
  const profile = provider ? s.ai?.profiles?.[provider] : undefined;
  // what local mode let through: an endpoint on this Mac (a local kind pointed elsewhere was blocked too; a custom
  // name that resolved to loopback can't be told apart here, and is cleared: the safe side, Codex review R1)
  const paused = local && provider !== undefined && provider !== "none" && !isLocalProvider({ id: provider, baseURL: profile?.baseURL, preset: profile?.preset });
  if (!paused) return { ...s, localMailVersion: LOCAL_MAIL_VERSION };
  const { aiProvider: _p, aiModel: _m, ...rest } = s;
  return { ...rest, ai: { ...s.ai, provider: "none" }, aiCategorize: false, localMailVersion: LOCAL_MAIL_VERSION };
}

/** Every read-time migration, in order. */
function migrate(s: StoredSettings): StoredSettings {
  return migrateLocalMail(migrateErrorReports(migrateRemoteImages(migrateAppearance(s))));
}

export const DEFAULT_SETTINGS: General = {
  devAi: false,
  // new installs start local; migration v3 writes false for installs that predate it
  localMode: true,
  theme: "system",
  // plan 15: Lumen; plan 98: in the GitHub palettes (profiles from before keep Lumen's own, see migrateAppearance)
  design: DEFAULT_DESIGN,
  lightTheme: "github-light",
  darkTheme: "github-dark",
  previousLightTheme: null,
  previousDarkTheme: null,
  designPalettes: {},
  motionMs: 75,
  htmlMailAppearance: "auto",
  customThemes: [],
  density: "comfortable",
  // plan 24: nothing changes for anyone who doesn't choose List
  layout: "split",
  remoteImages: "ask",
  allowAgentSend: false,
  syncWindowDays: 180,
  autoCategorize: "auto",
  aiCategorize: false,
  aiCategorizeWidened: false,
  summaries: { enabled: false, enabledAt: null, acknowledged: [] },
  ask: { enabled: true, acknowledged: [] },
  replies: { enabled: false },
  followups: { enabled: false, enabledAt: null, nudgeAfterDays: NUDGE_DEFAULT, scanAnswered: false },
  errorReports: "ask",
  // new installs follow the system: English unless it's a language Terno ships
  language: "system",
  composeSuggestions: true,
  // plan 22: website icons are on in either mode until turned off
  senderIcons: true,
  googlePhotos: {},
  googlePhotosPending: [],
  // plan 107: folders below Starred
  favoriteFolders: [],
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
  jev: { model: JEV_DEFAULT_MODEL },
  fake: { model: "demo" },
};

/** Background AI's monthly ceiling until the user sets another: plenty for normal use, far from a surprise bill. */
export const DEFAULT_MONTHLY_LIMIT_USD = 10;

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

/** Plan 107: the folders below Starred, in the order added. */
export async function readFavoriteFolders(store: SettingsStore): Promise<FavoriteFolder[]> {
  return (await stored(store)).favoriteFolders ?? [];
}

const sameFavorite = (a: FavoriteFolder, b: FavoriteFolder) => a.accountId === b.accountId && a.folder === b.folder && a.view === b.view;

/**
 * Plan 107: one folder (or standard row) below Starred, or not: never twice, at most FAVORITES_MAX, in the order added.
 * Ones `live` says are gone (deleted or renamed in another app) go first (Codex code review #8: 50 of them, invisible,
 * filled the limit for good).
 */
export async function setFavoriteFolder(store: SettingsStore, target: FavoriteFolder, on: boolean, live: (f: FavoriteFolder) => boolean = () => true): Promise<FavoriteFolder[]> {
  return store.settings.update<StoredSettings, FavoriteFolder[]>("app", {}, (raw) => {
    const s = migrate(raw);
    const list = (s.favoriteFolders ?? []).filter(live);
    const rest = list.filter((f) => !sameFavorite(f, target));
    if (on && rest.length === list.length && list.length >= FAVORITES_MAX) throw new SettingsError(L("errors.folder.favoritesMax", { max: FAVORITES_MAX }));
    const next = on ? (rest.length === list.length ? [...list, target] : list) : rest;
    return { value: { ...s, favoriteFolders: next }, result: next };
  });
}

/**
 * Plan 107: favorites follow an account's folders: `renamed` keys move (an IMAP rename gives a folder a new key), and
 * the `deleted` ones go, or all of a removed account's (`deleted: "all"`). `listed`: the account's whole list as just
 * stored (its authoritative catalog): one of its own folders not in it went in another app, and goes too (Codex code
 * review round 24 #3: invisible, it still counted toward the limit when another account's folder was favorited).
 * Nothing is written when none is touched (null).
 */
export async function followFavoriteFolders(store: SettingsStore, accountId: number, change: { renamed?: readonly { from: string; to: string }[]; deleted?: readonly string[] | "all"; listed?: ReadonlySet<string> }): Promise<FavoriteFolder[] | null> {
  // a pass with nothing to follow reads and writes nothing more (it runs on every one that stores a list)
  if (!change.renamed?.length && !change.deleted?.length) {
    const listed = change.listed;
    if (!listed || (await readFavoriteFolders(store)).every((f) => f.accountId !== accountId || f.folder === null || listed.has(f.folder))) return null;
  }
  return store.settings.update<StoredSettings, FavoriteFolder[] | null>("app", {}, (raw) => {
    const s = migrate(raw);
    const list = s.favoriteFolders ?? [];
    const moved = new Map(change.renamed?.map((m) => [m.from, m.to]));
    const gone = change.deleted === "all" ? null : new Set(change.deleted);
    let touched = false;
    const next: FavoriteFolder[] = [];
    for (const f of list) {
      if (f.accountId !== accountId) { next.push(f); continue; }
      if (gone === null || (f.folder !== null && gone.has(f.folder))) { touched = true; continue; }
      const to = f.folder !== null ? moved.get(f.folder) : undefined;
      const kept = to === undefined || to === f.folder ? f : { ...f, folder: to };
      if (change.listed && kept.folder !== null && !change.listed.has(kept.folder)) { touched = true; continue; }
      if (kept !== f) touched = true;
      // once each, whichever way it got there: a stale favorite left under the new key (its folder went in another app
      // before the list was read again) is the moved one's twin (Codex code review round 16 #2: kept beside it)
      if (next.some((n) => sameFavorite(n, kept))) { touched = true; continue; }
      next.push(kept);
    }
    return touched ? { value: { ...s, favoriteFolders: next }, result: next } : { value: s, result: null };
  });
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

/**
 * Theme ids saved under their Única names read as their successors; a stored
 * id that no longer resolves (or is of the other mode) falls back to "Style
 * colors"; a remembered previous palette that no longer resolves is forgotten.
 * A style's kept palettes read like the slots, and a style that's gone goes.
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
    designPalettes: Object.fromEntries(
      DESIGN_IDS.flatMap((d) => {
        const kept = g.designPalettes[d];
        return kept ? [[d, { light: pick(kept.light, "light"), dark: pick(kept.dark, "dark") }]] : [];
      }),
    ),
  };
}

/** The named providers' keys, for rows that offer another provider than the current one. */
async function keySummary(store: SettingsStore): Promise<AiSettings["keys"]> {
  const hints = await store.settings.get<Record<string, string>>(KEY_HINTS, {});
  const out: AiSettings["keys"] = {};
  for (const provider of ["anthropic", "openai", "jev"] as const) {
    const secret = keySecretName(provider);
    out[provider] = { hasKey: await store.secrets.has(secret), keyHint: hints[secret] ?? null };
  }
  return out;
}

/**
 * Plan 134: the switch now sends all new mail nothing else placed, with samples from the user's categories, where it
 * used to send only what the engine was unsure of. Whoever turned it on agreed to the narrower thing: off, once, with a
 * line in Settings → Categories. At boot, before any sync, since no mail may go in between.
 */
export async function stampSmartCategorize(store: SettingsStore): Promise<void> {
  const raw = await store.settings.get<StoredSettings>("app", {});
  if (raw.smartCategorizeVersion === 1) return;
  // an empty row is how a new install is told from an old one (migrateAppearance), and it has no switch to reset:
  // turning the switch on later stamps it (patchedSettings)
  if (Object.keys(raw).length === 0) return;
  await store.settings.update<StoredSettings, void>("app", {}, (latest) => {
    // the user may have turned it on since the read above: that's the new switch, and stays
    if (latest.smartCategorizeVersion === 1) return { value: latest, result: undefined };
    // only the stamp: read-time migrations stay unwritten until a write of the user's
    const wasOn = migrate(latest).aiCategorize === true;
    return { value: { ...latest, smartCategorizeVersion: 1, ...(wasOn ? { aiCategorize: false, aiCategorizeWidened: true } : {}) }, result: undefined };
  });
}

/** One read, for ingest's question on a live slice. */
export async function readSmartCategorize(store: SettingsStore): Promise<boolean> {
  const s = await stored(store);
  return s.aiCategorize === true && (s.autoCategorize ?? DEFAULT_SETTINGS.autoCategorize) !== "off";
}

/** Plan 146: a local build's keys, by store, since all that reads settings has one and none of it may miss them. */
const devAiByStore = new WeakMap<SettingsStore, DevAiKeys>();

export function provideDevAi(store: SettingsStore, keys: DevAiKeys): void {
  devAiByStore.set(store, keys);
}

/** The environment's keys while Dev mode's switch is on; null for everyone else, whatever is stored. */
export async function activeDevAi(store: SettingsStore): Promise<DevAiKeys | null> {
  const keys = devAiByStore.get(store);
  return keys && (await stored(store)).devAi === true ? keys : null;
}

/** Plan 146 §1: Pro's routing on the environment's keys, over the saved settings, which it leaves as they are. */
function withDevAi(ai: AiSettings, keys: DevAiKeys): AiSettings {
  const provider = keys.anthropic ? "anthropic" : keys.openai ? "openai" : "none";
  const profiles = { ...ai.profiles };
  // no saved endpoint: these keys go only to their provider
  for (const id of DEV_AI_PROVIDERS) if (profiles[id]) profiles[id] = { model: profiles[id].model };
  profiles.anthropic = { model: profiles.anthropic?.model || DEFAULT_ANTHROPIC_MODEL };
  profiles.openai = { model: profiles.openai?.model || SUMMARY_DEFAULT_MODEL };
  // a row may choose among what the environment holds; a choice from before can't send mail elsewhere
  const tasks = Object.fromEntries(Object.entries(ai.tasks).filter(([, target]) => target && isDevAiProvider(target.provider) && keys[target.provider]));
  const summary = (id: (typeof DEV_AI_PROVIDERS)[number]) => ({ hasKey: Boolean(keys[id]), keyHint: null });
  return {
    ...ai,
    fromEnv: true,
    provider,
    model: provider === "none" ? "" : profiles[provider]!.model,
    baseURL: null,
    preset: null,
    hasKey: provider !== "none",
    keyUnreadable: false,
    keyHint: null,
    keyOrigin: null,
    keyConfirmed: true,
    local: false,
    capabilities: null,
    profiles,
    tasks,
    keys: { anthropic: summary("anthropic"), openai: summary("openai"), jev: summary("jev") },
  };
}

/** What every gate reads, with Dev mode's overlay when it's on. */
export async function readSettings(store: SettingsStore): Promise<AppSettings> {
  const settings = await readStoredSettings(store);
  const keys = devAiByStore.get(store);
  if (!keys) return { ...settings, devAi: false };
  return settings.devAi ? { ...settings, ai: withDevAi(settings.ai, keys) } : settings;
}

/** The user's own settings, for what writes them down or works out what they were: an export never records the overlay. */
export async function readStoredSettings(store: SettingsStore): Promise<AppSettings> {
  const s = await stored(store);
  const { aiProvider: _p, aiModel: _m, ai: _ai, appearanceVersion: _v, remoteImagesVersion: _r, errorReportsVersion: _e, localMailVersion: _l, smartCategorizeVersion: _c, gmailClientId: _g, ...general } = s;
  const { provider, profiles, capabilities } = aiState(s, s.aiProvider === undefined && !s.ai?.provider && (await store.secrets.has(keySecretName("anthropic"))));
  const profile = profiles[provider] ?? { model: "" };
  const secret = keySecretName(provider, profile.preset);
  const [origins, unreadable, hasKey, hints] = await Promise.all([keyOrigins(store), unreadableSecrets(store), store.secrets.has(secret), store.settings.get<Record<string, string>>(KEY_HINTS, {})]);
  const bound = origins[secret] ?? null;
  const ai: AiSettings = {
    provider,
    model: profile.model,
    baseURL: profile.baseURL ?? null,
    preset: profile.preset ?? null,
    hasKey,
    keyUnreadable: unreadable.has(secret),
    keyHint: hints[secret] ?? null,
    keyOrigin: bound,
    // unbound: saved before origins were recorded and its endpoint never changed since (pinKeyOrigins)
    keyConfirmed: bound === null || bound === endpointOrigin(provider, profile),
    local: isLocalProvider({ id: provider, baseURL: profile.baseURL, preset: profile.preset }),
    capabilities: capabilities[capabilityKey(provider, profile)] ?? null,
    profiles,
    tasks: s.ai?.tasks ?? {},
    keys: await keySummary(store),
    monthlyLimitUsd: s.ai?.monthlyLimitUsd ?? DEFAULT_MONTHLY_LIMIT_USD,
  };
  return { ...resolveThemes({ ...DEFAULT_SETTINGS, ...general, language: languageOf(s) }), ai };
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
export async function updateSettings(store: SettingsStore, patch: SettingsPatch, now: number = Date.now()): Promise<AppSettings> {
  if (patch.ai) await pinKeyOrigins(store);
  const hasLegacyKey = await store.secrets.has(keySecretName("anthropic"));
  await store.settings.update<StoredSettings, void>("app", {}, (s) => ({ value: patchedSettings(migrate(s), patch, hasLegacyKey, now), result: undefined }));
  return readSettings(store);
}

/** Plan 132: a provider the user was told a hand summary goes to. */
export async function acknowledgeSummaryProvider(store: SettingsStore, provider: AiProviderId): Promise<void> {
  await store.settings.update<StoredSettings, void>("app", {}, (raw) => {
    const s = migrate(raw);
    const current = s.summaries ?? DEFAULT_SETTINGS.summaries;
    return { value: current.acknowledged.includes(provider) ? s : { ...s, summaries: { ...current, acknowledged: [...current.acknowledged, provider] } }, result: undefined };
  });
}

/** Plan 141 revision 2: consent is for a destination (`destinationOf`), and `compatible` covers many servers. */
export async function acknowledgeAsk(store: SettingsStore, destination: string): Promise<void> {
  await store.settings.update<StoredSettings, void>("app", {}, (raw) => {
    const s = migrate(raw);
    const current = s.ask ?? DEFAULT_SETTINGS.ask;
    return { value: current.acknowledged.includes(destination) ? s : { ...s, ask: { ...current, acknowledged: [...current.acknowledged, destination] } }, result: undefined };
  });
}

/** Plan 143: a command's check sends senders and subjects: its own agreement, by destination. */
export async function acknowledgeActionCheck(store: SettingsStore, destination: string): Promise<void> {
  await store.settings.update<StoredSettings, void>("app", {}, (raw) => {
    const s = migrate(raw);
    const current = s.ask ?? DEFAULT_SETTINGS.ask;
    const had = current.checkAcknowledged ?? [];
    return { value: had.includes(destination) ? s : { ...s, ask: { ...current, checkAcknowledged: [...had, destination] } }, result: undefined };
  });
}

function patchedSettings(s: StoredSettings, patch: SettingsPatch, hasLegacyKey: boolean, now: number): StoredSettings {
  const { ai: aiPatch, summaries: summariesPatch, ask: askPatch, followups: followupsPatch, replies: repliesPatch, ...rest } = patch;
  const general: Partial<General> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (summariesPatch) {
    // the moment it went on: mail from before it is never sent (off and on again starts over)
    const was = s.summaries ?? DEFAULT_SETTINGS.summaries;
    const enabledAt = !summariesPatch.enabled ? null : was.enabled ? was.enabledAt : now;
    general.summaries = { ...was, enabled: summariesPatch.enabled, enabledAt };
  }
  if (followupsPatch) {
    const was = s.followups ?? DEFAULT_SETTINGS.followups;
    const enabled = followupsPatch.enabled ?? was.enabled;
    // the moment it went on: what was sent before it is read only with a yes
    general.followups = { ...was, ...followupsPatch, enabled, enabledAt: !enabled ? null : was.enabled ? was.enabledAt : now };
  }
  if (repliesPatch) general.replies = { enabled: repliesPatch.enabled };
  if (askPatch) general.ask = { ...(s.ask ?? DEFAULT_SETTINGS.ask), enabled: askPatch.enabled };
  const state = aiState(s, hasLegacyKey);
  let { provider } = state;
  const profiles = { ...state.profiles };
  if (aiPatch) {
    if (aiPatch.provider !== undefined) {
      provider = aiPatch.provider;
    }
    const current: AiProfile = { ...(profiles[provider] ?? { model: "" }) };
    if (aiPatch.model !== undefined) current.model = aiPatch.model;
    if (aiPatch.baseURL !== undefined) {
      if (aiPatch.baseURL) current.baseURL = aiPatch.baseURL;
      else delete current.baseURL;
    }
    if (aiPatch.preset !== undefined) {
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
  const { aiProvider: _p, aiModel: _m, ...kept } = s;
  const tasks = { ...s.ai?.tasks };
  for (const [task, target] of Object.entries(aiPatch?.tasks ?? {}) as [AiTaskName, AiTaskTarget | null | undefined][]) {
    if (target === null) delete tasks[task];
    else if (target) tasks[task] = target;
  }
  const monthlyLimitUsd = aiPatch?.monthlyLimitUsd ?? s.ai?.monthlyLimitUsd;
  return { ...kept, ...general, ...(patch.aiCategorize !== undefined ? { smartCategorizeVersion: 1 } : {}), ai: { ...s.ai, provider, profiles, tasks, ...(monthlyLimitUsd !== undefined ? { monthlyLimitUsd } : {}) } };
}

/** What was observed for a provider, endpoint and model (plan 131: a task's model isn't the configured one's). */
export async function capabilitiesFor(store: SettingsStore, target: { provider: AiProviderId; model: string; baseURL?: string; preset?: CompatiblePreset }): Promise<Capabilities | null> {
  const s = await stored(store);
  const { provider, ...profile } = target;
  return s.ai?.capabilities?.[capabilityKey(provider, profile)] ?? null;
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

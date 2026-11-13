import { aiFeaturesAvailable, type Account, type Category } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { L, getLocale, DEFAULT_LOCALE, t, type ParamsArg, type TextKey } from "@terno/i18n";
import type { FindEntry } from "~/lib/settings-find";
import type { SettingsTab } from "~/state/app";
import { settingsTabLabel } from "./tabs";

/** A catalog key t() renders with no parameters. */
type PlainKey = { [K in TextKey]: ParamsArg<K> extends [] ? K : never }[TextKey];

/** What decides whether a setting can exist here at all (not whether a switch above it is on: that's `under`). */
export interface FindContext {
  settings: AppSettings;
  desktop: boolean;
  devMode: boolean;
  /** system notifications (desktop, or a browser that has them) and the unread badge */
  notifications: boolean;
  badge: boolean;
  /** the Agents section works here (desktop) */
  agents: boolean;
  /** the app updates itself (About's update preferences) */
  updater: boolean;
}

export interface IndexEntry {
  id: string;
  tab: SettingsTab;
  /** the title of the group it sits in (none: the group has no title) */
  group?: PlainKey;
  /** a label that isn't in the catalog is a product's name ("Claude Code") */
  label: PlainKey | { text: string };
  /** left out when the row's hint takes a value (a provider, a number): the name and words still find it */
  hint?: PlainKey;
  /** related words, comma-separated, in the catalog so each language has its own */
  words?: PlainKey;
  /** shown only while this setting is on or chosen: a result for it opens that one when it isn't there */
  under?: string;
  /** one result per account or per category */
  scope?: "account" | "category";
  /** a page inside its section (AI → Drafting → Writing style) */
  page?: "style";
  /** whether it can exist here; with a scope, for that account */
  when?: (ctx: FindContext, account?: Account) => boolean;
}

const ai = (ctx: FindContext) => aiFeaturesAvailable(ctx.settings);
const ownAi = (ctx: FindContext) => !ctx.settings.ai.fromEnv;

/**
 * Plan 203: every setting Settings shows, in its order (sections as the sidebar has them, rows as each section draws
 * them). A row says which entry it is with `find` (parts.tsx); settings-search.test.ts keeps the two in step.
 */
export const SETTINGS_INDEX = [
  // General
  { id: "general.remoteImages", tab: "general", label: "settings.general.remoteImages", hint: "settings.general.remoteImages.hint", words: "settings.find.words.remoteImages" },
  { id: "general.language", tab: "general", label: "language.label", hint: "language.hint", words: "settings.find.words.language" },
  { id: "general.today", tab: "general", group: "today.title", label: "today.settings.show", when: ai },
  { id: "general.todayAt", tab: "general", group: "today.title", label: "today.settings.prepareAt", hint: "today.settings.prepareAtHint", when: ai },
  { id: "general.todayNotify", tab: "general", group: "today.title", label: "today.settings.notify", hint: "today.settings.notifyHint", when: ai },
  { id: "general.syncWindow", tab: "general", group: "settings.general.sync", label: "settings.general.syncWindow", hint: "settings.general.syncWindow.hint", words: "settings.find.words.syncWindow" },
  { id: "general.notify", tab: "general", group: "settings.general.notifications", label: "settings.general.notify", words: "settings.find.words.notify", when: (c) => c.notifications },
  { id: "general.notifyPreview", tab: "general", group: "settings.general.notifications", label: "settings.general.notifyPreview", hint: "settings.general.notifyPreview.hint", when: (c) => c.notifications },
  { id: "general.badge", tab: "general", group: "settings.general.notifications", label: "settings.general.badge", hint: "settings.general.badge.hint", words: "settings.find.words.badge", when: (c) => c.badge },
  { id: "general.suggestions", tab: "general", group: "settings.general.writing", label: "settings.general.suggestions", hint: "settings.general.suggestions.hint", words: "settings.find.words.suggestions" },
  { id: "general.undoSend", tab: "general", group: "settings.general.writing", label: "settings.general.undoSend", words: "settings.find.words.undoSend" },
  { id: "general.undoSendTime", tab: "general", group: "settings.general.writing", label: "settings.general.undoSendTime", hint: "settings.general.undoSendTime.hint" },
  { id: "general.sendSound", tab: "general", group: "settings.general.writing", label: "settings.general.sendSound", hint: "settings.general.sendSound.hint" },
  { id: "general.characterKeys", tab: "general", group: "settings.general.keyboard", label: "settings.general.characterKeys", hint: "settings.general.characterKeys.hint" },
  { id: "general.shortcuts", tab: "general", group: "settings.general.keyboard", label: "settings.general.shortcuts", hint: "settings.general.shortcuts.hint", words: "settings.find.words.shortcuts" },
  { id: "general.reports", tab: "general", group: "diag.settings.title", label: "diag.settings.reports", words: "settings.find.words.reports" },
  { id: "general.reportContents", tab: "general", group: "diag.settings.title", label: "diag.settings.contains", hint: "diag.settings.containsHint" },
  { id: "general.logs", tab: "general", group: "diag.settings.title", label: "diag.settings.logs", hint: "diag.settings.logsHint" },

  // Appearance
  { id: "appearance.layout", tab: "appearance", group: "settings.appearance.list", label: "settings.appearance.layout", hint: "settings.appearance.layout.hint" },
  { id: "appearance.density", tab: "appearance", group: "settings.appearance.list", label: "settings.appearance.density", hint: "settings.appearance.density.hint", words: "settings.find.words.density" },
  { id: "appearance.preview", tab: "appearance", group: "settings.appearance.list", label: "settings.appearance.preview", hint: "settings.appearance.preview.hint", under: "appearance.layout" },
  { id: "appearance.style", tab: "appearance", label: "settings.appearance.style", hint: "settings.appearance.style.hint", words: "settings.find.words.style" },
  { id: "appearance.mode", tab: "appearance", label: "settings.appearance.mode", hint: "settings.appearance.mode.hint", words: "settings.find.words.mode" },
  { id: "appearance.lightTheme", tab: "appearance", label: "settings.appearance.lightTheme", words: "settings.find.words.theme" },
  { id: "appearance.darkTheme", tab: "appearance", label: "settings.appearance.darkTheme", words: "settings.find.words.theme" },
  { id: "appearance.motion", tab: "appearance", group: "settings.appearance.motionMail", label: "settings.appearance.motion", hint: "settings.appearance.motion.hint", words: "settings.find.words.motion" },
  { id: "appearance.htmlMail", tab: "appearance", group: "settings.appearance.motionMail", label: "settings.appearance.htmlMail", hint: "settings.appearance.htmlMail.hint" },
  { id: "appearance.siteIcons", tab: "appearance", group: "settings.appearance.senderPictures", label: "settings.appearance.siteIcons", hint: "settings.appearance.siteIcons.hint", words: "settings.find.words.siteIcons" },
  { id: "appearance.googlePhotos", tab: "appearance", group: "settings.appearance.senderPictures", label: "settings.appearance.googlePhotos", words: "settings.find.words.siteIcons", scope: "account", when: (_c, a) => a?.kind === "gmail" },
  { id: "appearance.forgetIcons", tab: "appearance", group: "settings.appearance.senderPictures", label: "settings.appearance.forgetIcons" },
  { id: "appearance.customThemes", tab: "appearance", label: "settings.appearance.custom", hint: "settings.appearance.custom.footer", words: "settings.find.words.customThemes" },

  // Accounts
  { id: "accounts.owner", tab: "accounts", label: "account.owner.title", hint: "account.owner.footer", words: "settings.find.words.owner" },
  { id: "accounts.add", tab: "accounts", group: "account.list", label: "account.add", words: "settings.find.words.addAccount" },
  { id: "account.name", tab: "accounts", label: "account.name", hint: "account.name.hint", scope: "account" },
  { id: "account.sender", tab: "accounts", label: "account.sender", hint: "account.sender.hint", scope: "account" },
  { id: "account.color", tab: "accounts", label: "settings.color", scope: "account" },
  { id: "account.signature", tab: "accounts", label: "account.signature", hint: "account.signature.hint", scope: "account" },
  { id: "account.instructions", tab: "accounts", label: "aiDraft.account.instructions", hint: "aiDraft.account.instructionsHint", words: "settings.find.words.instructions", scope: "account" },
  { id: "account.replies", tab: "accounts", label: "replies.account", hint: "replies.accountHint", scope: "account" },
  { id: "account.useGeneral", tab: "accounts", label: "aiDraft.account.useGeneral", hint: "aiDraft.account.useGeneralHint", scope: "account" },
  { id: "account.syncWindow", tab: "accounts", label: "settings.general.syncWindow", words: "settings.find.words.syncWindow", scope: "account" },
  { id: "account.separateTabs", tab: "accounts", label: "account.separateTabs", hint: "account.separateTabs.hint", words: "settings.find.words.separateTabs", scope: "account", when: (_c, a) => a?.kind === "gmail" },
  { id: "account.followups", tab: "accounts", label: "account.followups", hint: "account.followups.hint", scope: "account" },
  { id: "account.connection", tab: "accounts", label: "account.connection", words: "settings.find.words.connection", scope: "account" },
  { id: "account.sentCopies", tab: "accounts", label: "account.sentCopies", hint: "account.sentCopies.hint", scope: "account", when: (_c, a) => a?.kind === "imap" },
  { id: "account.recipientReceipts", tab: "accounts", label: "account.recipientReceipts", hint: "account.recipientReceipts.hint", scope: "account", when: (_c, a) => a?.kind === "imap" },
  { id: "account.remove", tab: "accounts", label: "account.remove", hint: "account.remove.hint", words: "settings.find.words.remove", scope: "account" },

  // Categories
  { id: "categories.smart", tab: "categories", label: "settings.categories.smart", hint: "settings.categories.smart.hint", words: "settings.find.words.smart" },
  { id: "categories.askAi", tab: "categories", label: "settings.categories.askAi" },
  { id: "categories.jev", tab: "categories", label: "settings.categories.jev", hint: "settings.categories.jev.hint", when: ownAi },
  { id: "categories.new", tab: "categories", label: "settings.categories.new" },
  { id: "category.autoAdd", tab: "categories", label: "settings.categories.autoAdd", words: "settings.find.words.smart", scope: "category" },
  { id: "category.name", tab: "categories", label: "account.name", words: "settings.find.words.rename", scope: "category" },
  { id: "category.showInInbox", tab: "categories", label: "settings.categories.showInInbox", hint: "settings.categories.showInInbox.hint", scope: "category" },
  { id: "category.order", tab: "categories", label: "settings.categories.order", words: "settings.find.words.order", scope: "category" },
  { id: "category.color", tab: "categories", label: "settings.color", scope: "category" },
  { id: "category.delete", tab: "categories", label: "settings.categories.delete", hint: "settings.categories.delete.hint", scope: "category" },

  // Rules, Snippets
  { id: "filters.yours", tab: "filters", label: "filters.group.yours", hint: "filters.footer", words: "settings.find.words.filters" },
  { id: "snippets.list", tab: "snippets", label: "settings.tab.snippets", words: "settings.find.words.snippets" },

  // AI
  { id: "ai.devNote", tab: "ai", label: "settings.dev.aiNote", hint: "settings.dev.aiNote.hint", when: (c) => c.settings.ai.fromEnv === true },
  { id: "ai.provider", tab: "ai", label: "ai.provider", hint: "ai.provider.hint", words: "settings.find.words.provider", when: ownAi },
  { id: "ai.service", tab: "ai", label: "ai.service", under: "ai.provider", when: ownAi },
  { id: "ai.endpoint", tab: "ai", label: "ai.endpoint", words: "settings.find.words.endpoint", under: "ai.provider", when: ownAi },
  { id: "ai.key", tab: "ai", label: "settings.find.apiKey", hint: "ai.key.hint", words: "settings.find.words.key", under: "ai.provider", when: ownAi },
  { id: "ai.model", tab: "ai", label: "ai.model", under: "ai.provider", when: ownAi },
  { id: "ai.test", tab: "ai", label: "ai.test", under: "ai.provider", when: ownAi },
  { id: "ai.drafting", tab: "ai", group: "aiDraft.settings.title", label: "aiDraft.settings.enabled", words: "settings.find.words.drafting" },
  { id: "ai.instructions", tab: "ai", group: "aiDraft.settings.title", label: "aiDraft.settings.instructions", hint: "aiDraft.settings.instructionsHint", words: "settings.find.words.instructions", under: "ai.drafting" },
  { id: "ai.sentMail", tab: "ai", group: "aiDraft.settings.title", label: "aiDraft.settings.sentMail", hint: "aiDraft.settings.sentMailHint", under: "ai.drafting" },
  { id: "ai.replies", tab: "ai", group: "aiDraft.settings.title", label: "replies.settings.switch", under: "ai.drafting" },
  { id: "ai.writingStyle", tab: "ai", group: "aiDraft.settings.title", label: "aiDraft.style.title", hint: "aiDraft.settings.styleHint", under: "ai.drafting" },
  { id: "ai.summaries", tab: "ai", group: "ai.summaries.title", label: "ai.summaries.switch", words: "settings.find.words.summaries" },
  { id: "ai.ask", tab: "ai", group: "ai.ask.title", label: "ai.ask.switch", words: "settings.find.words.ask" },
  { id: "ai.followups", tab: "ai", group: "followups.title", label: "ai.followups.switch", words: "settings.find.words.followups" },
  { id: "ai.nudge", tab: "ai", group: "followups.title", label: "ai.followups.nudge", hint: "ai.followups.nudgeHint", under: "ai.followups" },
  { id: "ai.digest", tab: "ai", group: "today.digest.settingsTitle", label: "today.digest.settingsSwitch", words: "settings.find.words.digest", when: ai },
  { id: "ai.digestExcluded", tab: "ai", group: "today.digest.settingsTitle", label: "today.digest.excluded.title", hint: "today.digest.excluded.hint", under: "ai.digest", when: ai },
  { id: "ai.usage", tab: "ai", label: "ai.usage.label", hint: "ai.usage.hint", words: "settings.find.words.usage" },
  { id: "ai.limit", tab: "ai", label: "ai.limit.label", hint: "ai.limit.hint", words: "settings.find.words.usage" },
  // Writing style, a page of Drafting's
  { id: "style.profiles", tab: "ai", page: "style", label: "aiDraft.style.yours", words: "settings.find.words.styleProfiles" },
  { id: "style.study", tab: "ai", page: "style", group: "aiDraft.study.title", label: "aiDraft.study.action", hint: "aiDraft.study.hint" },
  { id: "style.rebuild", tab: "ai", page: "style", group: "aiDraft.study.title", label: "aiDraft.style.rebuild", hint: "aiDraft.style.rebuildHint" },
  { id: "style.clear", tab: "ai", page: "style", group: "aiDraft.style.startOver", label: "aiDraft.style.clear", hint: "aiDraft.style.clearHint" },

  // Agents
  { id: "agents.enabled", tab: "agents", group: "settings.agents.access", label: "settings.agents.enabled", hint: "settings.agents.enabled.hint", words: "settings.find.words.agents", when: (c) => c.agents },
  { id: "agents.level", tab: "agents", group: "settings.agents.access", label: "settings.agents.level", under: "agents.enabled", when: (c) => c.agents },
  { id: "agents.token", tab: "agents", group: "settings.agents.access", label: "settings.agents.token", under: "agents.enabled", when: (c) => c.agents },
  { id: "agents.claude", tab: "agents", group: "common.connect", label: { text: "Claude Code" }, when: (c) => c.agents },
  { id: "agents.codex", tab: "agents", group: "common.connect", label: { text: "Codex" }, when: (c) => c.agents },
  { id: "agents.other", tab: "agents", group: "common.connect", label: "settings.agents.other", hint: "settings.agents.other.hint", when: (c) => c.agents },
  { id: "agents.skill", tab: "agents", group: "common.connect", label: "settings.agents.skill", when: (c) => c.agents && c.desktop },

  // Data, Storage
  { id: "data.export", tab: "data", group: "settings.data.backup", label: "settings.data.export", hint: "settings.data.export.hint", words: "settings.find.words.backup" },
  { id: "data.import", tab: "data", group: "settings.data.backup", label: "settings.data.import", hint: "settings.data.import.hint", words: "settings.find.words.backup" },
  { id: "storage.byMailbox", tab: "storage", label: "storage.byMailbox", hint: "storage.byMailbox.footer", words: "settings.find.words.storage" },
  { id: "storage.olderThan", tab: "storage", group: "storage.free", label: "storage.olderThan", words: "settings.find.words.storage" },
  { id: "storage.clearAi", tab: "storage", label: "storage.clearAi" },

  // Dev mode, About
  { id: "dev.proAi", tab: "dev", label: "settings.dev.proAi", hint: "settings.dev.proAi.hint", when: (c) => c.devMode },
  { id: "dev.env", tab: "dev", label: "settings.dev.env", when: (c) => c.devMode },
  { id: "about.version", tab: "about", label: "settings.find.version", words: "settings.find.words.version" },
  { id: "about.autoUpdate", tab: "about", group: "updates.settings.title", label: "updates.settings.auto", words: "settings.find.words.version", when: (c) => c.updater },
  { id: "about.channel", tab: "about", group: "updates.settings.title", label: "updates.settings.channel", words: "settings.find.words.channel", when: (c) => c.updater },
] as const satisfies readonly IndexEntry[];

export type SettingId = (typeof SETTINGS_INDEX)[number]["id"];

const BY_ID = new Map<string, IndexEntry>(SETTINGS_INDEX.map((e) => [e.id, e]));

export function indexEntry(id: SettingId): IndexEntry {
  return BY_ID.get(id)!;
}

const text = (label: IndexEntry["label"]) => (typeof label === "string" ? t(label) : label.text);

/** A row's label when it names none of its own: its entry's. */
export function settingLabel(id: SettingId): string {
  return text(indexEntry(id).label);
}

/** A row's hint when it gives none of its own: its entry's, if it has one. */
export function settingHint(id: SettingId): string | undefined {
  const hint = indexEntry(id).hint;
  return hint ? t(hint) : undefined;
}

/** A catalog's comma-separated words, each trimmed. */
export const splitWords = (words: string) => words.split(",").map((w) => w.trim()).filter(Boolean);

/** The English name and words, searched too when Settings is in another language (the palette's rule). */
export function englishOf(entry: IndexEntry): string[] {
  if (getLocale() === DEFAULT_LOCALE) return [];
  const name = typeof entry.label === "string" ? L(entry.label).message : entry.label.text;
  return [name, ...(entry.words ? splitWords(L(entry.words).message) : [])];
}

/** Where a result goes: the section, the page in it, the account or category whose disclosure holds it. */
export interface FindTarget {
  id: SettingId;
  tab: SettingsTab;
  page: "style" | null;
  scope: { kind: "account" | "category"; id: number } | null;
  /** the row that shows it, when it isn't shown */
  under: SettingId | null;
}

/** The placement's weights: a section or group's title, and an account's or category's own name (plan 203). */
const PLACE = 2;
const ITEM = 3;

/**
 * The searchable settings in the current language, for what exists here now: one per entry, a scoped one once per
 * account or category. Built on every query (a few hundred compiled lookups), so nothing goes stale.
 */
export function findEntries(ctx: FindContext, accounts: readonly Account[], categories: readonly Category[]): FindEntry<FindTarget>[] {
  const out: FindEntry<FindTarget>[] = [];
  for (const raw of SETTINGS_INDEX) {
    const e: IndexEntry = raw;
    const section = { text: settingsTabLabel(e.tab), weight: PLACE };
    const page = e.page === "style" ? [{ text: t("aiDraft.settings.title"), weight: PLACE }, { text: t("aiDraft.style.title"), weight: PLACE }] : [];
    // a group named as its section ("Categories" in Categories) says nothing more
    const group = e.group && t(e.group) !== section.text ? [{ text: t(e.group), weight: PLACE }] : [];
    const words = [...(e.words ? splitWords(t(e.words)) : []), ...englishOf(e)];
    const base = { name: text(e.label), words, hint: e.hint ? t(e.hint) : null };
    const target = { id: e.id as SettingId, tab: e.tab, page: e.page ?? null, under: (e.under ?? null) as SettingId | null };
    if (e.scope === "account") {
      for (const a of accounts) {
        if (e.when && !e.when(ctx, a)) continue;
        out.push({ key: `${e.id}:${a.id}`, ...base, place: [section, ...group, { text: a.displayName, weight: ITEM }], data: { ...target, scope: { kind: "account", id: a.id } } });
      }
    } else if (e.scope === "category") {
      for (const c of categories) {
        if (e.when && !e.when(ctx)) continue;
        out.push({ key: `${e.id}:${c.id}`, ...base, place: [section, ...group, { text: c.name, weight: ITEM }], data: { ...target, scope: { kind: "category", id: c.id } } });
      }
    } else if (!e.when || e.when(ctx)) {
      out.push({ key: e.id, ...base, place: [section, ...page, ...group], data: { ...target, scope: null } });
    }
  }
  return out;
}

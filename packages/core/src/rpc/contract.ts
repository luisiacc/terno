import type { AttachmentRef } from "../attachments";
import type { MailNotice } from "../attention";
import { LANGUAGE_SETTINGS, LOCALE_IDS, t, type LanguageSetting } from "@terno/i18n";
import { z } from "zod";
import { isValidEmail, MAX_RECIPIENTS } from "../address";
import { TABS } from "../tabs";
import { FORWARD_ADDRESSES_MAX_CHARS } from "../forwarding";
import {
  AI_PROVIDER_IDS,
  AI_TASK_NAMES,
  COMPATIBLE_PRESETS,
  type AiErrorKind,
  type AiSummarizeResult,
  type AiSummariesStatus,
  type AiSummaryRead,
  type AiProviderId,
  type AiTaskName,
  type AiTaskTarget,
  type Capabilities,
  type CompatiblePreset,
  type ModelInfo,
  type PresetDescriptor,
  type ProviderDescriptor,
  type DevAiProvider,
} from "../ai";
import type { FollowupRow, FollowupsSetting, FollowupsSnapshot } from "../followups";
import type { DigestRow, NotNewsletter, TodayList, TodaySetting } from "../today";
import type { AiPrepareReply, AiReplyEvent, PreparedReply, RepliesSetting } from "../replies";
import type { ActionPreviewInfo, ActionRowTag, AiActionApplied, AiActionCheck, AiActionEvent, AiActionStart } from "../actions";
import { ASK_QUESTION_MAX, ASK_SOURCES_MAX, type AiAskEvent, type AiAskResult, type AskConversationSummary, type AskOlderOffer, type AskSourceView, type AskTurn } from "../ask";
import { BODY_READ_MAX } from "../writing/body";
import { FILL_GAPS_MAX, GENERATION_TEXT_MAX, WRITING_INSTRUCTIONS_MAX, WRITING_ONE_OFF_MAX, type AiComposeDelta, type AiFillDelta, type AiComposeResult, type AiIntentResult, type AiStudyProgress, type WritingPrefs, type WritingProfileView, type WritingStatus, type WritingStudyResult } from "../writing/contract";
import type { AlwaysScope, CategoryModelStats, Prediction, QuickActions } from "../categorize/bulk";
import type { I18nRef } from "./envelope";
import type { AutoCategorize } from "../categorize/policy";
import type { LearnedProposal } from "../learning/propose";
import { SIMILAR_ACTIONS, type SimilarOffers } from "../similar";
import { UNSUBSCRIBE_METHODS } from "../unsubscribe";
import { REMOVABLE_BUCKETS, STORAGE_AGES, type StorageReport } from "../storage";
import { filterRuleSchema, type Filter, type FilterRule } from "../rules/schema";
import { LIST_FILTERS, type ListFilter } from "../list-filter";
import { snippetFieldsSchema, snippetIdSchema, type Snippet } from "../snippets";
import { customThemesSchema, DESIGN_IDS, type CustomTheme, type DesignId, type DesignPalettes, type MotionMs } from "../themes";
import {
  CATEGORY_COLORS,
  FOLDER_NAME_MAX,
  FOLDER_VIEWS,
  REMINDER_KINDS,
  REMINDERS_MAX,
  VIEWS,
  type Account,
  type Reminder,
  type Category,
  type Folder,
  type FavoriteFolder,
  type FavoriteFoldersSnapshot,
  type FolderRename,
  type Counts,
  type OpState,
  type ThreadDetail,
  type ThreadSummary,
} from "../types";

const id = z.number().int().positive();
/** days of mail an account downloads (settings, an account, connecting one) */
const syncWindow = z.number().int().min(7).max(3650);
const ids = z.array(id).min(1).max(5000);
const cursor = z.object({ lastDate: z.number(), id: z.number().int() });
/** a search cursor also names the query and the store revision it was minted at (older renderers send only the keyset) */
const searchCursor = cursor.extend({
  revision: z.object({ epoch: z.string().max(100), seq: z.number().int().min(0) }).optional(),
  queryKey: z.string().max(5000).optional(),
});
// core's own check (plan 34): zod's email() refuses RFC-valid local parts (a/b, a=b) and Unicode domains, which the builders send as punycode
const address = z.object({ name: z.string().max(300), email: z.string().max(320).refine(isValidEmail, "Invalid email address") });
/** a draft keeps recipients as typed, unfinished ones too ("bob@"); addresses are validated when it is sent */
export const attachmentRefSchema = z.object({
  assetId: z.string().uuid(), filename: z.string().min(1).max(180), mime: z.string().max(120), size: z.number().int().min(0).max(18 * 1024 * 1024), contentId: z.string().max(300).nullable().optional(),
}).strict();
const attachmentRefs = z.array(attachmentRefSchema).max(100);
const assetRequest = z.object({ accountId: id, assetId: z.string().uuid() }).strict();
const draftAddress = z.object({ name: z.string().max(300), email: z.string().max(320), auto: z.literal(true).optional() });

export interface ThreadPage {
  items: ThreadSummary[];
  nextCursor: { lastDate: number; id: number } | null;
}

export interface SearchPage extends ThreadPage {
  nextCursor: { lastDate: number; id: number; revision: { epoch: string; seq: number }; queryKey: string } | null;
  strategy: string;
  tookMs: number;
  /** false while some accounts still have bodies pending indexing */
  complete: boolean;
}

/** Per-provider choices, kept when switching providers back and forth. */
export interface AiProfile {
  model: string;
  baseURL?: string;
  preset?: CompatiblePreset;
}

export interface AiSettings {
  /** plan 146: this comes from a local build's environment, not from what's saved: a saved key or provider changes nothing */
  fromEnv?: boolean;
  provider: AiProviderId;
  model: string;
  baseURL: string | null;
  preset: CompatiblePreset | null;
  /** keys never cross to the renderer: only whether one is saved and its last 4 characters */
  hasKey: boolean;
  /** plan 145: this provider can't run without a key */
  needsKey?: boolean;
  /** the saved key was sealed by Única and couldn't be moved to Terno's keychain: it has to be saved again */
  keyUnreadable: boolean;
  keyHint: string | null;
  /** the endpoint origin the saved key belongs to; it is only sent there */
  keyOrigin: string | null;
  /** the key may be used with the current endpoint (false: the endpoint changed since; confirm it or save a new key) */
  keyConfirmed: boolean;
  /** the model runs on this Mac */
  local: boolean;
  capabilities: Capabilities | null;
  profiles: Partial<Record<AiProviderId, AiProfile>>;
  /** plan 131: what a task runs on when the user chose; absent: its default */
  tasks: Partial<Record<AiTaskName, AiTaskTarget>>;
  /** whether a provider other than the current one has a key, for the task rows */
  keys: Partial<Record<AiProviderId, { hasKey: boolean; keyHint: string | null }>>;
  /** a ceiling on what background AI may spend in a calendar month, in US dollars; 0: none */
  monthlyLimitUsd: number;
}

/**
 * Plan 141: Ask your mail. On by default, since nothing runs until someone asks. An older profile may still hold
 * `acknowledged` and `checkAcknowledged` (the per-use consent plan 131 removed): left in place, read by nothing.
 */
export interface AskSetting {
  enabled: boolean;
}

export interface AiSummariesSetting {
  enabled: boolean;
  enabledAt: number | null;
}

/** What AI use has cost so far on the user's own keys (plan 131). */
export interface AiUsageReport {
  today: { requests: number; usd: number };
  month: { requests: number; usd: number };
  monthBackgroundUsd: number;
  /** plan 141: questions this month, a person's own requests: counted, and outside the ceilings */
  monthAsk: { requests: number; usd: number };
  /** some of the month's figure is an estimate, counted high: a price nobody told us, or usage a provider didn't report */
  estimated: boolean;
}

export interface AppSettings {
  /** plan 146: Dev mode's Pro AI switch; always false outside a local build */
  devAi: boolean;
  /** nothing leaves this Mac except mail with the user's own servers (and loopback AI) */
  localMode: boolean;
  /** the MODE (name kept from v1): follow the OS, or always light / dark */
  theme: "system" | "light" | "dark";
  /** plan 15: the design (Style): typography, shape, density and component variants */
  design: DesignId;
  /** the palette used in light mode: "design" (the design's own, the default), a built-in id or `custom:<id>` */
  lightTheme: string;
  darkTheme: string;
  /** the palette chosen before designs, offered first under Colors (plan 15); null when there was none */
  previousLightTheme: string | null;
  previousDarkTheme: string | null;
  /** plan 138: what each style was left with, taken back on returning to it (switchDesign) */
  designPalettes: DesignPalettes;
  /** every animation's base duration; 0 turns animation off */
  motionMs: MotionMs;
  /** auto: uncolored mail takes the theme's colors, designed mail sits on a light paper card; paper: always the card */
  htmlMailAppearance: "auto" | "paper";
  customThemes: CustomTheme[];
  density: "comfortable" | "compact";
  /** plan 24: the conversation beside the list (split), or the list full width with the conversation opening in its place (list) */
  layout: "split" | "list";
  remoteImages: "ask" | "always";
  ai: AiSettings;
  allowAgentSend: boolean;
  syncWindowDays: number;
  /** what the categorization engine may do with new mail */
  autoCategorize: AutoCategorize;
  /** plan 134: let the AI place new mail the filters and the engine can't (it suggests; a calibrated model may file) */
  aiCategorize: boolean;
  /** plan 134: the switch was on when it came to send more mail, and went off once: Settings → Categories says so, once */
  aiCategorizeWidened: boolean;
  /** plan 132: summarize new mail as it arrives (off unless the user turns it on: it sends mail with no click); mail from before `enabledAt` never */
  summaries: AiSummariesSetting;
  ask: AskSetting;
  /** plan 142 */
  followups: FollowupsSetting;
  /** plan 144: off by default; the switch is the consent */
  replies: RepliesSetting;
  /** plan 145 */
  today: TodaySetting;
  /** anonymous error reports (builds with a DSN, outside local mode): ask each time, send, or never */
  errorReports: "ask" | "always" | "never";
  /** the UI language: follow the system, or a locale Terno ships (@terno/i18n LOCALES) */
  language: LanguageSetting;
  /** plan 18: ghost text while writing, learned from the user's sent mail on this device (recipients are always suggested) */
  composeSuggestions: boolean;
  /** plan 158: Send holds a message for a few seconds in the backend's own queue, with Undo */
  undoSend: boolean;
  /**
   * Plan 22: website icons for senders, loaded from each sender's own site. Unset it follows the
   * mode (on in connected mode, off in local mode); the user's choice sticks.
   */
  senderIcons: boolean;
  /** plan 22: Gmail accounts showing photos from Google, by account id (set through icons.googlePhotos, never settings.update) */
  googlePhotos: Record<string, GooglePhotoState>;
  /** plan 74: Gmail accounts whose photos are switched on but wait for the account's next sign-in with Google (Google asks then) */
  googlePhotosPending: number[];
  /** plan 41: the Inbox's unread count on the Dock icon (the web: the installed app's icon) */
  dockBadge: boolean;
  /** plan 41: system notifications for important new mail while Terno runs */
  notifications: boolean;
  /** plan 41: notifications name the sender and the subject (off: only how many) */
  notificationPreview: boolean;
  /** plan 107: folders below Starred, in the order added (set through folders.favorite, never settings.update) */
  favoriteFolders: FavoriteFolder[];
}

/** Plan 22: what Google granted an account for photos (each contacts scope on its own), and whether its project's People API is off. */
export interface GooglePhotoState {
  connections: boolean;
  otherContacts: boolean;
  apiDisabled: boolean;
}

/** Plan 22: an icon the backend has for an address: `id` names its bytes (icons.data), `v` changes when they do. */
export interface IconRef {
  id: string;
  v: number;
  kind: "site" | "photo";
  /** the smaller side in px (SVG: 512) */
  px: number;
  /** drawn edge to edge (photos, touch icons); otherwise centered on a tile */
  full: boolean;
}

/** An address's icon, none (initials), or "again": dropped from a full queue, ask again while it's still shown. */
export type IconAnswer = IconRef | null | "again";

/** The person this install belongs to (the future Terno account). Verification evidence stays in the backend. */
export interface OwnerIdentity {
  userId: string;
  email: string;
  displayName: string;
  provider: "gmail" | "imap";
  verifiedBy: "google_oauth" | "imap_login";
  verifiedAt: number | null;
  /** adopted from an existing install's first account, not verified by a fresh login */
  migrated: boolean;
  /** the connected mailbox it was verified with; null once that mailbox is removed */
  accountId: number | null;
  createdAt: number;
  updatedAt: number;
}

/** What the host running the backend can do (the renderer gates features on it). */
export interface HostCapabilities {
  /** IMAP/SMTP accounts (raw TCP sockets) */
  imap: boolean;
  /** the MCP server for Claude Code / Codex (a local socket) */
  agents: boolean;
  /** sync keeps running with the window closed */
  backgroundSync: boolean;
  /** how local mode is enforced: "pinned" = names resolved and pinned, the renderer fenced by main; "browser" = only literal loopback hosts, no pinning, nothing outside Terno's own requests */
  network: "pinned" | "browser";
  /** plan 22: website icons can be fetched (desktop; a browser can't read other sites' icons) */
  siteIcons?: boolean;
}

export interface HostInfo {
  kind: "desktop" | "web";
  capabilities: HostCapabilities;
  /** the storage adapter ("sqlite-node-sqlite", "sqlite-wasm-opfs", "indexeddb", …) */
  storage?: string;
}

export interface Bootstrap {
  host: HostInfo;
  accounts: Account[];
  categories: Category[];
  /** plan 68: every account's own folders */
  folders: Folder[];
  counts: Counts;
  settings: AppSettings;
  owner: OwnerIdentity | null;
  /** demo builds have no owner (and say so) */
  demo: boolean;
  /** plan 146: which of Dev mode's variables are set; null, and no section, outside a local build. Never a value. */
  devAi?: Record<DevAiProvider, boolean> | null;
  /** plan 17: the quick filters this backend knows (absent from an older one: plan 15's unread, attachments, starred) */
  filters?: ListFilter[];
  version: string;
}

/** What a browser mailbox can't afford to lose to storage eviction (re-syncable mail excluded), never a secret. */
/** A draft in an export (format 2): all of it; what it answers or forwards by Message-ID, which survives a re-sync. */
export interface ExportedAttachment {
  filename: string;
  mime: string;
  size: number;
  contentId?: string | null;
  chunks: string[];
}

export interface ExportedDraft {
  accountEmail: string | null;
  mode: DraftMode;
  to: DraftAddress[];
  cc: DraftAddress[];
  bcc: DraftAddress[];
  subject: string;
  subjectEdited: boolean;
  bodyText: string;
  /** plan 16: the written part as mail HTML ('' for a plain draft); bodyText is always its plain-text alternative */
  bodyHtml?: string;
  attachments?: ExportedAttachment[];
  quotedText: string;
  includeQuote: boolean;
  replyContext?: { subject: string; sourceAccountEmail: string | null; rfcMessageId: string | null } | null;
  inReplyTo: string | null;
  forwardOf: string | null;
  uiState: "open" | "collapsed";
  updatedAt: number;
}

export interface MailboxExport {
  format: "terno-export";
  /** 2: drafts carry their whole shape (1 had only recipients, subject and text) */
  version: 2;
  exportedAt: number;
  app: string;
  /** ids let an import map filters' account conditions to the same mailbox by address */
  accounts: { id?: number; email: string; kind: Account["kind"]; displayName: string }[];
  categories: Category[];
  filters: Filter[];
  settings: Omit<AppSettings, "devAi">;
  drafts: ExportedDraft[];
  /** plan 93 */
  snippets: Snippet[];
  /** provider operations not yet done (sends included, with their message) */
  ops: { accountEmail: string | null; kind: string; state: string; createdAt: number; lastError: string | null; target: unknown; payload: unknown }[];
}

/** What app.import brought in (and what it left out, by name, with the reason). */
export interface ImportResult {
  categories: { added: number; merged: number };
  filters: { added: number; existing: number; skipped: string[] };
  drafts: number;
  /** plan 93: snippets added (one whose id or name is already here is kept as it is) */
  snippets: number;
  /** drafts and filters of mailboxes not connected here yet: they go in when those are connected */
  pending: { drafts: number; filters: number };
  /** the settings were applied (local mode and agent sending only ever become stricter) */
  settings: boolean;
}

export const CATEGORIZE_SOURCES = ["picker", "dnd", "snackbar", "suggestion"] as const;
export type CategorizeSource = (typeof CATEGORIZE_SOURCES)[number];

export interface AddThreadsResult {
  added: number;
  /** threads that were not in the category before (undo removes exactly these) */
  addedIds: number[];
  /** undo handle (categorize.undo); null when nothing was added */
  batchId: number | null;
}

export interface OpInfo {
  sentCopy?: import("../send-copy").SentCopyState;
  partialRecipients?: boolean;
  recipientOutcomeUnknown?: boolean;
  id: string;
  accountId: number;
  kind: string;
  state: OpState;
  attempts: number;
  lastError: string | null;
  /** lastError as a catalog message (when it is one of Terno's): the renderer shows it in the user's language */
  lastErrorI18n?: I18nRef;
  createdAt: number;
  /** English (agents, logs); the renderer shows summaryI18n */
  summary: string;
  summaryI18n?: I18nRef;
  /** plan 25: queued until its account signs in again */
  awaitingAuth?: true;
}

export const DRAFT_MODES = ["new", "reply", "replyAll", "forward"] as const;
export type DraftMode = (typeof DRAFT_MODES)[number];
/** a recipient of a draft; `auto` = filled in by Terno (reply/reply-all/forward), not typed */
export type DraftAddress = z.infer<typeof address> & { auto?: true };

/**
 * A draft (format 2): what the user writes (bodyText) is kept apart from the
 * quoted original (quotedText), joined only when sent, so a restore never
 * quotes twice. Format-1 drafts (before v9) carry everything in bodyText.
 */
export interface ReplyContext { subject: string; sourceId: number; sourceAccountId: number; rfcMessageId?: string | null; contextId?: string }

export interface Draft {
  id: number;
  /** Immutable target fence; empty/omitted only for drafts created before schema 20. */
  generation?: string;
  revision: number;
  format: 1 | 2;
  accountId: number;
  /** the conversation it belongs to (null: a new message, or its conversation is gone) */
  threadId: number | null;
  mode: DraftMode;
  to: DraftAddress[];
  cc: DraftAddress[];
  bcc: DraftAddress[];
  subject: string;
  subjectEdited: boolean;
  bodyText: string;
  /** plan 16: the written part as mail HTML ('' for a plain draft); bodyText is always its plain-text alternative */
  bodyHtml: string;
  attachments?: AttachmentRef[];
  quotedText: string;
  includeQuote: boolean;
  replyContext?: ReplyContext | null;
  inReplyToMessageId: number | null;
  forwardOfMessageId: number | null;
  showSourceContext?: boolean;
  presentationThreadId?: number | null;
  uiState: "open" | "collapsed";
  updatedAt: number;
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  capabilities?: Capabilities;
  warning?: string;
  /** warning as a catalog message: the renderer shows it in the user's language */
  warningI18n?: I18nRef;
  /** message in English; i18n, when set, is what the renderer shows */
  error?: { kind: AiErrorKind; message: string; i18n?: I18nRef };
}

/** http(s) only; the network policy decides whether the host is reachable. */
const endpointUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");
const aiTaskTarget = z.object({ provider: z.enum(AI_PROVIDER_IDS), model: z.string().trim().min(1).max(200) }).strict();
const aiTarget = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  baseURL: endpointUrl.optional(),
  preset: z.enum(COMPATIBLE_PRESETS).optional(),
});

const settingsPatch = z.object({
  localMode: z.boolean().optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  design: z.enum(DESIGN_IDS).optional(),
  lightTheme: z.string().trim().min(1).max(60).optional(),
  darkTheme: z.string().trim().min(1).max(60).optional(),
  motionMs: z.union([z.literal(0), z.literal(50), z.literal(75), z.literal(100)]).optional(),
  previousLightTheme: z.string().trim().min(1).max(60).nullable().optional(),
  previousDarkTheme: z.string().trim().min(1).max(60).nullable().optional(),
  designPalettes: z.partialRecord(z.enum(DESIGN_IDS), z.object({ light: z.string().trim().min(1).max(60), dark: z.string().trim().min(1).max(60) }).strict()).optional(),
  htmlMailAppearance: z.enum(["auto", "paper"]).optional(),
  customThemes: customThemesSchema.optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  layout: z.enum(["split", "list"]).optional(),
  remoteImages: z.enum(["ask", "always"]).optional(),
  devAi: z.boolean().optional(),
  ai: z
    .object({
      // JEV only picks among choices: it can't be the provider that writes
      provider: z.enum(AI_PROVIDER_IDS).refine((p) => p !== "jev").optional(),
      model: z.string().trim().max(200).optional(),
      baseURL: endpointUrl.nullable().optional(),
      preset: z.enum(COMPATIBLE_PRESETS).nullable().optional(),
      /** null clears a task's choice, back to its default */
      tasks: z
        .object(Object.fromEntries(AI_TASK_NAMES.map((t) => [t, aiTaskTarget.nullable().optional()])) as Record<AiTaskName, z.ZodOptional<z.ZodNullable<typeof aiTaskTarget>>>)
        .strict()
        .optional(),
      monthlyLimitUsd: z.number().min(0).max(100_000).optional(),
    })
    .strict()
    .optional(),
  allowAgentSend: z.boolean().optional(),
  syncWindowDays: syncWindow.optional(),
  autoCategorize: z.enum(["off", "suggest", "auto"]).optional(),
  aiCategorize: z.boolean().optional(),
  aiCategorizeWidened: z.boolean().optional(),
  /** `enabledAt` is the backend's: the moment it went on */
  summaries: z.object({ enabled: z.boolean() }).strict().optional(),
  ask: z.object({ enabled: z.boolean() }).strict().optional(),
  /** `enabledAt` is the backend's */
  replies: z.object({ enabled: z.boolean() }).strict().optional(),
  today: z.object({ show: z.boolean().optional(), prepareAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), notify: z.boolean().optional(), digest: z.boolean().optional() }).strict().optional(),
  followups: z.object({ enabled: z.boolean().optional(), nudgeAfterDays: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(14)]).optional(), scanAnswered: z.boolean().optional() }).strict().optional(),
  errorReports: z.enum(["ask", "always", "never"]).optional(),
  language: z.enum(LANGUAGE_SETTINGS).optional(),
  composeSuggestions: z.boolean().optional(),
  undoSend: z.boolean().optional(),
  senderIcons: z.boolean().optional(),
  dockBadge: z.boolean().optional(),
  notifications: z.boolean().optional(),
  notificationPreview: z.boolean().optional(),
});
export type SettingsPatch = z.output<typeof settingsPatch>;
export { settingsPatch as settingsPatchSchema, draftAddress as draftAddressSchema };

/** What an import reads of each item; items are validated one by one on the backend, in time slices (a bad one is skipped). */
// plan 116: `forward` (its trigger) comes in turned off: an import never sends mail elsewhere until the user says so
export const exportCategorySchema = z.object({ id, name: z.string().trim().min(1).max(60), color: z.enum(CATEGORY_COLORS), position: z.number().int().optional(), autoApply: z.boolean().optional(), showInInbox: z.boolean().optional(), forward: z.object({ addresses: z.array(address).min(1).refine((list) => JSON.stringify(list).length <= FORWARD_ADDRESSES_MAX_CHARS), enabled: z.boolean() }).optional() });
// plan 90: `auto` absent (an older export) means the user's
export const exportFilterSchema = z.object({ name: z.string().trim().min(1).max(120), enabled: z.boolean(), source: z.enum(["manual", "ai", "learned"]), auto: z.boolean().optional(), rule: filterRuleSchema });
export const exportedAttachmentSchema = z.object({
  filename: z.string().min(1).max(180), mime: z.string().max(120), size: z.number().int().min(0).max(18 * 1024 * 1024), contentId: z.string().max(300).nullable().optional(), chunks: z.array(z.string().max(65536)).max(384),
}).strict();
export const exportDraftSchema = z.object({
  accountEmail: z.string().max(320).nullable(),
  // format 2 (format 1 had only recipients, subject and text: those import as new messages)
  mode: z.enum(DRAFT_MODES).default("new"),
  to: z.unknown(),
  cc: z.unknown(),
  bcc: z.unknown().optional(),
  subject: z.string().max(998),
  subjectEdited: z.boolean().default(false),
  bodyText: z.string().max(5_000_000),
  // plan 16 (files from before carry none: plain drafts)
  bodyHtml: z.string().max(20_000_000).default(""),
  attachments: z.array(exportedAttachmentSchema).max(100).optional(),
  quotedText: z.string().max(5_000_000).default(""),
  includeQuote: z.boolean().default(false),
  replyContext: z.object({ subject: z.string().max(998), sourceAccountEmail: z.string().max(320).nullable(), rfcMessageId: z.string().min(1).max(1000).nullable() }).nullable().optional(),
  inReplyTo: z.string().max(1000).nullable().default(null),
  forwardOf: z.string().max(1000).nullable().default(null),
  uiState: z.enum(["open", "collapsed"]).default("open"),
});
export type ExportCategory = z.output<typeof exportCategorySchema>;
export type ExportFilter = z.output<typeof exportFilterSchema>;
export type ExportDraftItem = z.output<typeof exportDraftSchema>;

/** An export file (app.export) as app.import reads it: the envelope here; categories, filters and drafts item by item. */
const exportFile = z.object({
  // "unica-export": a file exported when the app was called Única
  format: z.enum(["terno-export", "unica-export"]),
  version: z.union([z.literal(1), z.literal(2)]),
  accounts: z.array(z.object({ id: id.optional(), email: z.string().max(320), kind: z.string().max(20), displayName: z.string().max(300) })).max(1000).default([]),
  categories: z.array(z.unknown()).max(1000).default([]),
  filters: z.array(z.unknown()).max(5000).default([]),
  /** read field by field on import (each only if valid) */
  settings: z.unknown().optional(),
  drafts: z.array(z.unknown()).max(5000).default([]),
  /** plan 93 (files from before carry none) */
  snippets: z.array(z.unknown()).max(1000).default([]),
});
export type ExportFile = z.output<typeof exportFile>;

const categorizeScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sender"), email: z.string().trim().email().max(320) }),
  z.object({ kind: z.literal("subject"), email: z.string().trim().email().max(320), subject: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("domain"), domain: z.string().trim().min(1).max(253) }),
  z.object({ kind: z.literal("list"), listId: z.string().trim().min(1).max(400) }),
  // plan 89: up to 6 words (the snackbar's), each a rule value; the sender optional
  z.object({ kind: z.literal("words"), terms: z.array(z.string().trim().min(1).max(100)).min(1).max(6), email: z.string().trim().email().max(320).nullable() }),
  z.object({ kind: z.literal("query"), query: z.string().trim().min(1).max(500) }),
]);

/** plan 68: an account's folder (its key: an IMAP path, a Gmail label id) */
const folderKey = z.string().min(1).max(1000);
/** plan 107: a folder's new name as typed (one level; the backend checks the server's rules) */
const folderName = z.string().trim().min(1).max(FOLDER_NAME_MAX);
/** plan 107: an account's own folder (`folder`) or one of its standard rows (`view`), exactly one */
const folderTarget = z.object({ accountId: id, folder: folderKey.nullable(), view: z.enum(FOLDER_VIEWS).nullable() });
/** exactly one of the two (said in the user's language when it's checked, like tabScope) */
const oneTarget = (f: { folder: string | null; view: string | null }, ctx: z.RefinementCtx) => {
  if ((f.folder === null) === (f.view === null)) ctx.addIssue({ code: "custom", path: ["folder"], message: t("errors.folder.target") });
};
/** A folder is an account's, alone: no category or review with it, its view "all" (no trash, no spam) */
const folderScope = <T extends { view?: string; accountId?: number; categoryId?: number; folder?: string }>(p: T, ctx: z.RefinementCtx) => {
  if (p.folder === undefined) return;
  if (p.accountId === undefined) ctx.addIssue({ code: "custom", path: ["folder"], message: t("errors.folder.needsAccount") });
  if (p.categoryId !== undefined) ctx.addIssue({ code: "custom", path: ["folder"], message: t("errors.folder.noCategory") });
  if (p.view !== undefined && p.view !== "all") ctx.addIssue({ code: "custom", path: ["view"], message: t("errors.folder.allView") });
};
/** plan 86: a Gmail tab is an account's Inbox, alone (no folder or category with it) */
const tabScope = <T extends { view?: string; accountId?: number; categoryId?: number; folder?: string; tab?: string }>(p: T, ctx: z.RefinementCtx) => {
  folderScope(p, ctx);
  if (p.tab === undefined) return;
  if (p.accountId === undefined) ctx.addIssue({ code: "custom", path: ["tab"], message: t("errors.tab.needsAccount") });
  if (p.categoryId !== undefined || p.folder !== undefined) ctx.addIssue({ code: "custom", path: ["tab"], message: t("errors.tab.alone") });
  if (p.view !== undefined && p.view !== "inbox") ctx.addIssue({ code: "custom", path: ["view"], message: t("errors.tab.inboxView") });
};

/** Every thread of a view (account/category optional) or of a search: "select all N" acts on it on the backend. `filter`: the list's quick filter (`unreadOnly`: plan 12's name for "unread", still accepted). */
const threadScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view"), view: z.enum(VIEWS), accountId: id.optional(), categoryId: id.optional(), folder: folderKey.optional(), tab: z.enum(TABS).optional(), unreadOnly: z.boolean().optional(), filter: z.enum(LIST_FILTERS).optional() }).superRefine(tabScope),
  z.object({ kind: z.literal("search"), query: z.string().trim().min(1).max(2000), accountId: id.optional(), categoryId: id.optional(), unreadOnly: z.boolean().optional(), filter: z.enum(LIST_FILTERS).optional() }),
]);
export type ThreadScope = z.output<typeof threadScope>;

/** Plan 63: mail like some threads (same sender, sender + subject, domain or list). */
const similarScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sender"), email: z.string().trim().min(1).max(320) }),
  z.object({ kind: z.literal("subject"), email: z.string().trim().min(1).max(320), subject: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("domain"), domain: z.string().trim().min(1).max(253) }),
  z.object({ kind: z.literal("list"), listId: z.string().trim().min(1).max(400) }),
]);
/** the filter's name in the user's language (the backend falls back to English) */
const filterName = z.string().trim().min(1).max(120).optional();

export const THREAD_ACTIONS = ["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar", "toPrimary", "toPromotions", "toSocial", "toUpdates", "toForums", "toNoCategory"] as const;
const jobId = z.string().min(1).max(64);

const imapServer = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1).max(320),
});

const reminderSchema = z.object({ threadId: id, dueAt: z.number().int().positive(), kind: z.enum(REMINDER_KINDS), setAt: z.number().int().nonnegative() });

/** Plan 87: a reminder as the renderer sees it; `due`: its time came (by the backend's clock) */
export type ReminderInfo = Reminder & { due: boolean };
export interface RemindersSnapshot {
  reminders: ReminderInfo[];
}

/** Plan 94: a scheduled send as the renderer sees it (who and what from its draft; `error`: why the last try didn't go) */
export interface ScheduledInfo {
  draftId: number;
  sendAt: number;
  accountId: number;
  threadId: number | null;
  mode: "new" | "reply" | "replyAll" | "forward";
  to: { name: string; email: string }[];
  subject: string;
  error: string | null;
  retryAt: number | null;
}
/** Plan 94: a scheduled send that couldn't go and won't be tried again (its draft is a draft again), until the user saw it */
export interface ScheduledFailure {
  id: string;
  draftId: number;
  subject: string;
  message: string;
  at: number;
}
export interface ScheduledSnapshot {
  items: ScheduledInfo[];
  failed: ScheduledFailure[];
}

function m<R>() {
  return <P extends z.ZodType>(params: P, options: { timeoutMs?: number } = {}) => ({
    params,
    timeoutMs: options.timeoutMs,
    __result: undefined as unknown as R,
  });
}

const empty = z.object({}).strict();

/** compose.send's parameters (plan 94's compose.schedule adds the moment and requires the draft) */
const composeSend = z.object({
  accountId: id,
  to: z.array(address).min(1).max(MAX_RECIPIENTS),
  cc: z.array(address).max(MAX_RECIPIENTS).default([]),
  bcc: z.array(address).max(MAX_RECIPIENTS).default([]),
  subject: z.string().max(998),
  // what was written, the signature and the quote (plan 16: an HTML alternative from the renderer only)
  bodyText: z.string().max(10_000_000),
  bodyHtml: z.string().max(25_000_000).optional(),
  inReplyToMessageId: id.optional(),
  forwardOfMessageId: id.optional(),
  draftId: id.optional(),
  draftGeneration: z.string().max(64).optional(),
  draftRevision: z.number().int().positive().optional(),
  attachments: attachmentRefs.optional(),
  /** plan 133 §8: the body as the user left it, before signature and quote: what provenance compares with what the model wrote (renderer only) */
  authoredText: z.string().max(10_000_000).optional(),
});

const requestId = z.string().min(1).max(64);
const writingInstructions = z.string().max(WRITING_INSTRUCTIONS_MAX);
const scopeKeyParam = z.string().min(1).max(400);
const profileLanguage = z.string().max(8);

export const contract = {
  "app.bootstrap": m<Bootstrap>()(empty),
  /** plan 116: the windows' language (what a forward is written in while the setting follows the system) */
  "app.locale": m<{ ok: true }>()(z.object({ locale: z.enum(LOCALE_IDS) }).strict()),
  "app.export": m<MailboxExport>()(empty),
  /**
   * Brings an export back: categories merged by name, filters (categories and
   * accounts remapped; ones naming a mailbox that isn't here are left out),
   * drafts of mailboxes that are here, and settings without secrets. Local
   * mode and agent sending only become stricter.
   */
  "app.import": m<ImportResult>()(z.object({ data: exportFile }), { timeoutMs: 120_000 }),

  "threads.list": m<ThreadPage>()(
    z.object({
      view: z.enum(VIEWS),
      accountId: id.optional(),
      categoryId: id.optional(),
      /** plan 68: one of the account's own folders (with accountId, view "all") */
      folder: folderKey.optional(),
      /** plan 86: a Gmail tab of the account's Inbox (with accountId, view "inbox") */
      tab: z.enum(TABS).optional(),
      /** the unread filter: threads with something unread only (plan 12; `filter: "unread"` since plan 15) */
      unreadOnly: z.boolean().optional(),
      /** the quick filter: unread, with attachments or starred threads only */
      filter: z.enum(LIST_FILTERS).optional(),
      /** with a filter: the open and checked threads too, matching or not, while they are in the view (they stay put until the selection moves) */
      keepIds: z.array(id).max(500).optional(),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).superRefine(tabScope),
  ),
  "threads.search": m<SearchPage>()(
    z.object({
      query: z.string().max(2000),
      accountId: id.optional(),
      categoryId: id.optional(),
      /** the unread filter, ANDed with the query (plan 12; `filter: "unread"` since plan 15) */
      unreadOnly: z.boolean().optional(),
      /** the quick filter, ANDed with the query */
      filter: z.enum(LIST_FILTERS).optional(),
      cursor: searchCursor.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  ),
  /** plan 158: for results whose row doesn't show why they matched, the sentence that does; a few at a time, the rows on screen */
  "threads.excerpts": m<{ excerpts: { threadId: number; text: string }[] }>()(z.object({ query: z.string().max(2000), threadIds: z.array(id).max(10) })),
  "threads.get": m<ThreadDetail>()(z.object({ threadId: id, bodyFormat: z.literal("parts").optional() })),
  "threads.bodyPart": m<string>()(z.object({ accountId: id, messageId: id, version: z.string().min(1).max(100), field: z.enum(["text", "html"]), ordinal: z.number().int().min(0) })),
  "reader.hydrate": m<{ changed: boolean; unavailable?: true }>()(z.object({ threadId: id, messageId: id })),
  /** `undoId` (null when nothing changed) puts back exactly the messages it changed (threads.undo) */
  "threads.act": m<{ affected: number; undoId: number | null }>()(
    z.object({
      threadIds: ids,
      action: z.enum(THREAD_ACTIONS),
    }),
  ),
  /** How many threads a scope holds (the "select all N" banner); capped like the scope actions. */
  "threads.scopeCount": m<{ count: number; capped: boolean }>()(z.object({ scope: threadScope })),
  /**
   * An action on every thread of a scope, resolved once and applied in time
   * slices (one transaction and one op per account each), with `bulkProgress`
   * events for `jobId`. Never a learning signal. `undoId` (null when nothing
   * changed) puts back exactly the messages it changed (threads.undo).
   */
  "threads.actScope": m<{ undoId: number | null; affected: number; total: number }>()(
    z.object({ scope: threadScope, action: z.enum(THREAD_ACTIONS), jobId: jobId.optional() }),
    { timeoutMs: 300_000 },
  ),
  /** Takes an action back (threads.act or actScope): each message it changed returns to its previous read, star and place. Once. */
  "threads.undo": m<{ restored: number }>()(z.object({ undoId: id, jobId: jobId.optional() }), { timeoutMs: 300_000 }),

  /** plan 87: every reminder (answered "noReply" ones end first) */
  "reminders.list": m<RemindersSnapshot>()(empty),
  /** plan 87: the same reminder on these threads, replacing theirs; refused past REMINDERS_MAX. `rows`: what it set; `replaced`: what they had (Undo) */
  "reminders.set": m<{ rows: Reminder[]; replaced: Reminder[] }>()(
    z.object({ threadIds: z.array(id).min(1).max(REMINDERS_MAX), dueAt: z.number().int().positive(), kind: z.enum(REMINDER_KINDS) }),
  ),
  /** plan 87: removes these threads' reminders (`dueOnly`: only those due now; `exact`: only if still exactly these: an open ends the one it saw); what it removed */
  "reminders.clear": m<{ cleared: Reminder[] }>()(
    z.object({ threadIds: z.array(id).min(1).max(REMINDERS_MAX), dueOnly: z.boolean().optional(), exact: z.array(reminderSchema).max(REMINDERS_MAX).optional() }),
  ),
  /** plan 87: Undo: drops these rows if they are still exactly these, and puts those back */
  "reminders.restore": m<{ ok: true }>()(z.object({ drop: z.array(reminderSchema).max(REMINDERS_MAX), put: z.array(reminderSchema).max(REMINDERS_MAX) })),
  /** plan 87: the reminders' conversations, none in Trash or Spam. `dueOnly`: the due ones (newest due first, the Inbox's top); otherwise all (soonest first) */
  "reminders.threads": m<{ items: ThreadSummary[] }>()(z.object({ dueOnly: z.boolean(), accountId: id.optional() })),

  /** Plan 93: snippets, by name. */
  "snippets.list": m<Snippet[]>()(empty),
  /**
   * Creates or updates one. `base` is the updatedAt the edit started from:
   * null creates it (or puts back a deleted one, its id kept); otherwise it
   * must still be the stored one (STALE: changed or deleted elsewhere).
   * `force` saves over whatever is there ("Keep mine").
   */
  "snippets.save": m<Snippet>()(snippetFieldsSchema.extend({ id: snippetIdSchema, base: z.number().int().min(0).nullable(), force: z.boolean().optional() })),
  "snippets.delete": m<{ ok: true }>()(z.object({ id: snippetIdSchema })),

  /** plan 96: what Unsubscribe would do for this conversation; null: nothing found (no menu item) */
  "unsubscribe.find": m<import("../unsubscribe").UnsubscribeOffer | null>()(z.object({ threadId: id })),
  /** plan 96: does what `find` offered, only if the conversation still offers exactly that */
  "unsubscribe.run": m<import("../unsubscribe").UnsubscribeOutcome>()(
    z.object({ threadId: id, messageId: id, method: z.enum(UNSUBSCRIBE_METHODS), target: z.string().min(1).max(400) }),
    { timeoutMs: 30_000 },
  ),

  /** Plan 63: what these threads share, each scope with how many threads it would move now (targets still in place included; ≤ 200 targets, else nothing). */
  /** Plan 91: the offers after an action (archive, trash, spam, or a move to a category), and whether the targets' senders are automated. */
  "offers.forAction": m<SimilarOffers & { automated: boolean }>()(
    z.object({ threadIds: z.array(id).min(1).max(200), action: z.union([z.enum(SIMILAR_ACTIONS), z.object({ category: id }), z.object({ accountId: id, folder: folderKey })]) }),
  ),
  "similar.offers": m<SimilarOffers>()(z.object({ threadIds: z.array(id).min(1).max(200), action: z.enum(SIMILAR_ACTIONS) })),
  /**
   * Archives, deletes or spams a scope (resolved once, sliced, with progress) plus the
   * targets still in place; starred and replied threads are skipped unless targeted.
   * Spam also sends future mail there (a filter). A failure after some slices carries
   * `{ undoId }` in its details. `filterUndo` lets similar.undo take the filter back.
   */
  "similar.apply": m<{ affected: number; skipped: number; undoId: number | null; filter: { id: number; filterUndo: number | null } | null; filterFailed: boolean }>()(
    z.object({ threadIds: z.array(id).max(200), scope: similarScope, action: z.enum(SIMILAR_ACTIONS), jobId: jobId.optional(), filterName }),
    { timeoutMs: 300_000 },
  ),
  /** "Always": the scope as a filter for future mail (an identical one is reused, a disabled one enabled). */
  "similar.always": m<{ filter: Filter; filterUndo: number | null }>()(z.object({ scope: similarScope, action: z.enum(SIMILAR_ACTIONS), filterName })),
  /** Takes back similar.apply: the filter first (no new mail caught meanwhile), then the threads. Retryable: a failure keeps it. */
  "similar.undo": m<{ restored: number }>()(z.object({ undoId: id.nullable(), filterUndo: id.nullable(), jobId: jobId.optional() }), { timeoutMs: 300_000 }),

  /** A new category keeps its mail out of the Inbox unless asked (like a folder: plan 83's switch turns it on). */
  "categories.create": m<Category>()(
    z.object({ name: z.string().trim().min(1).max(60), color: z.enum(CATEGORY_COLORS), showInInbox: z.boolean().default(false) }),
  ),
  "categories.update": m<Category>()(
    z.object({
      id,
      name: z.string().trim().min(1).max(60).optional(),
      color: z.enum(CATEGORY_COLORS).optional(),
      position: z.number().int().min(0).optional(),
      autoApply: z.boolean().optional(),
      showInInbox: z.boolean().optional(),
    }),
  ),
  /** The sidebar order: positions follow `ids` (one transaction); returns the new list. */
  "categories.reorder": m<Category[]>()(z.object({ ids: z.array(id).min(1).max(1000) })),
  "categories.delete": m<{ ok: true }>()(z.object({ id })),
  /** The one way the UI files threads (picker, drag and drop, snackbar, accepted suggestion): it trains the model and returns what changed for undo. */
  "categories.addThreads": m<AddThreadsResult>()(
    z.object({ categoryId: id, threadIds: ids, source: z.enum(CATEGORIZE_SOURCES).default("picker") }),
  ),
  /**
   * Drag and drop, "Mover a…": an exclusive move. Afterwards every thread is
   * in `to` and in no other category, in one transaction; `moved` are the
   * threads that left at least one. categorize.undo on the returned batch
   * restores every membership exactly.
   */
  "categories.moveThreads": m<AddThreadsResult & { batchId: number; moved: number[] }>()(
    z.object({ to: id, threadIds: ids, source: z.enum(CATEGORIZE_SOURCES).default("dnd") }),
    // 5,000 threads in 20 categories each, in slices a busy machine keeps small
    { timeoutMs: 300_000 },
  ),
  /** Files every thread of a scope ("select all N" → Categorías), sliced like the picker's large adds; undo with categorize.undo. */
  "categories.addScope": m<{ added: number; batchId: number | null }>()(
    z.object({ categoryId: id, scope: threadScope, jobId: jobId.optional() }),
    { timeoutMs: 300_000 },
  ),
  /** "user" removals teach the model (a strong negative); "undo" takes back the user's own add without learning anything. */
  "categories.removeThreads": m<{ removed: number }>()(
    z.object({ categoryId: id, threadIds: ids, reason: z.enum(["user", "undo"]).default("user") }),
  ),

  /**
   * Plan 77: "Everything from X → Out of C". Every thread from the sender in
   * the category leaves it (as a user removal: the model learns it), as a
   * journaled move; categorize.undo on the batch puts back every row,
   * example and decision. A failure partway carries `{ batchId }` in its
   * details, so what was done can still be undone.
   */
  "categories.removeSender": m<{ batchId: number | null; removed: number[] }>()(
    z.object({ categoryId: id, email: z.string().trim().email().max(320) }),
    { timeoutMs: 300_000 },
  ),

  /** What the snackbar offers after filing: same sender / domain / list, distinguishing words, a filter draft. */
  "categorize.quickActions": m<QuickActions>()(z.object({ categoryId: id, threadIds: z.array(id).min(1).max(200) })),
  "categorize.count": m<{ count: number; capped: boolean }>()(z.object({ categoryId: id, scope: categorizeScope })),
  "categorize.preview": m<{ count: number; capped: boolean; sample: ThreadSummary[] }>()(
    z.object({ categoryId: id, scope: categorizeScope, limit: z.number().int().min(0).max(50).default(20) }),
  ),
  /**
   * Files every thread in the scope (resolved once, then added in slices); undo with categorize.undo. A failure
   * partway carries `{ batchId }` in its details. Plan 80: `always` (sender, subject; plan 81: domain, list) also ensures the
   * filter that files future mail there; `filterUndo` lets similar.undo take it back.
   */
  "categorize.apply": m<{ batchId: number | null; added: number; filter: { id: number; filterUndo: number | null; retargeted: { from: number } | null } | null; filterFailed: boolean }>()(
    // a filter says who sent it (and the subject), the domain or the list (plan 81), or words (plan 89); a search can't be filed always
    // plan 91: `move` files the set exclusively (a drag's semantics: other categories left, journaled; categorize.undo restores)
    z.object({ categoryId: id, scope: categorizeScope, always: z.boolean().optional(), filterName, move: z.boolean().optional() }).refine((p) => !p.always || p.scope.kind !== "query"),
    { timeoutMs: 120_000 },
  ),
  /** Plan 80: "Always file here" for one thread: same subject from its sender, then all from them, with how many each files now. */
  "categorize.alwaysOffers": m<{ senderName: string | null; offers: { scope: AlwaysScope; count: number; capped: boolean }[] }>()(z.object({ categoryId: id, threadId: id })),
  /** Takes back one batch; for a move, atomically restores the source too (`restored`). Idempotent. */
  "categorize.undo": m<{ removed: number; restored?: number }>()(z.object({ batchId: id }), { timeoutMs: 300_000 }),
  "categorize.predict": m<Prediction[]>()(z.object({ threadId: id })),
  "categorize.suggestions": m<{ items: (ThreadSummary & { prediction: Prediction })[] }>()(
    z.object({ categoryId: id.optional(), limit: z.number().int().min(1).max(200).default(100) }),
  ),
  /** Answer to a suggestion: accept files it (as a suggestion), reject is a negative example. */
  "categorize.feedback": m<{ ok: true }>()(z.object({ threadId: id, categoryId: id, verdict: z.enum(["accept", "reject"]) })),
  "categorize.stats": m<CategoryModelStats[]>()(empty),

  "counts.get": m<Counts>()(empty),

  "filters.list": m<Filter[]>()(empty),
  "filters.save": m<Filter>()(
    z.object({
      id: id.optional(),
      name: z.string().trim().min(1).max(120),
      enabled: z.boolean(),
      source: z.enum(["manual", "ai", "learned"]),
      rule: filterRuleSchema,
      /** plan 90: the builder sends false when the user changed an automatic filter (it becomes theirs); absent keeps it */
      auto: z.boolean().optional(),
    }),
  ),
  "filters.delete": m<{ ok: true }>()(z.object({ id })),
  /** Plan 90: filters on or off at once, each only if unchanged since read; `filterUndo` (similar.undo) takes it back. */
  "filters.setEnabled": m<{ changed: number; filterUndo: number | null }>()(z.object({ ids: z.array(id).min(1).max(500), enabled: z.boolean() })),
  /** Plan 90: Terno's enabled filters that file these threads (their root inbound mail) into the category. */
  "filters.autoFor": m<{ filters: { id: number; name: string }[] }>()(z.object({ categoryId: id, threadIds: z.array(id).min(1).max(200) })),
  "filters.preview": m<{ count: number; sample: ThreadSummary[] }>()(
    z.object({ rule: filterRuleSchema, limit: z.number().int().min(0).max(100).default(20) }),
  ),
  /** Plan 89: a background job (progress on `jobId`); one at a time per filter (BAD_REQUEST); a failure partway carries the counts so far. */
  "filters.apply": m<{ matchedMessages: number; affectedThreads: number }>()(
    z.object({ id, jobId: z.string().max(100).optional() }),
    { timeoutMs: 30 * 60_000 },
  ),
  "filters.generate": m<{ name: string; rule: FilterRule; explanation: string }>()(
    z.object({ prompt: z.string().trim().min(3).max(2000) }),
    { timeoutMs: 120_000 },
  ),

  "learning.proposals": m<LearnedProposal[]>()(empty),
  // name: the filter's name in the user's language (the backend has none; without it, English)
  "learning.accept": m<Filter>()(z.object({ key: z.string().max(400), name: z.string().trim().min(1).max(120).optional() })),
  "learning.dismiss": m<{ ok: true }>()(z.object({ key: z.string().max(400) })),

  /** `messageId`: the sent copy shown in the thread until the server's replaces it */
  "compose.send": m<{ opId: string; threadId: number; messageId: number }>()(composeSend),
  /** plan 94: the same send, prepared now, sent at `sendAt` (its draft stays until then; past: at once) */
  "compose.schedule": m<{ ok: true }>()(composeSend.extend({ draftId: id, draftGeneration: z.string().min(1).max(64), draftRevision: z.number().int().positive(), sendAt: z.number().int().nonnegative() })),
  /** plan 158: Send's Undo window: a schedule of UNDO_SEND_MS, on the backend's clock, that isn't listed as one (`scheduled.cancel` takes it back). With no room to hold it, it's queued as a plain send */
  "compose.hold": m<{ held: true } | { held: false; threadId: number; messageId: number }>()(composeSend.extend({ draftId: id, draftGeneration: z.string().min(1).max(64), draftRevision: z.number().int().positive() })),
  /** plan 116: what is waiting to be forwarded, held, going, and what settled lately; the questions past the cap */
  "forwards.list": m<import("../forwarding").ForwardSnapshot>()(empty),
  /** the user's Cancel (those still waiting or held) */
  "forwards.cancel": m<{ cancelled: number }>()(z.object({ ids: z.array(id).min(1).max(1000) }).strict()),
  /** the notice's Cancel: every forward still waiting that was made by then (id ≤ upTo) */
  "forwards.cancelWaiting": m<{ cancelled: number }>()(z.object({ upTo: id }).strict()),
  /** a failed forward (nothing went) waits again */
  "forwards.retry": m<{ ok: true }>()(z.object({ id }).strict()),
  /** past the cap: Keep forwarding (true) or Stop (false) */
  "forwards.answer": m<{ ok: true }>()(z.object({ rule: z.object({ kind: z.enum(["category", "filter"]), id }).strict(), keep: z.boolean() }).strict()),
  /** a category's trigger: where its new mail is forwarded (null: nowhere) */
  "categories.setForward": m<Category>()(z.object({ categoryId: id, forward: z.object({ addresses: z.array(address).min(1), enabled: z.boolean() }).strict().nullable() }).strict()),
  "scheduled.list": m<ScheduledSnapshot>()(empty),
  "scheduled.reschedule": m<{ ok: true }>()(z.object({ draftId: id, sendAt: z.number().int().nonnegative() }).strict()),
  /** the draft is an ordinary draft again */
  "scheduled.cancel": m<{ ok: true }>()(z.object({ draftId: id }).strict()),
  /** failures the user has seen */
  "scheduled.ackFailed": m<{ ok: true }>()(z.object({ ids: z.array(z.string().max(64)).max(100) }).strict()),
  /** null: the draft is gone (sent or discarded elsewhere). A stale baseRevision never overwrites: it saves a new draft. */
  "captureRepairs.list": m<import("../capture-repair").CaptureRepairPage>()(z.object({ accountId: id, after: z.string().max(1048576).optional() }).strict()),
  "captureRepairs.retry": m<{ repair: import("../capture-repair").CaptureRepair | null }>()(z.object({ accountId: id, key: z.string().max(1048576), revision: z.number().int().nonnegative() }).strict(), { timeoutMs: 120_000 }),
  "attachments.retry": m<{ ok: true }>()(z.object({ accountId: id, messageId: id }).strict(), { timeoutMs: 120_000 }),
  "attachments.create": m<AttachmentRef>()(z.object({ accountId: id, filename: z.string().max(1000), mime: z.string().max(120), size: z.number().int().min(0).max(18 * 1024 * 1024), contentId: z.string().max(300).nullable().optional() }).strict()),
  "attachments.append": m<{ ok: true }>()(assetRequest.extend({ index: z.number().int().min(0).max(384), dataBase64: z.string().max(65536) }).strict()),
  "attachments.seal": m<{ ok: true }>()(assetRequest),
  "attachments.info": m<AttachmentRef>()(assetRequest),
  "attachments.read": m<{ dataBase64: string | null }>()(assetRequest.extend({ index: z.number().int().min(0).max(384) }).strict()),
  "attachments.discard": m<{ ok: true }>()(assetRequest),

  "drafts.save": m<Draft | null>()(
    z.object({
      id: id.optional(),
      generation: z.string().max(64).optional(),
      baseRevision: z.number().int().min(0).optional(),
      accountId: id,
      threadId: id.nullable().optional(),
      mode: z.enum(DRAFT_MODES).optional(),
      to: z.array(draftAddress).max(MAX_RECIPIENTS).default([]),
      cc: z.array(draftAddress).max(MAX_RECIPIENTS).default([]),
      bcc: z.array(draftAddress).max(MAX_RECIPIENTS).default([]),
      subject: z.string().max(998).default(""),
      subjectEdited: z.boolean().optional(),
      bodyText: z.string().max(5_000_000).default(""),
      // plan 16: omitted = a plain draft (every save rewrites the body); only the renderer's is kept
      bodyHtml: z.string().max(20_000_000).default(""),
      attachments: attachmentRefs.optional(),
      quotedText: z.string().max(5_000_000).optional(),
      includeQuote: z.boolean().optional(),
      replyContext: z.object({ subject: z.string().max(998), sourceId: id, sourceAccountId: id, rfcMessageId: z.string().max(1000).nullable().optional(), contextId: z.string().min(1).max(64).optional() }).nullable().optional(),
      inReplyToMessageId: id.nullable().optional(),
      forwardOfMessageId: id.nullable().optional(),
      showSourceContext: z.boolean().optional(),
      uiState: z.enum(["open", "collapsed"]).optional(),
    }),
  ),
  /** plan 18: a draft or a recipient field opened: the autocomplete models restore or build (once) */
  "compose.warm": m<{ ok: true }>()(empty),
  /** recipients for what is typed in To/Cc/Bcc (in-memory; ready: false while the index is first built) */
  "compose.suggestRecipients": m<{ items: { name: string; email: string }[]; ready: boolean }>()(
    z.object({
      query: z.string().max(320),
      exclude: z.array(z.string().max(320)).max(600).default([]),
      accountId: id.optional(),
      limit: z.number().int().min(1).max(10).default(6),
    }),
    // a suggestion that comes late is no suggestion
    { timeoutMs: 3000 },
  ),
  /** the best few people per first letter and digit, so a first keystroke shows suggestions at once (a recipient field focused) */
  "compose.recipientInitials": m<Record<string, { name: string; email: string }[]>>()(z.object({ accountId: id.optional() }), { timeoutMs: 5000 }),
  /** ghost text after `before` (only its last 1,000 characters are read) */
  "compose.suggestText": m<{ text: string | null }>()(
    z.object({
      before: z.string().max(2000),
      names: z.array(z.string().max(300)).max(10).default([]),
      me: z.string().max(300).optional(),
    }),
    { timeoutMs: 2000 },
  ),
  "drafts.list": m<Draft[]>()(empty),
  "drafts.sourceContext": m<{ threadId: number; accountId: number } | null>()(z.object({ messageId: id }).strict()),
  "drafts.delete": m<{ ok: true }>()(z.object({ id, generation: z.string().max(64).optional() })),

  "accounts.addImap": m<Account>()(
    z.object({
      email: z.string().email(),
      displayName: z.string().trim().max(200),
      imap: imapServer,
      smtp: imapServer,
      password: z.string().min(1).max(1000),
      verify: z.boolean().default(true),
      /** plan 79: the days of mail asked for when connecting; absent: the General setting */
      syncWindowDays: syncWindow.optional(),
    }),
    { timeoutMs: 60_000 },
  ),
  "accounts.connectGmail": m<Account>()(z.object({ syncWindowDays: syncWindow.optional() }).strict(), { timeoutMs: 300_000 }),
  /**
   * web: an access token from Google's token model (the page signs in); connects the mailbox or renews its token.
   * With `accountId` (plan 25: signing that account in again) the token must be that account's, else nothing changes.
   */
  "accounts.connectGmailToken": m<Account>()(z.object({ accessToken: z.string().min(1).max(4096), expiresIn: z.number().int().min(60).max(86_400), accountId: id.optional(), syncWindowDays: syncWindow.optional() }), { timeoutMs: 60_000 }),
  "accounts.update": m<Account>()(
    z.object({
      id,
      displayName: z.string().trim().min(1).max(200).optional(),
      color: z.enum(CATEGORY_COLORS).optional(),
      senderName: z.string().trim().max(200).optional(),
      signature: z.string().max(10_000).optional(),
      /** null: the general setting */
      syncWindowDays: syncWindow.nullable().optional(),
      /** plan 86 (Gmail): Promotions and Social apart from the Inbox */
      separateTabs: z.boolean().optional(),
      followups: z.boolean().optional(),
    }),
  ),
  /**
   * Signs a connected mailbox in again (a revoked Gmail grant, a changed IMAP
   * password): Google for the same address, or the password verified with a
   * live login. Its waiting actions resume and it syncs.
   */
  "accounts.reconnect": m<Account>()(z.object({ id, password: z.string().min(1).max(1000).optional() }), { timeoutMs: 300_000 }),
  /** plan 125: a Gmail account's grant is withdrawn at Google after the local removal; `google` says how that went */
  "accounts.remove": m<{ ok: true; google?: "revoked" | "failed" }>()(z.object({ id })),

  /**
   * Plan 107: an account's own folders, changed on its server (IMAP mailboxes, Gmail labels), one change at a time
   * per account. `parent`: the folder it goes in (null: the top). Names are checked against the server's catalog.
   */
  "folders.create": m<Folder>()(z.object({ accountId: id, parent: folderKey.nullable(), name: folderName }), { timeoutMs: 120_000 }),
  /** Plan 107: a new name for a folder (its subfolders follow). `renamed`: where each one went. */
  "folders.rename": m<{ renamed: FolderRename[] }>()(z.object({ accountId: id, key: folderKey, name: folderName }), { timeoutMs: 120_000 }),
  /** Plan 107: deletes a folder and its subfolders on the server (IMAP: with their mail). `deleted`: their keys. */
  "folders.delete": m<{ deleted: string[] }>()(z.object({ accountId: id, key: folderKey }), { timeoutMs: 300_000 }),
  /**
   * Plan 127: threads into a folder of their account, out of `from` (the folder they're dragged from) and out of the
   * Inbox, unless they're in a category shown there and none hidden (`kept` of them stay). `threads.undo` takes it back.
   */
  "folders.moveThreads": m<{ affected: number; kept: number; undoId: number | null }>()(
    z.object({ accountId: id, folder: folderKey, from: folderKey.nullable(), threadIds: z.array(id).min(1).max(5000), jobId: jobId.optional() }),
    { timeoutMs: 300_000 },
  ),
  /**
   * Plan 127: the same for a scope, resolved once and sliced with progress. Plan 128: and a filter for its new mail,
   * saved first (`filterFailed`: only what's there moved). `similar.undo` takes back both; a failure partway carries
   * `{ undoId, filterUndo }` in its details.
   */
  "folders.moveScope": m<{ affected: number; kept: number; undoId: number | null; filter: { id: number; filterUndo: number | null; retargeted: { from: string } | null } | null; filterFailed: boolean }>()(
    z.object({ accountId: id, folder: folderKey, from: folderKey.nullable(), scope: similarScope, filterName: filterName.unwrap(), jobId: jobId.optional() }),
    { timeoutMs: 300_000 },
  ),
  /** Plan 107: what a delete takes with it, for its confirmation (messages in the folder and its subfolders, here) */
  "folders.count": m<{ messages: number; folders: number }>()(z.object({ accountId: id, key: folderKey })),
  /** Plan 107: a folder (or a standard row) below Starred, or not: the list kept, with its revision (as `favoriteFolders`) */
  "folders.favorite": m<FavoriteFoldersSnapshot>()(folderTarget.extend({ on: z.boolean() }).superRefine(oneTarget)),
  /**
   * Plan 107: an .mbox of a folder's messages from this computer's copy, as a session: `start` fixes the messages
   * (by date, then id) and says how many; each `next` gives the following text (bounded by size and time), until
   * `done`; `cancel` ends it early. A session idle for a minute ends by itself.
   */
  // `requestId`: the renderer's own, so a cancel while it starts (no exportId yet) stops it (Codex code review round 14 #3)
  "folders.exportStart": m<{ exportId: string; total: number; name: string }>()(folderTarget.extend({ requestId: z.string().min(1).max(100).optional() }).superRefine(oneTarget)),
  "folders.exportNext": m<{ text: string; done: number; total: number; finished: boolean; missingAttachments: number; partialBodies: number }>()(z.object({ exportId: z.string().min(1).max(100) }), { timeoutMs: 60_000 }),
  // a session's exportId, or a start's requestId while it starts
  "folders.exportCancel": m<{ ok: true }>()(z.object({ exportId: z.string().min(1).max(100) })),

  /** Plan 69: what the mailbox takes on this device, by view, and what each age would remove (read in slices; nothing kept). */
  "storage.report": m<StorageReport>()(empty, { timeoutMs: 120_000 }),
  /**
   * Plan 69: removes this device's copy of old conversations (the mail server keeps its own): those of `buckets`
   * whose newest message is older than `olderThanDays`, never starred, replied, drafted or unsettled ones. Sliced,
   * with `bulkProgress` for `jobId` (in messages); one at a time. Not undoable.
   */
  "storage.remove": m<{ threads: number; messages: number; compact: "done" | "onRestart" | "none" }>()(
    z.object({
      buckets: z.array(z.enum(REMOVABLE_BUCKETS)).min(1).max(REMOVABLE_BUCKETS.length),
      olderThanDays: z.number().int().refine((d) => (STORAGE_AGES as readonly number[]).includes(d)),
      jobId: jobId.optional(),
    }).strict(),
    { timeoutMs: 600_000 },
  ),

  "settings.update": m<AppSettings>()(settingsPatch),

  "ai.providers": m<{ providers: ProviderDescriptor[]; presets: PresetDescriptor[] }>()(empty),
  "ai.listModels": m<{ models: ModelInfo[]; tookMs: number }>()(aiTarget, { timeoutMs: 15_000 }),
  "ai.test": m<AiTestResult>()(aiTarget.extend({ model: z.string().trim().min(1).max(200) }), { timeoutMs: 120_000 }),
  /** Lets the saved key be sent to the provider's current endpoint (after the endpoint changed). */
  "ai.confirmKey": m<AppSettings>()(z.object({ provider: z.enum(AI_PROVIDER_IDS), preset: z.enum(COMPATIBLE_PRESETS).optional() })),
  "ai.setKey": m<AppSettings>()(
    z.object({ provider: z.enum(AI_PROVIDER_IDS), preset: z.enum(COMPATIBLE_PRESETS).optional(), value: z.string().trim().max(1000) }),
  ),

  /** Stops one of this connection's requests. */
  "ai.cancel": m<{ ok: true }>()(z.object({ requestId: z.string().min(1).max(64) })),
  "ai.usage": m<AiUsageReport>()(empty),
  /**
   * Plan 132 §7: a conversation's summary, by hand: any thread that isn't in spam or trash, however old. Cancellable
   * with `ai.cancel`. It runs at once: where AI sends mail is said where the provider is chosen (plan 131, no per-use consent).
   */
  "ai.summarize": m<AiSummarizeResult>()(z.object({ threadId: id, requestId: z.string().min(1).max(64) }), { timeoutMs: 120_000 }),
  /** Plan 132 §6: the summary an open reader shows. Mail content: renderer only, never for MCP. */
  "ai.summaries.get": m<AiSummaryRead>()(z.object({ threadId: id })),
  /** What the automatic summaries are doing, for Settings → AI. */
  "ai.summaries.status": m<AiSummariesStatus>()(empty),
  /** Settings → Storage → Clear AI data. */
  "ai.summaries.clear": m<{ ok: true }>()(empty),

  // plan 142. All renderer-only: none of these is in MCP_ALLOWED.
  "followups.list": m<FollowupsSnapshot>()(empty),
  /** the threads of these rows, for the list and the Inbox's top: one a thread (revision 10) */
  "followups.threads": m<{ items: ThreadSummary[] }>()(z.object({ onTop: z.boolean(), accountId: id.optional() })),
  "followups.act": m<{ undoId: string | null; row: FollowupRow | null }>()(z.object({ id, revision: z.number().int().min(0), action: z.enum(["done", "dismiss", "later"]), dueAt: z.number().int().optional() })),
  "followups.undo": m<{ ok: true }>()(z.object({ undoId: z.string().min(1).max(64) })),
  /** the Inbox's top ends for this thread: it was opened and stayed on screen */
  "followups.seen": m<{ ok: true }>()(z.object({ threadId: id })),
  /** the one-time check: how much, and what it would cost when the price is known */
  /** why it has stopped reading, for Settings */
  "followups.status": m<{ blockedBy: { kind: AiErrorKind; message: string } | null }>()(empty),
  "followups.scanOffer": m<{ count: number; usd: number | null }>()(empty),
  "followups.scan": m<{ queued: number }>()(empty),

  // plan 141. All renderer-only: none of these is in MCP_ALLOWED, since a question and its answers are mail content.
  /**
   * A question: the answer's text streams to this connection as `aiAsk` events, cancellable with `ai.cancel`.
   * `conversationId`: a follow-up.
   */
  "ai.ask": m<AiAskResult>()(z.object({ requestId, question: z.string().trim().min(1).max(ASK_QUESTION_MAX), conversationId: id.optional(), timezone: z.string().min(1).max(100) }), { timeoutMs: 180_000 }),
  /** The user's own servers look further back for this turn's question; one more answer comes of it. Only on a click. */
  "ai.askOlder": m<AiAskResult>()(z.object({ requestId, conversationId: id, turnId: id, timezone: z.string().min(1).max(100) }), { timeoutMs: 300_000 }),
  /** Plan 145: what needs you. Local, and live: asked again as things change. `heldIds`: the open and checked rows, kept in place. */
  "today.list": m<TodayList>()(z.object({ heldIds: z.array(id).max(500).default([]) })),
  "today.digest": m<DigestRow | null>()(z.object({ day: z.string().max(10).optional() })),
  /** a person's try again */
  "today.digestRetry": m<{ ok: true }>()(empty),
  /** only the rows named, and each only if it's still as the page listed it. Undo is `threads.undo`. */
  "today.digestArchive": m<{ undoId: number | null; archived: number; /** plan 161, pass 2: exactly which, so the page hides only these */ archivedIds: number[]; changed: number; spared: number }>()(z.object({ items: z.array(z.object({ threadId: id, lastDate: z.number(), messageCount: z.number().int(), /** plan 166: a sender said not to be a newsletter meanwhile is left alone */ fromEmail: z.string().max(320).optional() })).max(200), jobId: z.string().min(1).max(64).optional() }), { timeoutMs: 120_000 }),
  /**
   * Plan 166: "Not a newsletter": this sender stays out of every digest and Automated mail, on this machine. No model,
   * no check. `at` puts back an entry an Undo took off, where it was. `evicted`: the oldest, dropped at the cap.
   */
  "today.notNewsletter": m<{ added: NotNewsletter | null; evicted: NotNewsletter | null }>()(z.object({ email: z.string().trim().min(3).max(320), name: z.string().max(200), at: z.number().int().optional() })),
  /** Plan 166: let a sender back in. `at`: only that entry (an Undo's), so an old Undo can't take off one said again since */
  "today.newsletterAgain": m<{ removed: NotNewsletter | null }>()(z.object({ email: z.string().trim().min(3).max(320), at: z.number().int().optional() })),
  /** Plan 166: the senders kept out, newest first: Settings → AI → Newsletter digest */
  "today.notNewsletters": m<{ senders: NotNewsletter[] }>()(empty),
  /**
   * Plan 144: a conversation that waits for an answer stayed open. It reads the switch, the thread and what's stored
   * again, whatever the window thought, and goes on in `aiReply`. Never MCP. Nothing is ever sent from here.
   */
  "ai.prepareReply": m<AiPrepareReply>()(z.object({ threadId: id, accountId: id, to: z.array(address).max(MAX_RECIPIENTS), cc: z.array(address).max(MAX_RECIPIENTS).default([]), answeringMessageId: id.optional(), timezone: z.string().min(1).max(100) })),
  /** the window went elsewhere: before the first word it stops, after it it finishes and is kept */
  "ai.replyLeave": m<{ ok: true }>()(z.object({ threadId: id })),
  /** Stop, or the person asked for something else */
  "ai.replyStop": m<{ ok: true }>()(z.object({ threadId: id, dismiss: z.boolean() })),
  /** Conditional on the row as it was seen. Null: refused, and the row isn't what it was. `to` and `cc`: who a reply goes to now. */
  "ai.replyAct": m<PreparedReply | null>()(z.object({ threadId: id, rowId: z.string().min(1).max(64), revision: z.number().int().min(0), action: z.enum(["use", "restore", "dismiss", "undismiss"]), to: z.array(address).max(MAX_RECIPIENTS).default([]), cc: z.array(address).max(MAX_RECIPIENTS).default([]), timezone: z.string().min(1).max(100).default("UTC") })),
  "ai.replyStatus": m<{ blockedBy: { kind: AiErrorKind } | null }>()(empty),
  /**
   * Plan 161: which phrases of a sentence (after "from" or "de") name someone who has written to you, from the
   * autocomplete index (exact tokens, in memory; no model). `ready: false`: the index isn't there yet, and nobody's named.
   */
  "senders.named": m<{ named: string[]; ready: boolean }>()(z.object({ phrases: z.array(z.string().trim().min(1).max(100)).min(1).max(4) }), { timeoutMs: 5000 }),
  /** Plan 143: a sentence into a preview. It only reads: nothing changes until `ai.actionApply`, from the connection that saw it. */
  "ai.actionStart": m<AiActionStart>()(z.object({ requestId, sentence: z.string().trim().min(1).max(ASK_QUESTION_MAX), conversationId: id.optional(), timezone: z.string().min(1).max(100) }), { timeoutMs: 300_000 }),
  "ai.actionPage": m<{ items: ThreadSummary[]; total: number; unticked: number[]; tags: [number, ActionRowTag][] }>()(z.object({ previewId: z.string().min(1).max(64), offset: z.number().int().min(0), limit: z.number().int().min(1).max(500), leftOut: z.boolean() })),
  "ai.actionToggle": m<ActionPreviewInfo>()(z.object({ previewId: z.string().min(1).max(64), threadId: id, included: z.boolean() })),
  "ai.actionIncludeSkipped": m<ActionPreviewInfo>()(z.object({ previewId: z.string().min(1).max(64), included: z.boolean() })),
  /** Senders and subjects, never a body, to see which rows don't fit: it can only remove. */
  "ai.actionCheck": m<AiActionCheck>()(z.object({ previewId: z.string().min(1).max(64), requestId, skip: z.boolean().optional() }), { timeoutMs: 300_000 }),
  "ai.actionApply": m<AiActionApplied>()(z.object({ previewId: z.string().min(1).max(64), jobId: z.string().min(1).max(64).optional(), future: z.boolean() }), { timeoutMs: 600_000 }),
  /** Between slices: what committed stays, with its Undo. */
  "ai.actionStop": m<{ ok: true }>()(z.object({ previewId: z.string().min(1).max(64) })),
  "ai.actionCancel": m<{ ok: true }>()(z.object({ previewId: z.string().min(1).max(64) })),
  "ai.actionUndo": m<{ restored: number }>()(z.object({ token: z.string().min(1).max(32), jobId: z.string().min(1).max(64).optional() }), { timeoutMs: 600_000 }),
  /** Previous AI questions: newest first, at most 100. */
  "ai.askHistory": m<AskConversationSummary[]>()(empty),
  /** A saved conversation, with no request. Null: it's gone. */
  "ai.askConversation": m<{ turns: AskTurn[]; sources: Record<number, AskSourceView>; older: AskOlderOffer } | null>()(z.object({ conversationId: id })),
  "ai.askSources": m<Record<number, AskSourceView>>()(z.object({ messageIds: z.array(id).max(ASK_SOURCES_MAX) })),
  "ai.askDelete": m<{ ok: true }>()(z.object({ conversationId: id })),
  "ai.askRestore": m<{ ok: true }>()(z.object({ conversationId: id })),

  // plan 133. All renderer-only: none of these is in MCP_ALLOWED. The contract's described in the plan's last section.
  /**
   * A draft, streamed to this connection as `aiCompose` events; cancellable with `ai.cancel`. `session`: one draft's
   * refinement session: a second call in it with the same sources and settings assembles nothing.
   */
  "ai.compose": m<AiComposeResult>()(
    z.object({
      requestId,
      session: z.string().min(1).max(64),
      accountId: id,
      kind: z.enum(["reply", "new"]),
      threadId: id.optional(),
      /** the message being answered; default: the thread's newest not from the user */
      answeringMessageId: id.optional(),
      to: z.array(address).max(MAX_RECIPIENTS),
      cc: z.array(address).max(MAX_RECIPIENTS).default([]),
      subject: z.string().max(998).default(""),
      needsSubject: z.boolean().default(false),
      /** what to say; empty answers what the thread needs */
      instruction: z.string().max(WRITING_ONE_OFF_MAX).default(""),
      /** words already in the body: what the author means to say */
      draft: z.string().max(100_000).optional(),
      /** the text being refined, for Regenerate-with-changes, "Shorter" and the like */
      previousDraft: z.string().max(100_000).optional(),
      attachments: z.array(z.string().max(300)).max(100).optional(),
      /** IANA name, from the renderer: a backend has no idea what day it is for the user */
      timezone: z.string().max(64).default("UTC"),
      /**
       * Plan 163: their own email with gaps to fill, not a draft to write: the text as the editor's blocks read, and the
       * gaps in it (in order, apart). Streams `aiFill` events, and the result has `fills`.
       */
      fill: z
        .object({
          text: z.string().max(BODY_READ_MAX),
          gaps: z.array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0) })).min(1).max(FILL_GAPS_MAX),
        })
        // i18n-ignore: a malformed request from our own renderer, refused at the boundary; never shown to the user
        .refine((f) => f.gaps.every((g, i) => g.from < g.to && g.to <= f.text.length && (i === 0 || f.gaps[i - 1]!.to <= g.from)), { message: "gaps must be in order, apart, and in the text" })
        .optional(),
    }),
    { timeoutMs: 300_000 },
  ),
  /**
   * Plan 163: what someone typed, read by the fast model when local rules can't tell: an instruction or the email, and
   * which of the spots that may be gaps are. Sends what they typed and nothing else.
   */
  "ai.readDraft": m<{ kind: "instruction" | "email"; gaps: number[] }>()(
    z.object({
      requestId,
      text: z.string().max(WRITING_ONE_OFF_MAX * 4),
      maybe: z.array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0) })).max(FILL_GAPS_MAX),
    }),
    { timeoutMs: 30_000 },
  ),
  /** Lets a session's snapshot go (the draft closed, the strip went). */
  "ai.composeEnd": m<{ ok: true }>()(z.object({ session: z.string().min(1).max(64) })),
  /**
   * Where a sentence's draft goes (§5). `waitForContacts`: call again with it after a `wait` decision: it answers
   * once the contact index is warm, so there's nothing to poll. Sends the instruction and matched names at most.
   */
  "ai.resolveIntent": m<AiIntentResult>()(
    z.object({
      requestId,
      instruction: z.string().max(WRITING_ONE_OFF_MAX),
      surface: z.discriminatedUnion("kind", [z.object({ kind: z.literal("thread"), threadId: id }), z.object({ kind: z.literal("list") }), z.object({ kind: z.literal("draft"), recipients: z.array(address).max(MAX_RECIPIENTS) })]),
      accountId: id.optional(),
      waitForContacts: z.boolean().optional(),
    }),
    { timeoutMs: 120_000 },
  ),
  /** The feature's settings opened: from here on the local learner may run. */
  "writing.activate": m<{ ok: true }>()(empty),
  "writing.prefs.get": m<WritingPrefs>()(empty),
  /** A patch: `account.prefs` null forgets that account's settings. */
  "writing.prefs.set": m<WritingPrefs>()(
    z.object({
      global: z.object({ enabled: z.boolean().optional(), instructions: writingInstructions.optional(), useSentMail: z.boolean().optional() }).optional(),
      account: z.object({ accountId: id, prefs: z.object({ prepareReplies: z.boolean().optional(), instructions: writingInstructions.optional(), useGeneral: z.boolean().optional(), useSentMail: z.boolean().optional() }).nullable() }).optional(),
    }),
  ),
  "writing.profiles.list": m<{ items: WritingProfileView[]; next: { scopeKey: string; language: string } | null; status: WritingStatus }>()(
    z.object({ scope: z.enum(["you", "account", "domain", "person"]).optional(), accountId: id.optional(), after: z.object({ scopeKey: scopeKeyParam, language: profileLanguage }).optional(), limit: z.number().int().min(1).max(200).default(100) }),
  ),
  /** Pins the profile: a later pass counts what's new and offers "Update" instead of overwriting. */
  "writing.profiles.edit": m<WritingProfileView>()(
    z.object({
      scopeKey: scopeKeyParam,
      language: profileLanguage.default(""),
      phrases: z.array(z.string().max(200)).max(40).optional(),
      /** greetings and sign-offs as typed, with their share of mail */
      greetings: z.array(z.object({ text: z.string().max(200), share: z.number().min(0).max(1) })).max(10).optional(),
      signOffs: z.array(z.object({ text: z.string().max(200), share: z.number().min(0).max(1) })).max(10).optional(),
      judgment: z.object({ traits: z.object({ formality: z.number().int().min(1).max(5), warmth: z.number().int().min(1).max(5), directness: z.number().int().min(1).max(5), detail: z.number().int().min(1).max(5), humor: z.number().int().min(0).max(2) }), notes: z.array(z.string().max(200)).max(8) }).nullable().optional(),
    }),
  ),
  /** Unpins and rebuilds it from mail. Plan 161: `undo` puts back exactly what went, through `writing.profiles.restore`, while this backend runs (a bounded few) */
  "writing.profiles.reset": m<{ ok: true; undo: string }>()(z.object({ scopeKey: scopeKeyParam, language: profileLanguage.optional() })),
  "writing.profiles.restore": m<{ ok: true; restored: boolean }>()(z.object({ undo: z.string().max(64) })),
  /** Counts again from mail, one account or all; nothing is overwritten that's pinned. */
  "writing.profiles.rebuild": m<{ ok: true }>()(z.object({ accountId: id.optional() })),
  /** Clear all: every profile, generation, study record and checkpoint; it sleeps until the feature is used again. */
  "writing.profiles.clear": m<{ ok: true }>()(empty),
  /**
   * "Study my style": the model step runs at once, in the background, through the limiter's `voice` task (`aiStudy`
   * events, cancellable with `ai.cancel`). No per-use consent (plan 131): the button's hint says what goes.
   */
  "writing.studyStyle": m<WritingStudyResult>()(z.object({ requestId }), { timeoutMs: 120_000 }),
  /** §8: model text went into a draft: its provenance from now until it's sent. False: that draft or generation is gone. */
  "writing.commitGeneration": m<{ ok: boolean }>()(z.object({ accountId: id, draftId: id, draftGeneration: z.string().max(64), address: z.string().max(320), text: z.string().max(GENERATION_TEXT_MAX) })),

  "identity.get": m<OwnerIdentity | null>()(empty),
  "identity.changeOwner": m<OwnerIdentity>()(z.object({ accountId: id, password: z.string().min(1).max(1000).optional() }), { timeoutMs: 300_000 }),

  /** The MCP endpoint: whether this host runs it, how many agents are connected, since when the token is valid. */
  "agents.status": m<{ available: boolean; connected: number; tokenSince: number | null }>()(empty),
  /** A new token in the token file; agents connected now are cut off and must read it again. */
  "agents.rotateToken": m<{ disconnected: number; tokenSince: number }>()(empty),

  "ops.recipientReceipts": m<{ opId: string; createdAt: number; count: number; parts: number; state: "pending" | "accepted"; retired: boolean; childOpId: string | null; sourceAvailable: boolean; outcomeUncertain: boolean }[]>()(z.object({ accountId: id })),
  "ops.recipientReceiptPart": m<string | null>()(z.object({ opId: z.string().uuid(), kind: z.enum(["envelope", "outcomes"]), index: z.number().int().min(0).max(3000) })),
  "ops.recoverRejectedRecipients": m<{ opId: string }>()(z.object({ opId: z.string().uuid() })),
  "ops.forgetRecipientReceipt": m<{ ok: true }>()(z.object({ opId: z.string().uuid() })),
  "ops.sentCopies": m<import("../send-copy").SentCopyInfo[]>()(z.object({ accountId: id })),
  "ops.repairSentCopy": m<{ copy: import("../send-copy").SentCopyState }>()(z.object({ opId: z.string().uuid() }), { timeoutMs: 120_000 }),
  "ops.forgetSentCopy": m<{ ok: true }>()(z.object({ opId: z.string().uuid() })),
  "ops.list": m<OpInfo[]>()(empty),
  "ops.resolveUnknown": m<{ ok: true }>()(
    z.object({ opId: z.string().uuid(), resolution: z.enum(["markSent", "retry", "discard"]) }),
  ),
  /**
   * Sync now. "user" ("Retry now", every account or one): the retry schedule starts over and ops
   * waiting for the network go. "focus" (a window regained focus): offline accounts only, at most
   * every 15 s (plan 20).
   */
  "sync.now": m<{ ok: true }>()(z.object({ accountId: id.optional(), reason: z.enum(["user", "focus"]).default("user") })),
  /** the web page's online/offline events (desktop's main tells the backend directly) */
  "sync.network": m<{ ok: true }>()(z.object({ online: z.boolean() })),

  /** plan 22: the icons for addresses on screen; an address missing from the answer is on its way (the `icons` event) */
  "icons.lookup": m<Record<string, IconAnswer>>()(z.object({ emails: z.array(z.string().max(320)).max(200) })),
  /** plan 22: icons' bytes as data: URLs (null: gone) */
  "icons.data": m<Record<string, string | null>>()(z.object({ ids: z.array(z.string().max(300)).max(50) })),
  /** plan 22: "Forget saved icons" */
  "icons.forget": m<{ ok: true }>()(empty),
  /** plan 22: photos from Google for a Gmail account, on (desktop: Google's consent in the browser) or off */
  // plan 74: `later` turns them on without a Google window now: they come with the account's next sign-in
  "icons.googlePhotos": m<AppSettings>()(z.object({ accountId: id, on: z.boolean(), later: z.boolean().optional() }), { timeoutMs: 300_000 }),
  /** plan 22, web: the token Google's consent gave for that account's photos (refused unless it opens the same mailbox) */
  "icons.authorizeGoogle": m<AppSettings>()(
    // plan 74 `ifPending`: a sign-in's consent counts only if the account still waits (not turned off meanwhile)
    z.object({ accountId: id, accessToken: z.string().min(1).max(4096), expiresIn: z.number().int().min(60).max(86_400), scope: z.string().max(2000), ifPending: z.boolean().optional() }),
    { timeoutMs: 120_000 },
  ),
} as const;

export type Contract = typeof contract;
export type MethodName = keyof Contract;
export type ParamsOf<M extends MethodName> = z.input<Contract[M]["params"]>;
export type ParsedParamsOf<M extends MethodName> = z.output<Contract[M]["params"]>;
export type ResultOf<M extends MethodName> = Contract[M]["__result"];

export interface Events {
  /** Data changed. threadIds empty + views true => refetch everything visible. */
  changed: { threadIds: number[]; views: boolean };
  counts: Counts;
  accounts: Account[];
  categories: Category[];
  /** plan 68: the folders of every account, when an account's list changed */
  folders: Folder[];
  /** plan 107: sent right before the `folders` its change produced: where a renamed folder went (the view and favorites follow) */
  foldersRenamed: FolderRename[];
  /** plan 107: the favorites below Starred, as the backend now keeps them, whenever it changed them (every window follows a newer revision) */
  favoriteFolders: FavoriteFoldersSnapshot;
  op: OpInfo;
  recipientReceiptRetired: { opId: string };
  owner: OwnerIdentity | null;
  /** progress of a scope action (threads.actScope / undoScope, categories.addScope), at most ~10 per second */
  bulkProgress: { jobId: string; done: number; total: number };
  /** drafts were added outside this window (an import, a scheduled send given back): reload them */
  drafts: { reason: "import" | "scheduled" };
  /** the engine filed new mail on its own (coalesced per category, at most every 30 s) */
  categorized: { categoryId: number; threadIds: number[]; by: "auto" };
  /** plan 22: icons that arrived for addresses asked about; `reset`: forget every icon (turned off, forgotten) */
  icons: { icons: Record<string, IconAnswer>; reset?: boolean };
  /** plan 41: important new mail, for a host that shows notifications from the page (the web; desktop main shows its own) */
  notify: MailNotice;
  /** plan 87: the reminders changed, or one came due */
  reminders: RemindersSnapshot;
  /** plan 94: the scheduled sends changed (scheduled, sent, failed) */
  scheduled: ScheduledSnapshot;
  /** plan 116: the forwards changed (made, cancelled, held, sent, failed) */
  forwards: import("../forwarding").ForwardSnapshot;
  /**
   * plan 103: a long sync's progress, at most every 2 s an account; null: it's over. Its own event (only the sync
   * card listens): the accounts event would re-render everything that reads accounts (the reader, the composer).
   * The account's syncState keeps the last one saved (at a chunk's end), for a window that opens meanwhile.
   */
  syncProgress: { accountId: number; progress: import("../types").SyncProgress | null };
  /** plan 132: a thread's summary is ready, for an open reader (only to the renderer and dev: never MCP) */
  aiSummary: { threadId: number };
  /** plan 142: what's active, for the windows; never MCP */
  followups: FollowupsSnapshot;
  /** plan 142: it stopped reading, or it's going again */
  followupsStatus: { blockedBy: { kind: AiErrorKind; message: string } | null };
  /** plan 145: the digest moved on: never MCP */
  todayDigest: { day: string };
  /** plan 144: a prepared reply as it comes, only to the windows reading that conversation; never MCP */
  aiReply: AiReplyEvent;
  /** plan 143: a preview's count as it grows, or why it ended; only to the connection that asked */
  aiAction: AiActionEvent;
  /** plan 141: an answer as it comes, only to the connection that asked */
  aiAsk: AiAskEvent;
  /** plan 141: these conversations went (all of them: null): no window keeps showing them */
  aiAskGone: { conversationIds: number[] | null };
  /** plan 133: a stream's text so far, only to the connection that asked: append it */
  aiCompose: AiComposeDelta;
  /** plan 163: one gap's fill so far, whole, and whether it's finished; only to the connection that asked */
  aiFill: AiFillDelta;
  /** plan 133: the style study's progress, only to the connection that asked */
  aiStudy: AiStudyProgress;
}
export type EventName = keyof Events;

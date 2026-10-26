import { LANGUAGE_SETTINGS, type LanguageSetting } from "@terno/i18n";
import { z } from "zod";
import {
  AI_PROVIDER_IDS,
  COMPATIBLE_PRESETS,
  type AiErrorKind,
  type AiProviderId,
  type Capabilities,
  type CompatiblePreset,
  type ModelInfo,
  type PresetDescriptor,
  type ProviderDescriptor,
} from "../ai";
import type { CategoryModelStats, Prediction, QuickActions } from "../categorize/bulk";
import type { I18nRef } from "./envelope";
import type { AutoCategorize } from "../categorize/policy";
import type { LearnedProposal } from "../learning/propose";
import { filterRuleSchema, type Filter, type FilterRule } from "../rules/schema";
import { LIST_FILTERS } from "../list-filter";
import { customThemesSchema, DESIGN_IDS, type CustomTheme, type DesignId, type MotionMs } from "../themes";
import {
  CATEGORY_COLORS,
  VIEWS,
  type Account,
  type Category,
  type Counts,
  type OpState,
  type ThreadDetail,
  type ThreadSummary,
} from "../types";

const id = z.number().int().positive();
const ids = z.array(id).min(1).max(5000);
const cursor = z.object({ lastDate: z.number(), id: z.number().int() });
/** a search cursor also names the query and the store revision it was minted at (older renderers send only the keyset) */
const searchCursor = cursor.extend({
  revision: z.object({ epoch: z.string().max(100), seq: z.number().int().min(0) }).optional(),
  queryKey: z.string().max(5000).optional(),
});
const address = z.object({ name: z.string().max(300), email: z.string().email().max(320) });
/** a draft keeps recipients as typed, unfinished ones too ("bob@"); addresses are validated when it is sent */
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
  provider: AiProviderId;
  model: string;
  baseURL: string | null;
  preset: CompatiblePreset | null;
  /** keys never cross to the renderer: only whether one is saved and its last 4 characters */
  hasKey: boolean;
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
}

export interface AppSettings {
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
  gmailClientId: string;
  /** a Google OAuth client secret is saved (never the secret itself) */
  gmailClientSecretSet: boolean;
  /** the saved client secret was sealed by Única and couldn't be moved: it has to be saved again */
  gmailClientSecretUnreadable: boolean;
  syncWindowDays: number;
  /** what the categorization engine may do with new mail */
  autoCategorize: AutoCategorize;
  /** let the configured AI suggest categories for mail the engine is unsure about (never auto-applies) */
  aiCategorize: boolean;
  /** anonymous error reports (builds with a DSN, outside local mode): ask each time, send, or never */
  errorReports: "ask" | "always" | "never";
  /** the UI language: follow the system, or a locale Terno ships (@terno/i18n LOCALES) */
  language: LanguageSetting;
  /** plan 18: ghost text while writing, learned from the user's sent mail on this device (recipients are always suggested) */
  composeSuggestions: boolean;
  /**
   * Plan 22: website icons for senders, loaded from each sender's own site. Unset it follows the
   * mode (on in connected mode, off in local mode); the user's choice sticks.
   */
  senderIcons: boolean;
  /** plan 22: Gmail accounts showing photos from Google, by account id (set through icons.googlePhotos, never settings.update) */
  googlePhotos: Record<string, GooglePhotoState>;
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
  counts: Counts;
  settings: AppSettings;
  owner: OwnerIdentity | null;
  /** demo builds have no owner (and say so) */
  demo: boolean;
  version: string;
}

/** What a browser mailbox can't afford to lose to storage eviction (re-syncable mail excluded), never a secret. */
/** A draft in an export (format 2): all of it; what it answers or forwards by Message-ID, which survives a re-sync. */
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
  quotedText: string;
  includeQuote: boolean;
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
  settings: AppSettings;
  drafts: ExportedDraft[];
  /** provider operations not yet done (sends included, with their message) */
  ops: { accountEmail: string | null; kind: string; state: string; createdAt: number; lastError: string | null; target: unknown; payload: unknown }[];
}

/** What app.import brought in (and what it left out, by name, with the reason). */
export interface ImportResult {
  categories: { added: number; merged: number };
  filters: { added: number; existing: number; skipped: string[] };
  drafts: number;
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
export interface Draft {
  id: number;
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
  quotedText: string;
  includeQuote: boolean;
  inReplyToMessageId: number | null;
  forwardOfMessageId: number | null;
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
  htmlMailAppearance: z.enum(["auto", "paper"]).optional(),
  customThemes: customThemesSchema.optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  layout: z.enum(["split", "list"]).optional(),
  remoteImages: z.enum(["ask", "always"]).optional(),
  ai: z
    .object({
      provider: z.enum(AI_PROVIDER_IDS).optional(),
      model: z.string().trim().max(200).optional(),
      baseURL: endpointUrl.nullable().optional(),
      preset: z.enum(COMPATIBLE_PRESETS).nullable().optional(),
    })
    .strict()
    .optional(),
  allowAgentSend: z.boolean().optional(),
  gmailClientId: z.string().max(300).optional(),
  syncWindowDays: z.number().int().min(7).max(3650).optional(),
  autoCategorize: z.enum(["off", "suggest", "auto"]).optional(),
  aiCategorize: z.boolean().optional(),
  errorReports: z.enum(["ask", "always", "never"]).optional(),
  language: z.enum(LANGUAGE_SETTINGS).optional(),
  composeSuggestions: z.boolean().optional(),
  senderIcons: z.boolean().optional(),
});
export type SettingsPatch = z.output<typeof settingsPatch>;
export { settingsPatch as settingsPatchSchema, draftAddress as draftAddressSchema };

/** What an import reads of each item; items are validated one by one on the backend, in time slices (a bad one is skipped). */
export const exportCategorySchema = z.object({ id, name: z.string().trim().min(1).max(60), color: z.enum(CATEGORY_COLORS), position: z.number().int().optional(), autoApply: z.boolean().optional() });
export const exportFilterSchema = z.object({ name: z.string().trim().min(1).max(120), enabled: z.boolean(), source: z.enum(["manual", "ai", "learned"]), rule: filterRuleSchema });
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
  quotedText: z.string().max(5_000_000).default(""),
  includeQuote: z.boolean().default(false),
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
});
export type ExportFile = z.output<typeof exportFile>;

const categorizeScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sender"), email: z.string().trim().email().max(320) }),
  z.object({ kind: z.literal("domain"), domain: z.string().trim().min(1).max(253) }),
  z.object({ kind: z.literal("list"), listId: z.string().trim().min(1).max(400) }),
  z.object({ kind: z.literal("query"), query: z.string().trim().min(1).max(500) }),
]);

/** Every thread of a view (account/category optional) or of a search: "select all N" acts on it on the backend. `filter`: the list's quick filter (`unreadOnly`: plan 12's name for "unread", still accepted). */
const threadScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view"), view: z.enum(VIEWS), accountId: id.optional(), categoryId: id.optional(), unreadOnly: z.boolean().optional(), filter: z.enum(LIST_FILTERS).optional() }),
  z.object({ kind: z.literal("search"), query: z.string().trim().min(1).max(2000), accountId: id.optional(), categoryId: id.optional(), unreadOnly: z.boolean().optional(), filter: z.enum(LIST_FILTERS).optional() }),
]);
export type ThreadScope = z.output<typeof threadScope>;

export const THREAD_ACTIONS = ["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar"] as const;
const jobId = z.string().min(1).max(64);

const imapServer = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1).max(320),
});

function m<R>() {
  return <P extends z.ZodType>(params: P, options: { timeoutMs?: number } = {}) => ({
    params,
    timeoutMs: options.timeoutMs,
    __result: undefined as unknown as R,
  });
}

const empty = z.object({}).strict();

export const contract = {
  "app.bootstrap": m<Bootstrap>()(empty),
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
      /** the unread filter: threads with something unread only (plan 12; `filter: "unread"` since plan 15) */
      unreadOnly: z.boolean().optional(),
      /** the quick filter: unread, with attachments or starred threads only */
      filter: z.enum(LIST_FILTERS).optional(),
      /** with a filter: the open and checked threads too, matching or not, while they are in the view (they stay put until the selection moves) */
      keepIds: z.array(id).max(500).optional(),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
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
  "threads.get": m<ThreadDetail>()(z.object({ threadId: id })),
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

  "categories.create": m<Category>()(
    z.object({ name: z.string().trim().min(1).max(60), color: z.enum(CATEGORY_COLORS) }),
  ),
  "categories.update": m<Category>()(
    z.object({
      id,
      name: z.string().trim().min(1).max(60).optional(),
      color: z.enum(CATEGORY_COLORS).optional(),
      position: z.number().int().min(0).optional(),
      autoApply: z.boolean().optional(),
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

  /** What the snackbar offers after filing: same sender / domain / list, distinguishing words, a filter draft. */
  "categorize.quickActions": m<QuickActions>()(z.object({ categoryId: id, threadIds: z.array(id).min(1).max(200) })),
  "categorize.count": m<{ count: number; capped: boolean }>()(z.object({ categoryId: id, scope: categorizeScope })),
  "categorize.preview": m<{ count: number; capped: boolean; sample: ThreadSummary[] }>()(
    z.object({ categoryId: id, scope: categorizeScope, limit: z.number().int().min(0).max(50).default(20) }),
  ),
  /** Files every thread in the scope (resolved once, then added in slices); undo with categorize.undo. */
  "categorize.apply": m<{ batchId: number | null; added: number }>()(z.object({ categoryId: id, scope: categorizeScope }), { timeoutMs: 120_000 }),
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
    }),
  ),
  "filters.delete": m<{ ok: true }>()(z.object({ id })),
  "filters.preview": m<{ count: number; sample: ThreadSummary[] }>()(
    z.object({ rule: filterRuleSchema, limit: z.number().int().min(0).max(100).default(20) }),
  ),
  "filters.apply": m<{ matchedMessages: number; affectedThreads: number }>()(
    z.object({ id }),
    { timeoutMs: 120_000 },
  ),
  "filters.generate": m<{ name: string; rule: FilterRule; explanation: string }>()(
    z.object({ prompt: z.string().trim().min(3).max(2000) }),
    { timeoutMs: 120_000 },
  ),

  "learning.proposals": m<LearnedProposal[]>()(empty),
  // name: the filter's name in the user's language (the backend has none; without it, English)
  "learning.accept": m<Filter>()(z.object({ key: z.string().max(400), name: z.string().trim().min(1).max(120).optional() })),
  "learning.dismiss": m<{ ok: true }>()(z.object({ key: z.string().max(400) })),

  "compose.send": m<{ opId: string; threadId: number }>()(
    z.object({
      accountId: id,
      to: z.array(address).min(1).max(200),
      cc: z.array(address).max(200).default([]),
      bcc: z.array(address).max(200).default([]),
      subject: z.string().max(998),
      // what was written, the signature and the quote (plan 16: an HTML alternative from the renderer only)
      bodyText: z.string().max(10_000_000),
      bodyHtml: z.string().max(25_000_000).optional(),
      inReplyToMessageId: id.optional(),
      forwardOfMessageId: id.optional(),
      draftId: id.optional(),
    }),
  ),
  /** null: the draft is gone (sent or discarded elsewhere). A stale baseRevision never overwrites: it saves a new draft. */
  "drafts.save": m<Draft | null>()(
    z.object({
      id: id.optional(),
      baseRevision: z.number().int().min(0).optional(),
      accountId: id,
      threadId: id.nullable().optional(),
      mode: z.enum(DRAFT_MODES).optional(),
      to: z.array(draftAddress).max(200).default([]),
      cc: z.array(draftAddress).max(200).default([]),
      bcc: z.array(draftAddress).max(200).default([]),
      subject: z.string().max(998).default(""),
      subjectEdited: z.boolean().optional(),
      bodyText: z.string().max(5_000_000).default(""),
      // plan 16: omitted = a plain draft (every save rewrites the body); only the renderer's is kept
      bodyHtml: z.string().max(20_000_000).default(""),
      quotedText: z.string().max(5_000_000).optional(),
      includeQuote: z.boolean().optional(),
      inReplyToMessageId: id.nullable().optional(),
      forwardOfMessageId: id.nullable().optional(),
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
  "drafts.delete": m<{ ok: true }>()(z.object({ id })),

  "accounts.addImap": m<Account>()(
    z.object({
      email: z.string().email(),
      displayName: z.string().trim().max(200),
      imap: imapServer,
      smtp: imapServer,
      password: z.string().min(1).max(1000),
      verify: z.boolean().default(true),
    }),
    { timeoutMs: 60_000 },
  ),
  "accounts.connectGmail": m<Account>()(empty, { timeoutMs: 300_000 }),
  /** web: an access token from Google's token model (the page signs in); connects the mailbox or renews its token */
  "accounts.connectGmailToken": m<Account>()(z.object({ accessToken: z.string().min(1).max(4096), expiresIn: z.number().int().min(60).max(86_400) }), { timeoutMs: 60_000 }),
  "accounts.update": m<Account>()(
    z.object({
      id,
      displayName: z.string().trim().min(1).max(200).optional(),
      color: z.enum(CATEGORY_COLORS).optional(),
      senderName: z.string().trim().max(200).optional(),
      signature: z.string().max(10_000).optional(),
      /** null: the general setting */
      syncWindowDays: z.number().int().min(7).max(3650).nullable().optional(),
    }),
  ),
  /**
   * Signs a connected mailbox in again (a revoked Gmail grant, a changed IMAP
   * password): Google for the same address, or the password verified with a
   * live login. Its waiting actions resume and it syncs.
   */
  "accounts.reconnect": m<Account>()(z.object({ id, password: z.string().min(1).max(1000).optional() }), { timeoutMs: 300_000 }),
  "accounts.remove": m<{ ok: true }>()(z.object({ id })),

  "settings.update": m<AppSettings>()(settingsPatch),
  "settings.setSecret": m<{ ok: true }>()(z.object({ name: z.enum(["gmailClientSecret"]), value: z.string().max(500) })),

  "ai.providers": m<{ providers: ProviderDescriptor[]; presets: PresetDescriptor[] }>()(empty),
  "ai.listModels": m<{ models: ModelInfo[]; tookMs: number }>()(aiTarget, { timeoutMs: 15_000 }),
  "ai.test": m<AiTestResult>()(aiTarget.extend({ model: z.string().trim().min(1).max(200) }), { timeoutMs: 120_000 }),
  /** Lets the saved key be sent to the provider's current endpoint (after the endpoint changed). */
  "ai.confirmKey": m<AppSettings>()(z.object({ provider: z.enum(AI_PROVIDER_IDS), preset: z.enum(COMPATIBLE_PRESETS).optional() })),
  "ai.setKey": m<AppSettings>()(
    z.object({ provider: z.enum(AI_PROVIDER_IDS), preset: z.enum(COMPATIBLE_PRESETS).optional(), value: z.string().trim().max(1000) }),
  ),

  "identity.get": m<OwnerIdentity | null>()(empty),
  "identity.changeOwner": m<OwnerIdentity>()(z.object({ accountId: id, password: z.string().min(1).max(1000).optional() }), { timeoutMs: 300_000 }),

  /** The MCP endpoint: whether this host runs it, how many agents are connected, since when the token is valid. */
  "agents.status": m<{ available: boolean; connected: number; tokenSince: number | null }>()(empty),
  /** A new token in the token file; agents connected now are cut off and must read it again. */
  "agents.rotateToken": m<{ disconnected: number; tokenSince: number }>()(empty),

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
  "icons.googlePhotos": m<AppSettings>()(z.object({ accountId: id, on: z.boolean() }), { timeoutMs: 300_000 }),
  /** plan 22, web: the token Google's consent gave for that account's photos (refused unless it opens the same mailbox) */
  "icons.authorizeGoogle": m<AppSettings>()(
    z.object({ accountId: id, accessToken: z.string().min(1).max(4096), expiresIn: z.number().int().min(60).max(86_400), scope: z.string().max(2000) }),
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
  op: OpInfo;
  owner: OwnerIdentity | null;
  /** progress of a scope action (threads.actScope / undoScope, categories.addScope), at most ~10 per second */
  bulkProgress: { jobId: string; done: number; total: number };
  /** drafts were added outside this window (an import): reload them */
  drafts: { reason: "import" };
  /** the engine filed new mail on its own (coalesced per category, at most every 30 s) */
  categorized: { categoryId: number; threadIds: number[]; by: "auto" };
  /** plan 22: icons that arrived for addresses asked about; `reset`: forget every icon (turned off, forgotten) */
  icons: { icons: Record<string, IconAnswer>; reset?: boolean };
}
export type EventName = keyof Events;

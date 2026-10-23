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
import type { LearnedProposal } from "../learning/propose";
import { filterRuleSchema, type Filter, type FilterRule } from "../rules/schema";
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
const address = z.object({ name: z.string().max(300), email: z.string().email().max(320) });

export interface ThreadPage {
  items: ThreadSummary[];
  nextCursor: { lastDate: number; id: number } | null;
}

export interface SearchPage extends ThreadPage {
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
  keyHint: string | null;
  /** the model runs on this Mac */
  local: boolean;
  capabilities: Capabilities | null;
  profiles: Partial<Record<AiProviderId, AiProfile>>;
}

export interface AppSettings {
  /** nothing leaves this Mac except mail with the user's own servers (and loopback AI) */
  localMode: boolean;
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  remoteImages: "ask" | "always";
  ai: AiSettings;
  allowAgentSend: boolean;
  gmailClientId: string;
  syncWindowDays: number;
}

/** The person this install belongs to (the future Única account). Verification evidence stays in the backend. */
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

export interface Bootstrap {
  accounts: Account[];
  categories: Category[];
  counts: Counts;
  settings: AppSettings;
  owner: OwnerIdentity | null;
  /** demo builds have no owner (and say so) */
  demo: boolean;
  version: string;
}

export interface CategorySuggestion {
  key: string;
  reason: "sender" | "list" | "domain";
  value: string;
  threads: ThreadSummary[];
  total: number;
}

export interface OpInfo {
  id: string;
  accountId: number;
  kind: string;
  state: OpState;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  summary: string;
}

export interface Draft {
  id: number;
  accountId: number;
  to: z.infer<typeof address>[];
  cc: z.infer<typeof address>[];
  subject: string;
  bodyText: string;
  inReplyToMessageId: number | null;
  updatedAt: number;
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  capabilities?: Capabilities;
  warning?: string;
  error?: { kind: AiErrorKind; message: string };
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
  density: z.enum(["comfortable", "compact"]).optional(),
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
});
export type SettingsPatch = z.output<typeof settingsPatch>;

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

  "threads.list": m<ThreadPage>()(
    z.object({
      view: z.enum(VIEWS),
      accountId: id.optional(),
      categoryId: id.optional(),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  ),
  "threads.search": m<SearchPage>()(
    z.object({
      query: z.string().max(2000),
      accountId: id.optional(),
      categoryId: id.optional(),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  ),
  "threads.get": m<ThreadDetail>()(z.object({ threadId: id })),
  "threads.act": m<{ affected: number }>()(
    z.object({
      threadIds: ids,
      action: z.enum(["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar"]),
    }),
  ),

  "categories.create": m<Category>()(
    z.object({ name: z.string().trim().min(1).max(60), color: z.enum(CATEGORY_COLORS) }),
  ),
  "categories.update": m<Category>()(
    z.object({
      id,
      name: z.string().trim().min(1).max(60).optional(),
      color: z.enum(CATEGORY_COLORS).optional(),
      position: z.number().int().min(0).optional(),
    }),
  ),
  "categories.delete": m<{ ok: true }>()(z.object({ id })),
  "categories.addThreads": m<{ added: number }>()(z.object({ categoryId: id, threadIds: ids })),
  "categories.removeThreads": m<{ removed: number }>()(
    z.object({ categoryId: id, threadIds: ids }),
  ),
  "categories.suggest": m<CategorySuggestion | null>()(
    z.object({ categoryId: id, threadId: id }),
  ),
  "categories.dismissSuggestion": m<{ ok: true }>()(z.object({ key: z.string().max(400) })),

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
  "learning.accept": m<Filter>()(z.object({ key: z.string().max(400) })),
  "learning.dismiss": m<{ ok: true }>()(z.object({ key: z.string().max(400) })),

  "compose.send": m<{ opId: string; threadId: number }>()(
    z.object({
      accountId: id,
      to: z.array(address).min(1).max(200),
      cc: z.array(address).max(200).default([]),
      bcc: z.array(address).max(200).default([]),
      subject: z.string().max(998),
      bodyText: z.string().max(5_000_000),
      inReplyToMessageId: id.optional(),
      forwardOfMessageId: id.optional(),
      draftId: id.optional(),
    }),
  ),
  "drafts.save": m<Draft>()(
    z.object({
      id: id.optional(),
      accountId: id,
      to: z.array(address).max(200).default([]),
      cc: z.array(address).max(200).default([]),
      subject: z.string().max(998).default(""),
      bodyText: z.string().max(5_000_000).default(""),
      inReplyToMessageId: id.optional(),
    }),
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
  "accounts.update": m<Account>()(
    z.object({ id, displayName: z.string().trim().max(200).optional(), color: z.string().max(40).optional() }),
  ),
  "accounts.remove": m<{ ok: true }>()(z.object({ id })),

  "settings.update": m<AppSettings>()(settingsPatch),
  "settings.setSecret": m<{ ok: true }>()(z.object({ name: z.enum(["gmailClientSecret"]), value: z.string().max(500) })),

  "ai.providers": m<{ providers: ProviderDescriptor[]; presets: PresetDescriptor[] }>()(empty),
  "ai.listModels": m<{ models: ModelInfo[]; tookMs: number }>()(aiTarget, { timeoutMs: 15_000 }),
  "ai.test": m<AiTestResult>()(aiTarget.extend({ model: z.string().trim().min(1).max(200) }), { timeoutMs: 120_000 }),
  "ai.setKey": m<AppSettings>()(
    z.object({ provider: z.enum(AI_PROVIDER_IDS), preset: z.enum(COMPATIBLE_PRESETS).optional(), value: z.string().trim().max(1000) }),
  ),

  "identity.get": m<OwnerIdentity | null>()(empty),
  "identity.changeOwner": m<OwnerIdentity>()(z.object({ accountId: id, password: z.string().min(1).max(1000).optional() }), { timeoutMs: 300_000 }),

  "ops.list": m<OpInfo[]>()(empty),
  "ops.resolveUnknown": m<{ ok: true }>()(
    z.object({ opId: z.string().uuid(), resolution: z.enum(["markSent", "retry", "discard"]) }),
  ),
  "sync.now": m<{ ok: true }>()(z.object({ accountId: id.optional() })),
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
}
export type EventName = keyof Events;

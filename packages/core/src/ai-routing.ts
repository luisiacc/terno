import {
  ASK_CLAUDE_MODEL,
  ASK_PLAN_CLAUDE_MODEL,
  ASK_PLAN_OPENAI_MODEL,
  DIGEST_CLAUDE_MODEL,
  DIGEST_OPENAI_MODEL,
  FILTER_CLAUDE_MODEL,
  FOLLOWUP_CLAUDE_MODEL,
  FOLLOWUP_OPENAI_MODEL,
  INTENT_CLAUDE_MODEL,
  JEV_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  OPENAI_DRAFT_MODEL,
  REPLY_CHECK_CLAUDE_MODEL,
  SUMMARY_CLAUDE_MODEL,
  SUMMARY_DEFAULT_MODEL,
  WRITING_CLAUDE_MODEL,
  type AiProviderId,
} from "./ai";
import type { AiSettings } from "./rpc/contract";

/**
 * Plan 168: every job `AiService.forTask` runs. `voice`, `intent` and `reply` are drafting's; `askPlan` is Ask's planner
 * (and actions'); `replyCheck` is Reply ready's check.
 */
export const AI_JOBS = ["summary", "writing", "voice", "intent", "reply", "replyCheck", "ask", "askPlan", "followup", "digest", "filter", "categorize"] as const;
export type AiJob = (typeof AI_JOBS)[number];

export interface AiRoute {
  provider: AiProviderId;
  model: string;
}

/** Claude and OpenAI are reached by key: Terno picks the model (plan 168). */
export type KeyedProvider = "anthropic" | "openai";
export const routedByKeys = (provider: AiProviderId): provider is KeyedProvider => provider === "anthropic" || provider === "openai";

/** Pro's routing, by job, on each provider (plan 168's table). */
const MODELS: Record<KeyedProvider, Record<AiJob, string>> = {
  anthropic: {
    summary: SUMMARY_CLAUDE_MODEL,
    writing: WRITING_CLAUDE_MODEL,
    voice: WRITING_CLAUDE_MODEL,
    reply: WRITING_CLAUDE_MODEL,
    intent: INTENT_CLAUDE_MODEL,
    replyCheck: REPLY_CHECK_CLAUDE_MODEL,
    ask: ASK_CLAUDE_MODEL,
    askPlan: ASK_PLAN_CLAUDE_MODEL,
    followup: FOLLOWUP_CLAUDE_MODEL,
    digest: DIGEST_CLAUDE_MODEL,
    filter: FILTER_CLAUDE_MODEL,
    categorize: FILTER_CLAUDE_MODEL,
  },
  openai: {
    summary: SUMMARY_DEFAULT_MODEL,
    writing: OPENAI_DRAFT_MODEL,
    voice: OPENAI_DRAFT_MODEL,
    reply: OPENAI_DRAFT_MODEL,
    intent: OPENAI_DEFAULT_MODEL,
    replyCheck: OPENAI_DEFAULT_MODEL,
    ask: OPENAI_DEFAULT_MODEL,
    askPlan: ASK_PLAN_OPENAI_MODEL,
    followup: FOLLOWUP_OPENAI_MODEL,
    digest: DIGEST_OPENAI_MODEL,
    filter: OPENAI_DEFAULT_MODEL,
    categorize: OPENAI_DEFAULT_MODEL,
  },
};

/**
 * The owner (plan 168): with both keys, Sonnet drafts and Luna does the small things: summaries, follow-ups, the digest,
 * Reply ready's check and reading a drafting instruction. Ask's planner isn't one: it never leaves the answer's provider
 * (plan 141 §6), so a question goes to one company. Filters and categories stay on Opus.
 */
const SMALL_JOBS: ReadonlySet<AiJob> = new Set(["summary", "followup", "digest", "replyCheck", "intent"]);

/** A saved key that can be sent: readable, and for the endpoint it would go to. One that can't leaves the job to the other key. */
const usable = (key: AiSettings["keys"][AiProviderId]): boolean => key?.hasKey === true && key.keyUnreadable !== true && key.keyConfirmed !== false;

/** What routing reads of the AI settings: never a task's old choice (plan 168: they're ignored). */
export type RouteFields = Pick<AiSettings, "provider" | "model"> & { keys?: AiSettings["keys"] };

/**
 * Plan 168: the one rule for what runs a job, read by the backend (`AiService.targetFor`), the core gates and Settings.
 *
 * - Claude or OpenAI configured: the saved keys decide, never a saved model. The small jobs (`SMALL_JOBS`) on OpenAI when
 *   it has a key, everything else on Claude when it has one; each on the other when only that one has a key. On OpenAI,
 *   drafting runs on Sol and the rest on Luna. Both keys is Pro.
 * - A local server or an OpenAI-compatible service: the configured provider and the model the user set, for every job:
 *   Terno can't know which models exist there.
 * - Categorizing on JEV whenever it has a key (plan 134). Null: nothing can run it.
 */
export function routeFor(job: AiJob, ai: RouteFields): AiRoute | null {
  if (job === "categorize" && usable(ai.keys?.jev)) return { provider: "jev", model: JEV_DEFAULT_MODEL };
  if (routedByKeys(ai.provider)) {
    const claude = usable(ai.keys?.anthropic);
    const openai = usable(ai.keys?.openai);
    if (!claude && !openai) return null;
    const provider: KeyedProvider = SMALL_JOBS.has(job) ? (openai ? "openai" : "anthropic") : claude ? "anthropic" : "openai";
    return { provider, model: MODELS[provider][job] };
  }
  if (ai.provider === "none" || ai.provider === "jev") return null;
  return { provider: ai.provider, model: ai.model };
}

/** A local server or a compatible service can run as it's set up: a model, its endpoint, and its key where it needs one (readable, for this endpoint). */
function configuredReady(ai: AiSettings): boolean {
  if (ai.provider === "none" || ai.keyUnreadable || !ai.model.trim()) return false;
  const preset = ai.preset ?? "custom";
  // custom and Azure have no endpoint of their own: they need the one saved
  if (ai.provider === "compatible" && !ai.baseURL && (!ai.preset || preset === "custom" || preset === "azure")) return false;
  return ai.provider !== "compatible" || preset === "custom" || (ai.hasKey && ai.keyConfirmed);
}

/** Plan 168: whether a job can run, by `routeFor` and the key it would use. The backend has the last word (an endpoint's policy). */
export function aiCanRun(job: AiJob, ai: AiSettings | null | undefined): boolean {
  if (!ai) return false;
  const route = routeFor(job, ai);
  if (!route) return false;
  // a keyed route is to a usable key already
  return route.provider === ai.provider && !routedByKeys(ai.provider) ? configuredReady(ai) : true;
}

/**
 * The AI can really run: drafting has somewhere to go. AI features are offered only then; otherwise they could only fail.
 * On keys every job goes to a provider with a key, so drafting's answer is every job's but categorizing's.
 */
export function aiReady(ai: AiSettings | null | undefined): ai is AiSettings {
  return aiCanRun("writing", ai);
}

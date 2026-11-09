import { AiError, ASK_PROMPT_VERSION, askBudget, answerPrompt, fitAskPrompt, fitPlanEarlier, type AiTasks, type AskMaterial } from "@terno/ai";
import {
  ASK_QUESTION_MAX,
  ASK_TURNS_MAX,
  askOperandsMissing,
  askSpecifics,
  hasUnlinkedSentence,
  askStreamText,
  languageName,
  questionLanguage,
  resolveCitations,
  validAskQueries,
  type AiAskResult,
  type AiErrorKind,
  type AskCheck,
  type AskOlderOffer,
  type AskPlanQuery,
  type AskSourceRef,
  type AskSourceView,
  type AskTurn,
  type AskTurnStatus,
  type ResolvedSearch,
} from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError, type ParsedParamsOf } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { ProviderQuery } from "@terno/mail";
import { ASK_MAX_CHARS, ASK_MESSAGES_MAX, type AskConversationCopy, type AskSource } from "@terno/store";
import { toRpcError } from "./ai-service";
import type { BackendCore as Backend } from "./core";
import { readSettings } from "./settings";
import { destinationOf, scrubbed } from "./voice-learner";

/**
 * Plan 141: from a question to an answer. At most 2 planning calls and 1 answer a question, plus 1 answer after a click
 * on Search older mail. What it sends is the question, then the text of the matching mail; older mail goes only to the
 * user's own servers, and only on a click. Nothing here, and nothing this file logs, carries mail: only kinds and counts.
 */

const THREADS_PER_QUERY = 40;
const EARLIER_TURNS = 3;
const EARLIER_ANSWER_CHARS = 1000;
const OLDER_LIMIT = 50;
/** Deletes kept for Undo, in memory: a restart ends them, as it does a snackbar. */
const UNDO_KEPT = 5;
const STREAM_EVERY_MS = 30;

type AskParams = ParsedParamsOf<"ai.ask">;
type OlderParams = ParsedParamsOf<"ai.askOlder">;

interface Asking {
  accounts: Set<number>;
  controller: AbortController;
  /** an account or conversation it depends on went: nothing it finishes is kept */
  dead: boolean;
  conversationId: number | null;
}

const dayIn = (ms: number, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
};

/** Up to what a provider's search can use of a plan: only real values, as Ask's own validation left them. */
function providerQueryOf(plan: AskPlanQuery, search: ResolvedSearch): ProviderQuery {
  return {
    terms: search.query.terms.filter((t) => t.field === "text").map((t) => t.value),
    ...(search.query.anyOf.length ? { anyOf: search.query.anyOf.map((g) => g.map((t) => t.value)) } : {}),
    ...(plan.from ? { from: plan.from } : {}),
    ...(plan.to ? { to: plan.to } : {}),
    ...(plan.subject ? { subject: plan.subject } : {}),
    ...(search.query.after !== undefined ? { after: search.query.after } : {}),
    ...(search.query.before !== undefined ? { before: search.query.before } : {}),
    ...(search.query.hasAttachment ? { hasAttachment: true } : {}),
  };
}

/** Text as it comes, sent at most every ~30 ms; `flush` is synchronous, so nothing can overtake the final answer. */
function coalescer(send: (text: string) => void): { push(text: string): void; flush(): void } {
  let held = "";
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!held) return;
    const text = held;
    held = "";
    last = performance.now();
    send(text);
  };
  return {
    flush,
    push(text) {
      held += text;
      const wait = STREAM_EVERY_MS - (performance.now() - last);
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
  };
}

/** Each message's words as the reader sees them, with a label to cite. */
function materialOf(messages: readonly AskSource[], timezone: string): { material: AskMaterial[]; labels: Map<string, number> } {
  const labels = new Map<string, number>();
  const material = messages.map((m, i) => {
    const label = `m${i + 1}`;
    labels.set(label, i);
    return { label, from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail, date: dayIn(m.date, timezone), subject: m.subject, own: m.own, text: m.text };
  });
  return { material, labels };
}

const refOf = (m: AskSource): AskSourceRef => ({ messageId: m.messageId, threadId: m.threadId, accountId: m.accountId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, date: m.date });

/** What a turn's words may honestly come from: the text sent, and each message's own header. */
const authorized = (material: readonly AskMaterial[]): string[] => material.flatMap((m) => [m.text, m.from, m.subject, m.date]);

export class AskService {
  private readonly asking = new Set<Asking>();
  private readonly undo = new Map<number, AskConversationCopy>();

  constructor(private readonly b: Backend) {}

  private underWay(accounts: Iterable<number>, conversationId: number | null): Asking {
    const entry: Asking = { accounts: new Set(accounts), controller: new AbortController(), dead: false, conversationId };
    this.asking.add(entry);
    return entry;
  }

  /** Where the answer goes: checked again before anything is sent, so a provider changed meanwhile gets nothing (revision 2). */
  async target(): Promise<{ ai: AiTasks; planner: AiTasks; destination: string }> {
    const ai = await this.b.aiService.forTask("ask", { foreground: true });
    const planner = await this.b.aiService.forTask("askPlan", { foreground: true });
    const destination = destinationOf(ai);
    // i18n-ignore: our own bug if it happens: planning and answering are one destination
    if (destinationOf(planner) !== destination) throw new AiError("Planning and answering must go to one place", "blocked");
    return { ai, planner, destination };
  }

  /** Before each dispatch: Settings may have moved since the last one. */
  private async stillThere(destination: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    const now = await this.b.aiService.forTask("ask", { foreground: true });
    if (destinationOf(now) !== destination) throw new AiError(L("errors.ai.cancelled"), "cancelled");
  }

  /** The local search: up to 40 threads a query, merged by reciprocal rank with a small lift for what's recent. */
  private async search(searches: readonly ResolvedSearch[], entry: Asking): Promise<number[]> {
    const score = new Map<number, number>();
    const now = this.b.now();
    for (const search of searches) {
      const page = await this.b.store.threads.search({ search, limit: THREADS_PER_QUERY });
      page.items.forEach((t, rank) => {
        // from here on it depends on that account: before anything of its mail is read or sent
        entry.accounts.add(t.accountId);
        const ageDays = Math.max(0, now - t.lastDate) / 86_400_000;
        score.set(t.id, (score.get(t.id) ?? 0) + 1 / (60 + rank) + 0.002 * Math.exp(-ageDays / 365));
      });
    }
    return [...score.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([id]) => id);
  }

  async ask(p: AskParams, clientId: string): Promise<AiAskResult> {
    const { store } = this.b;
    const { signal: asked, release } = this.b.aiService.begin(p.requestId, clientId);
    // before anything it writes was read: a clear after this point makes the write refuse itself
    const clearGeneration = store.ask.history.clearGeneration();
    const question = p.question.trim().slice(0, ASK_QUESTION_MAX);
    const entry = this.underWay([], p.conversationId ?? null);
    const signal = AbortSignal.any([asked, entry.controller.signal]);
    try {
      const settings = await readSettings(store);
      if (!settings.ask.enabled) throw new AiError(L("errors.ai.askOff"), "not_configured");
      const { ai, planner, destination } = await this.target();
      let earlier: { question: string; answer: string }[] = [];
      let before: string[] = [];
      if (p.conversationId !== undefined) {
        const count = await store.ask.history.turnCount(p.conversationId);
        if (count === null) throw new RpcError("NOT_FOUND", L("errors.ai.askGone"));
        if (count >= ASK_TURNS_MAX) throw new RpcError("BAD_REQUEST", L("errors.ai.askTooLong"));
        for (const id of await store.ask.history.accountsOf(p.conversationId)) entry.accounts.add(id);
        const turns = await store.ask.history.turns(p.conversationId);
        earlier = turns.slice(-EARLIER_TURNS).map((t) => ({ question: t.question, answer: (t.answer ?? "").slice(0, EARLIER_ANSWER_CHARS) }));
        before = turns.map((t) => t.question);
      }
      const now = this.b.now();
      const today = dayIn(now, p.timezone);
      const planInput = {
        question,
        today,
        timezone: p.timezone,
        accounts: (await store.accounts.list()).map((a) => ({ name: a.displayName, address: a.email })),
        categories: (await store.categories.list()).map((c) => c.name),
        ...(earlier.length ? { earlier: fitPlanEarlier(earlier, planner.contextTokens) } : {}),
      };
      await this.stillThere(destination, signal);
      this.b.server.emitTo(clientId, "aiAsk", { requestId: p.requestId, phase: "searching" });
      let queries: AskPlanQuery[] = [];
      let text = "";
      const write = (status: AskTurnStatus, body: { answer: string | null; sources: readonly AskSourceRef[]; checks: AskCheck }) =>
        this.keep({ conversationId: p.conversationId ?? null, question, status, queries, ai, clearGeneration, entry, ...body });
      try {
        const plan = await planner.planAsk(planInput, signal);
        // plan 143: nothing ran and nothing's kept: the sentence's own planning and preview take it from here
        if (plan.kind === "command") return { status: "command" };
        let valid = validAskQueries(plan.queries, now);
        queries = valid.map((v) => v.plan);
        if (!valid.length) {
          const turn = await write("failed", { answer: null, sources: [], checks: { unlinked: false, unsupported: [] } });
          return { status: "failed", turn, error: { kind: "invalid_output", message: L("errors.ai.askNoPlan").message, i18n: { key: "errors.ai.askNoPlan" } }, older: await this.offer(valid.map((v) => v.plan), now) };
        }
        let threadIds = await this.search(valid.map((v) => v.search), entry);
        if (!threadIds.length) {
          // one more plan, told it found nothing: at most two before an answer
          await this.stillThere(destination, signal);
          const wider = validAskQueries((await planner.planAsk({ ...planInput, foundNothing: queries }, signal)).queries, now);
          if (wider.length) {
            valid = wider;
            queries = wider.map((v) => v.plan);
            threadIds = await this.search(valid.map((v) => v.search), entry);
          }
        }
        if (!threadIds.length) {
          const turn = await write("not_found", { answer: null, sources: [], checks: { unlinked: false, unsupported: [] } });
          return { status: "done", turn, incomplete: false, older: await this.offer(queries, now) };
        }
        return await this.answer({ p, clientId, signal, ai, destination, entry, threadIds, searches: valid.map((v) => v.search), first: [], earlier, before, today, question, queries, clearGeneration, onText: (t) => (text = t), older: () => this.offer(queries, now) });
      } catch (error) {
        return await this.failed(error, { signal, entry, text, write, ai, queries, now });
      }
    } catch (error) {
      if (!(error instanceof RpcError || error instanceof AiError)) captureError(scrubbed(error), { code: "ai.failed" });
      throw toRpcError(error instanceof RpcError || error instanceof AiError ? error : new AiError(L("errors.ai.askFailed"), "unavailable"));
    } finally {
      this.asking.delete(entry);
      release();
    }
  }

  /** A stop keeps what's written so far, as `stopped`; one with nothing yet writes nothing. A failure is kept, with its kind. */
  private async failed(error: unknown, o: { signal: AbortSignal; entry: Asking; text: string; write: (status: AskTurnStatus, body: { answer: string | null; sources: readonly AskSourceRef[]; checks: AskCheck }) => Promise<AskTurn | null>; ai: AiTasks; queries: AskPlanQuery[]; now: number }): Promise<AiAskResult> {
    const clean: AiError | RpcError = error instanceof RpcError || error instanceof AiError ? error : (captureError(scrubbed(error), { code: "ai.failed" }), new AiError(L("errors.ai.askFailed"), "unavailable"));
    if (o.signal.aborted || (clean instanceof AiError && clean.kind === "cancelled")) {
      if (o.text && !o.entry.dead) {
        const turn = await o.write("stopped", { answer: o.text, sources: [], checks: { unlinked: true, unsupported: [] } });
        if (turn) return { status: "done", turn, incomplete: false, older: await this.offer(o.queries, o.now) };
      }
      throw new AiError(L("errors.ai.cancelled"), "cancelled");
    }
    if (clean instanceof RpcError) throw clean;
    const turn = o.entry.dead ? null : await o.write("failed", { answer: o.text || null, sources: [], checks: { unlinked: false, unsupported: [] } });
    return { status: "failed", turn, error: { kind: clean.kind as AiErrorKind, message: clean.message, ...(clean.i18n ? { i18n: clean.i18n } : {}) }, older: { kind: "none" } };
  }

  /**
   * What the answer is written in, named outright: this question's language; when it doesn't say ("Isabella?"), the
   * newest question before it in the conversation that does, however far back (`before`, oldest first); else the app's.
   * Read here, with no model: a model told only "the question's language" answers an English question in Spanish when
   * the mail is Spanish.
   */
  private async answerLanguage(question: string, before: readonly string[]): Promise<string> {
    const asked = [question, ...[...before].reverse()].map(questionLanguage).find(Boolean);
    const code = asked || (await this.b.summaries.readerLanguage());
    return languageName(code) ?? code;
  }

  /** From passages to a checked, kept answer. */
  private async answer(o: {
    p: { requestId: string; conversationId?: number; timezone: string };
    clientId: string;
    signal: AbortSignal;
    ai: AiTasks;
    destination: string;
    entry: Asking;
    threadIds: readonly number[];
    searches: readonly ResolvedSearch[];
    first: readonly number[];
    earlier: readonly { question: string; answer: string }[];
    /** every question before this one in its conversation, oldest first */
    before: readonly string[];
    today: string;
    question: string;
    queries: AskPlanQuery[];
    clearGeneration: number;
    onText: (text: string) => void;
    older: () => Promise<AskOlderOffer>;
    /** this answer is a new one on the turn a question already has: a follow-up can't take the place */
    conversationIdOverride?: number;
  }): Promise<AiAskResult> {
    const { store } = this.b;
    const { ai, signal, question, today, earlier } = o;
    const language = await this.answerLanguage(question, o.before);
    const fixedChars = answerPrompt({ question, language, today, material: [], earlier }).length;
    const budget = askBudget(ai.contextTokens, fixedChars);
    const passages = await store.ask.passages({ threadIds: o.threadIds, queries: o.searches, first: o.first, maxMessages: Math.min(ASK_MESSAGES_MAX, budget.maxMessages), maxChars: Math.min(ASK_MAX_CHARS, budget.passageChars), signal });
    if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    for (const m of passages.messages) o.entry.accounts.add(m.accountId);
    const drafted = materialOf(passages.messages, o.p.timezone);
    // threads the page didn't reach count too
    const moreMatch = passages.omitted === true || o.threadIds.length > new Set(passages.messages.map((m) => m.threadId)).size;
    const fitted = fitAskPrompt({ question, language, today, material: drafted.material, earlier, moreMatch }, budget.promptChars);
    if (!fitted) throw new AiError(L("errors.ai.askTooSmall"), "unsupported");
    const { material } = fitted;
    const labels = new Map(material.map((m, i) => [m.label, i]));
    const conversationId = o.conversationIdOverride ?? o.p.conversationId ?? null;
    const empty = { unlinked: false, unsupported: [] };
    if (!material.length) {
      const turn = await this.keep({ conversationId, question, status: "not_found", answer: null, sources: [], checks: empty, queries: o.queries, ai, clearGeneration: o.clearGeneration, entry: o.entry });
      return { status: "done", turn, incomplete: passages.incomplete, older: await o.older() };
    }
    await this.stillThere(o.destination, signal);
    const emit = coalescer((text) => this.b.server.emitTo(o.clientId, "aiAsk", { requestId: o.p.requestId, text }));
    let raw = "";
    let sent = "";
    const result = await ai.answerFromMail(
      { question, language, today, material, found: { count: o.threadIds.length, capped: o.threadIds.length >= THREADS_PER_QUERY }, moreMatch: moreMatch || fitted.material.length < drafted.material.length, ...(fitted.earlier.length ? { earlier: fitted.earlier } : {}) },
      {
        signal,
        maxTokens: budget.outputTokens,
        effort: "low",
        onDelta: (delta) => {
          // a late answer after a stop isn't what was stopped at
          if (signal.aborted) return;
          raw += delta;
          // a citation still arriving waits for its end
          const shown = askStreamText(raw, labels);
          o.onText(shown);
          if (shown.length > sent.length) {
            emit.push(shown.slice(sent.length));
            sent = shown;
          }
        },
      },
    );
    emit.flush();
    if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    const resolved = resolveCitations(result.text, labels);
    const answered = result.status === "not_found" ? "not_found" : result.status === "partial" || result.stop === "length" ? "partial" : "answered";
    const checks: AskCheck = { unlinked: answered !== "not_found" && (resolved.dropped > 0 || hasUnlinkedSentence(resolved.text)), unsupported: answered === "not_found" ? [] : [...askSpecifics(resolved.text, [...authorized(material), String(o.threadIds.length), ...result.calculations.map((c) => c.result)]), ...askOperandsMissing(result.calculations.flatMap((c) => c.operands), authorized(material))] };
    // a count's messages are its sources, cited in words or not
    const counted = result.calculations.flatMap((c) => c.labels).flatMap((label) => labels.get(label) ?? []);
    const sources = answered === "not_found" ? [] : [...new Set([...resolved.cited, ...counted])].map((i) => refOf(passages.messages[i]!));
    // with no sources, a citation left in the words points at nothing
    const words = answered === "not_found" ? resolved.text.replace(/\s*\[\d+\]/g, "") : resolved.text;
    const turn = await this.keep({ conversationId, question, status: answered, answer: words, sources, checks, queries: o.queries, ai, clearGeneration: o.clearGeneration, entry: o.entry });
    return { status: "done", turn, incomplete: passages.incomplete, older: await o.older() };
  }

  /** Written only while nothing it depends on went: null when it was deleted, cleared or its account removed. */
  private async keep(o: { conversationId: number | null; question: string; status: AskTurnStatus; answer: string | null; sources: readonly AskSourceRef[]; checks: AskCheck; queries: AskPlanQuery[]; ai: AiTasks; clearGeneration: number; entry: Asking }): Promise<AskTurn | null> {
    if (o.entry.dead) return null;
    const { store } = this.b;
    const now = this.b.now();
    const written = await store.ask.history.add({ conversationId: o.conversationId, kind: "question", question: o.question, answer: o.answer, status: o.status, sources: o.sources, queries: o.queries, checks: o.checks, accountIds: [...o.entry.accounts], model: o.ai.model, provider: o.ai.providerId, promptVersion: ASK_PROMPT_VERSION, now, clearGeneration: o.clearGeneration });
    if (!written) return null;
    o.entry.conversationId = written.conversationId;
    return (await store.ask.history.turns(written.conversationId)).find((t) => t.id === written.turnId) ?? null;
  }

  /**
   * Whether older mail is worth offering (revision 8). There's no "all" window: an account's coverage is what its window
   * reached once its first sync is done. A pending backfill says it's still downloading; an empty result never counts.
   */
  private async offer(queries: readonly AskPlanQuery[], now: number): Promise<AskOlderOffer> {
    const { store } = this.b;
    const accounts = await store.accounts.list();
    if (!accounts.length) return { kind: "none" };
    if (accounts.some((a) => (a.backfillSince ?? null) !== null)) return { kind: "downloading" };
    const general = (await readSettings(store)).syncWindowDays;
    const covered = accounts.map((a) => (a.syncState.lastSyncAt === null ? now : now - (a.syncWindowDays ?? general) * 86_400_000));
    const since = Math.min(...covered);
    const valid = validAskQueries([...queries], now);
    const after = valid.length && valid.every((v) => v.search.query.after !== undefined) ? Math.min(...valid.map((v) => v.search.query.after!)) : null;
    // the question only asks about a time this Mac already holds in full
    if (after !== null && covered.every((start) => after >= start)) return { kind: "none" };
    if (!this.b.connectivity.online) return { kind: "offline", since };
    return { kind: "offer", since };
  }

  /** Plan 141 §3: on a click, the user's own servers look further back; what they find is kept as normal mail. */
  async older(p: OlderParams, clientId: string): Promise<AiAskResult> {
    const { store } = this.b;
    const { signal: asked, release } = this.b.aiService.begin(p.requestId, clientId);
    const clearGeneration = store.ask.history.clearGeneration();
    const entry = this.underWay(await store.ask.history.accountsOf(p.conversationId), p.conversationId);
    const signal = AbortSignal.any([asked, entry.controller.signal]);
    let text = "";
    try {
      const turns = await store.ask.history.turns(p.conversationId);
      const turn = turns.find((t) => t.id === p.turnId);
      if (!turn) throw new RpcError("NOT_FOUND", L("errors.ai.askGone"));
      if (turns.length >= ASK_TURNS_MAX) throw new RpcError("BAD_REQUEST", L("errors.ai.askTooLong"));
      const settings = await readSettings(store);
      if (!settings.ask.enabled) throw new AiError(L("errors.ai.askOff"), "not_configured");
      const { ai, destination } = await this.target();
      const now = this.b.now();
      const valid = validAskQueries(turn.queries, now);
      if (!valid.length) throw new AiError(L("errors.ai.askNoPlan"), "invalid_output");
      const progress = (done: number, total: number) => this.b.server.emitTo(clientId, "aiAsk", { requestId: p.requestId, older: { done, total } });
      const fetched = await this.fetchOlder(valid.map((v) => providerQueryOf(v.plan, v.search)), entry, signal, progress);
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      const threadIds = await this.search(valid.map((v) => v.search), entry);
      const earlier = turns.slice(-EARLIER_TURNS).filter((t) => t.id !== turn.id).map((t) => ({ question: t.question, answer: (t.answer ?? "").slice(0, EARLIER_ANSWER_CHARS) }));
      // the questions asked before this one: its language may be theirs, however far back
      const before = turns.slice(0, turns.indexOf(turn)).map((t) => t.question);
      if (!threadIds.length && !fetched.ids.length) {
        const kept = await this.keep({ conversationId: p.conversationId, question: turn.question, status: "not_found", answer: null, sources: [], checks: { unlinked: false, unsupported: [] }, queries: turn.queries, ai, clearGeneration, entry });
        return { status: "done", turn: kept, incomplete: false, older: { kind: "none" }, olderFound: 0, olderPartial: fetched.partial };
      }
      const answer = await this.answer({ p: { requestId: p.requestId, conversationId: p.conversationId, timezone: p.timezone }, clientId, signal, ai, destination, entry, threadIds, searches: valid.map((v) => v.search), first: fetched.ids, earlier, before, today: dayIn(now, p.timezone), question: turn.question, queries: turn.queries, clearGeneration, onText: (t) => (text = t), older: async () => ({ kind: "none" }) });
      return answer.status === "done" ? { ...answer, olderFound: fetched.ids.length, olderPartial: fetched.partial } : answer;
    } catch (error) {
      if (signal.aborted || (error instanceof AiError && error.kind === "cancelled")) {
        if (text && !entry.dead) {
          const ai = await this.b.aiService.forTask("ask", { foreground: true }).catch(() => null);
          const turn = ai && (await this.keep({ conversationId: p.conversationId, question: (await store.ask.history.turns(p.conversationId)).find((t) => t.id === p.turnId)?.question ?? "", status: "stopped", answer: text, sources: [], checks: { unlinked: true, unsupported: [] }, queries: [], ai, clearGeneration, entry }));
          if (turn) return { status: "done", turn, incomplete: false, older: { kind: "none" } };
        }
        throw toRpcError(new AiError(L("errors.ai.cancelled"), "cancelled"));
      }
      if (!(error instanceof RpcError || error instanceof AiError)) captureError(scrubbed(error), { code: "ai.failed" });
      throw toRpcError(error instanceof RpcError || error instanceof AiError ? error : new AiError(L("errors.ai.askFailed"), "unavailable"));
    } finally {
      this.asking.delete(entry);
      release();
    }
  }

  /** Each account in its own slot, one at a time; the newest 50 across them; `partial` when a server's search stopped short. */
  private async fetchOlder(queries: ProviderQuery[], entry: Asking, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<{ ids: number[]; partial: boolean }> {
    const { store } = this.b;
    const accounts = await store.accounts.list();
    const general = (await readSettings(store)).syncWindowDays;
    const now = this.b.now();
    let partial = false;
    const found: { accountId: number; hit: import("@terno/mail").ProviderHit }[] = [];
    for (const account of accounts) {
      if (signal.aborted) break;
      const before = now - (account.syncWindowDays ?? general) * 86_400_000;
      // nothing older than this account's window can match what the plan's dates allow
      if (queries.every((q) => q.after !== undefined && q.after >= before)) continue;
      try {
        const r = await this.b.runForAccount(account.id, (provider) => provider.search?.({ queries, before, limit: OLDER_LIMIT, signal }) ?? Promise.resolve({ hits: [], partial: false }));
        partial ||= r.partial;
        for (const hit of r.hits) found.push({ accountId: account.id, hit });
      } catch (error) {
        if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
        // one server's failure doesn't lose what the others have: it's said, as what wasn't searched
        partial = true;
        this.b.log("info", "ask: a server's search failed", { error: error instanceof Error ? error.name : "error" });
      }
    }
    const newest = found.sort((a, b) => b.hit.date - a.hit.date).slice(0, OLDER_LIMIT);
    progress(0, newest.length);
    const ids: number[] = [];
    let done = 0;
    for (const account of accounts) {
      const hits = newest.filter((h) => h.accountId === account.id).map((h) => h.hit);
      if (!hits.length) continue;
      entry.accounts.add(account.id);
      if (signal.aborted) break;
      try {
        await this.b.fetchHitsForAccount(account.id, hits, signal, (inserted) => {
          ids.push(...inserted);
          done += inserted.length;
          progress(Math.min(done, newest.length), newest.length);
        });
      } catch (error) {
        if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
        partial = true;
        this.b.log("info", "ask: a server's mail couldn't be fetched", { error: error instanceof Error ? error.name : "error" });
      }
    }
    return { ids: [...new Set(ids)], partial };
  }

  // ─── §5: Previous AI questions ───────────────────────────────────────────

  history() {
    return this.b.store.ask.history.list();
  }

  /** A saved conversation: no request. Each source is looked up as it's shown, since the mail may have gone or moved. */
  async conversation(conversationId: number): Promise<{ turns: AskTurn[]; sources: Record<number, AskSourceView>; older: AskOlderOffer } | null> {
    const { store } = this.b;
    const count = await store.ask.history.turnCount(conversationId);
    if (count === null) return null;
    const turns = await store.ask.history.turns(conversationId);
    const last = turns.at(-1);
    return { turns, sources: await this.sourceViews(turns.flatMap((t) => t.sources.map((s) => s.messageId))), older: last && last.queries.length ? await this.offer(last.queries, this.b.now()) : { kind: "none" } };
  }

  async sourceViews(ids: readonly number[]): Promise<Record<number, AskSourceView>> {
    const states = await this.b.store.ask.sourceStates(ids);
    return Object.fromEntries(ids.map((id) => [id, states.get(id) ?? { state: "gone" as const }]));
  }

  async remove(conversationId: number): Promise<void> {
    for (const entry of this.asking) {
      if (entry.conversationId !== conversationId) continue;
      entry.dead = true;
      entry.controller.abort();
    }
    const copy = await this.b.store.ask.history.remove(conversationId);
    if (!copy) return;
    this.undo.set(conversationId, copy);
    while (this.undo.size > UNDO_KEPT) this.undo.delete(this.undo.keys().next().value!);
    this.gone([conversationId]);
  }

  async restore(conversationId: number): Promise<void> {
    const copy = this.undo.get(conversationId);
    if (!copy) return;
    this.undo.delete(conversationId);
    await this.b.store.ask.history.restore(copy);
  }

  /** Settings → Storage → Clear AI data: nothing in flight may bring back what was just cleared. */
  async clear(): Promise<void> {
    for (const entry of this.asking) {
      entry.dead = true;
      entry.controller.abort();
    }
    this.undo.clear();
    await this.b.store.ask.history.clear();
    this.gone(null);
  }

  /** Its answers quote that mail: what drew on it goes, and what's asking on it stops (revision 3). */
  async accountRemoved(accountId: number): Promise<void> {
    for (const entry of this.asking) {
      if (!entry.accounts.has(accountId)) continue;
      entry.dead = true;
      entry.controller.abort();
    }
    for (const [id, copy] of this.undo) if (copy.rows.some((r) => (JSON.parse(r.account_ids_json ?? "[]") as number[]).includes(accountId))) this.undo.delete(id);
    this.gone(await this.b.store.ask.history.removeForAccount(accountId));
  }

  /** Every window, never MCP: nothing shown outlives what it quotes. */
  private gone(conversationIds: number[] | null): void {
    if (conversationIds === null || conversationIds.length) this.b.server.emit("aiAskGone", { conversationIds }, { origins: ["renderer", "dev"] });
  }

  /** It went off: what's running stops. */
  settingsChanged(enabled: boolean): void {
    if (enabled) return;
    for (const entry of this.asking) entry.controller.abort();
  }
}


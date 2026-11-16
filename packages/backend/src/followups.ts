import { AiError, FOLLOWUP_ANSWERING_CHARS, FOLLOWUP_OPEN_MAX, FOLLOWUP_OWN_CHARS, FOLLOWUP_PROMPT_VERSION, FOLLOWUP_REQUESTS_MAX, fitSentMail, followupBudget, costAt, priceOf, type AiTasks, type SentMailResult } from "@terno/ai";
import { ANSWERED_KINDS, automatedLevel, byUrgency, followupDue, NUDGE_DEFAULT, followupWakeAt, normalizeText, promiseOver, readCorpus, refKey, SCAN_DAYS, SCAN_MESSAGES_MAX, SCAN_PROMISE_OVERDUE_MS, SCAN_WAIT_STALE_MS, validFollowupDate, withNeeds, withoutQuotes, followupNotice, type AiErrorKind, type DatedRow, type FollowupRow, type FollowupsSnapshot, type MailNotice, type ThreadSummary } from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError, type AppSettings } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, L, type LocaleId } from "@terno/i18n";
import { AWAITING_ITEM, HELD_REQUEST_CLOSED, type FollowupFinish, type FollowupSnapshot, type FollowupSource, type FollowupWrite, type MailStore, type SentMark } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { UI_LOCALE_KEY } from "./forwarding";
import { contextOf, plainEvidence, sentencesOf } from "./dated-evidence";
import { promiseMoment } from "./promise-time";

const MAX_DELAY = 2 ** 31 - 1;
const PAGE = 50;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60_000;
/** one that came due longer ago than this (Terno was closed for days) is on the Inbox's top, not announced */
const NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 1000;
const UNDO_KEPT = 50;
/** what a message costs to read, for the offer's estimate: ~600 tokens in, ~150 out */
const SCAN_TOKENS = { inputTokens: 600, outputTokens: 150 };

export interface FollowupHost {
  readonly store: MailStore;
  now(): number;
  settings(): Promise<AppSettings>;
  forTask(): Promise<AiTasks>;
  /** a request a change of provider aborts */
  begin(requestId: string, clientId: string): { signal: AbortSignal; release: () => void };
  /** the account's own switch */
  accountWanted(accountId: number): Promise<boolean>;
  signature(accountId: number): Promise<string>;
  templated(accountId: number): Promise<ReadonlySet<number>>;
  emit(snapshot: FollowupsSnapshot): void;
  /** why it stopped reading, or that it's going again: to Settings, while it's open */
  statusChanged(status: { blockedBy: { kind: AiErrorKind; message: string } | null }): void;
  notify(notice: MailNotice): void;
  summaries(threadIds: readonly number[]): Promise<ThreadSummary[]>;
  /**
   * Plan 210 (iteration 3): the dated reader is on, running, and still has mail of this conversation from before then to
   * read: a reply waits for it, so its verdict is on the requests that mail makes
   */
  datedPending(threadId: number, before: number): Promise<boolean>;
  /** Plan 210 (iteration 3): a reply settled a request or a promise answers one: What matters reads again */
  requestsAnswered(): void;
  runBudgeted<T>(items: readonly T[], work: (chunk: T[]) => void | Promise<void>): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

const inWords = (ms: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language === "es" ? "es" : "en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
};

/** A recipient is someone who can owe a reply: not a list or an automated address (plan 17). */
const isPerson = (email: string) => automatedLevel({ from_email: email, list_id: null, is_bulk: 0, gmail_labels: null, is_spam: 0 }) < 2;

/** Normalized, as a person retyping it would: a quote must really be in what they wrote. */
const norm = (text: string) => normalizeText(text).replace(/\s+/g, " ").trim();

/**
 * Plan 142's local checks, before anything's stored: a promise's quote and a closure's evidence are the sender's own
 * words, a date must make sense, and a label must be one it was given. Pure, so each can be tested on its own.
 */
/**
 * Plan 210 (iteration 3): a promise that only holds a request ("let me check and get back to you", "I'll check my calendar",
 * "lo reviso y te aviso"): it answers nothing, whatever the model said. Never one that also sends, pays or signs something.
 */
const HOLDS = /\b(?:get back to|let (?:you|him|her|them|us) know|circle back|i(?:'|’)?ll (?:check|look into|think about|find out|see)|let me (?:check|see|look|think|find out|confirm)|te (?:aviso|digo|confirmo|contesto|respondo|cuento)|le (?:aviso|digo|confirmo|contesto|respondo)|(?:lo|la) (?:reviso|veo|pienso|consulto))\b/u;
const DELIVERS = /\b(?:send|share|forward|attach|pay|sign|submit|book|bring|deliver|transfer|wire|upload|mand\w*|envi\w*|compart\w*|pag\w*|firm\w*|llev\w*|transfier\w*|reserv\w*)\b/u;
/** One verdict a finish applies. */
type Verdict = NonNullable<FollowupFinish["verdicts"]>[number];

export const onlyHolds = (quote: string): boolean => HOLDS.test(normalizeText(quote).toLowerCase()) && !DELIVERS.test(normalizeText(quote).toLowerCase());

/**
 * Plan 210 (iteration 4): a promise's text is said to you, so your things are "your", never "my" (prompt v11's rule, which
 * Haiku still breaks about one reading in ten: "send Asha my script", "el escaneo de mi pasaporte"). "mí" ("para mí") is
 * another word and stays, and so is a word that isn't one's own ("5 mi away").
 */
export const yourWords = (text: string): string =>
  text.replace(/(?<![\p{L}\p{N}'’])(?<!\d\s)(my|mi|mis)(?=\s+\p{L})/giu, (w) => {
    const to = ({ my: "your", mi: "tu", mis: "tus" } as const)[w.toLowerCase() as "my" | "mi" | "mis"];
    return w[0] === w[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to;
  });

/** Plan 210 (iteration 3): a verdict's words, or a promise's, are the same words: one holds the other. */
const sameWords = (a: string, b: string): boolean => {
  const x = norm(a).toLowerCase();
  const y = norm(b).toLowerCase();
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

export function checkSentMail(result: SentMailResult, input: { ownText: string; recipients: readonly { label: string; name: string; email: string }[]; open: ReadonlyMap<string, FollowupRow>; requests?: ReadonlyMap<string, Pick<DatedRow, "id" | "revision">>; sentAt: number; nudgeAfterDays: number }): { rows: FollowupWrite[]; kept: { id: number; revision: number }[]; verdicts: Verdict[] } {
  const own = norm(input.ownText);
  const byLabel = new Map(input.recipients.map((r) => [r.label, r]));
  // plan 161, real models: Haiku names who it means ("Arjun Ramírez") where the prompt asks for a label ("r1"). A name
  // counts only when exactly one recipient has it, so it can't reach anyone the message wasn't sent to
  const named = (who: string) => {
    const matches = input.recipients.filter((r) => norm(r.name) === norm(who));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const person = { get: (who: string) => byLabel.get(who) ?? named(who) };
  const rows: FollowupWrite[] = [];
  result.promises.forEach((p, item) => {
    if (!own.includes(norm(p.quote))) return;
    const to = p.to ? person.get(p.to) : undefined;
    const due = validFollowupDate(p.due, input.sentAt);
    const day = followupDue({ kind: "promise", sentAt: input.sentAt, due, nudgeAfterDays: input.nudgeAfterDays });
    // plan 210 (iteration 2): a time its words state is its moment
    const { dueAt, timed } = promiseMoment(p.text, due, day, input.sentAt);
    rows.push({ kind: "promise", item, text: yourWords(p.text), quote: p.quote, personName: to?.name || null, personEmail: to?.email ?? null, dueAt, dated: day.dated, ...(timed ? { timed } : {}) });
  });
  if (result.expectsReply) {
    const who = result.awaiting.flatMap((label) => person.get(label) ?? []).filter((r) => isPerson(r.email));
    const first = who[0];
    if (first) {
      const { dueAt, dated } = followupDue({ kind: "awaiting", sentAt: input.sentAt, due: null, nudgeAfterDays: input.nudgeAfterDays });
      rows.push({ kind: "awaiting", item: AWAITING_ITEM, text: "", quote: null, personName: first.name || null, personEmail: first.email, dueAt, dated });
    }
  }
  const kept = result.kept.flatMap((k) => {
    const row = input.open.get(k.label);
    return row && k.evidence && own.includes(norm(k.evidence)) ? [{ id: row.id, revision: row.revision }] : [];
  });
  /**
   * Plan 210 (iteration 3, the Codex review's revision 1): a verdict on a request it was shown, evidence-checked like the rest:
   * their words, two or more, never words to the app. Done now settles it; a concrete promise kept above links it (one
   * that only holds it, "let me check and get back to you", holds it: iteration 4); a "done" whose words are a promise's is
   * that promise; anything else leaves it.
   */
  const sentences = sentencesOf(input.ownText);
  const verdicts = (result.answers ?? []).flatMap((a): Verdict[] => {
    const request = input.requests?.get(a.label);
    if (!request || a.verdict === "unknown") return [];
    if (!own.includes(norm(a.evidence)) || !plainEvidence(a.evidence, contextOf(a.evidence, sentences))) return [];
    const promise = rows.find((r) => r.kind === "promise" && r.quote && sameWords(r.quote, a.evidence));
    const shown = { id: request.id, revision: request.revision };
    // plan 210 (iteration 4, the Codex review's revision 4): a promise that only holds it is stored with it, whatever the
    // model called it ("holding" kept, no longer dropped); a "holding" whose words also send or sign something links nothing
    if (promise && onlyHolds(promise.quote!)) return [{ request: shown, verdict: "holding" as const, item: promise.item }];
    if (promise) return a.verdict === "holding" ? [] : [{ request: shown, verdict: "promise" as const, item: promise.item }];
    return a.verdict === "fulfilled" ? [{ request: shown, verdict: "fulfilled" as const }] : [];
  });
  return { rows, kept, verdicts };
}

/** A check's own rules: past these it's over, and nothing old jumps. */
export function scanKeeps(row: Pick<FollowupWrite, "kind" | "dueAt">, sentAt: number, now: number): boolean {
  return row.kind === "promise" ? now - row.dueAt <= SCAN_PROMISE_OVERDUE_MS : now - sentAt <= SCAN_WAIT_STALE_MS;
}

/**
 * Plan 142: reads what you send, and keeps what comes of it coming due. A durable queue, drained through the limiter,
 * oldest first, only when something wakes it. A thread is read in order: one waiting for a body holds the later ones on
 * that thread only (revision 2). Failures as summaries' (plan 132 revision 4):
 *
 * - `rate_limited`, `unavailable`, `timeout`: the pass ends and new mail doesn't ask again for a minute; 3 and it goes
 * - `invalid_output`, `refused`, `unsupported`: this message is passed over
 * - `auth`, `not_configured`, `blocked`: paused until settings change, with what's tracked still coming due
 * - the day's or month's limit: stopped until the next day
 * - `cancelled`: stays
 */
export class FollowupWorker {
  private active = false;
  private enabledAt: number | null = null;
  private nudgeDays: number = NUDGE_DEFAULT;
  /** the one request running, and whose: an account's opt-out stops it */
  private reading: { accountId: number; controller: AbortController } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private again = false;
  private generation = new AbortController();
  private paused: { kind: AiErrorKind; message: string } | null = null;
  private limited: string | null = null;
  private heldUntil = 0;
  private readonly attempts = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private touchTimer: ReturnType<typeof setTimeout> | null = null;
  private armedAt: number | null = null;
  private ids = new Set<number>();
  private sent = "";
  private readonly undo = new Map<string, { snapshot: FollowupSnapshot; expectRevision: number }[]>();
  private undoSeq = 0;
  private prunedDay: string | null = null;

  constructor(private readonly host: FollowupHost) {}

  get isActive(): boolean {
    return this.active && !this.stopped;
  }
  /** the moment it went on: what was sent before it isn't marked (revision of §2) */
  get since(): number | null {
    return this.enabledAt;
  }
  /** plan 210 (iteration 4): when a wait comes due, as set (a handed forward's own wait is seeded with it) */
  get nudgeAfterDays(): number {
    return this.nudgeDays;
  }
  /** a live timer waiting on a provider (null otherwise); for tests */
  get retrying(): ReturnType<typeof setTimeout> | null {
    return this.retryTimer;
  }
  get nextAt(): number | null {
    return this.armedAt;
  }
  get blockedBy(): { kind: AiErrorKind; message: string } | null {
    return this.paused;
  }

  async start(): Promise<void> {
    const { enabled, enabledAt, nudgeAfterDays } = (await this.host.settings()).followups;
    this.active = enabled;
    this.enabledAt = enabledAt;
    this.nudgeDays = nudgeAfterDays;
    if (this.stopped) return;
    await this.look();
    if (this.active) this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.generation.abort();
    this.clearRetry();
    if (this.timer) clearTimeout(this.timer);
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.timer = this.touchTimer = null;
    this.armedAt = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** The account's own switch went off: what's running on it stops, and nothing of it stays queued. */
  accountOff(accountId: number): void {
    if (this.reading?.accountId === accountId) this.reading.controller.abort();
    this.wake();
  }

  /** New mail, a confirmed send, a body. A no-op when off, paused, or for a minute after a provider failed. */
  wake(o: { network?: boolean } = {}): void {
    if (!this.isActive || this.paused) return;
    if (o.network) this.heldUntil = 0;
    if (this.host.now() < this.heldUntil) return;
    const today = new Date(this.host.now()).toDateString();
    if (this.limited) {
      if (this.limited === today) return;
      this.limited = null;
    }
    void this.drain().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
      this.host.log("warn", "follow-ups stopped", error instanceof Error ? error.name : "error");
    });
  }

  settingsChanged(settings: AppSettings): void {
    const on = settings.followups.enabled;
    const off = this.active && !on;
    this.active = on;
    this.enabledAt = settings.followups.enabledAt;
    this.nudgeDays = settings.followups.nudgeAfterDays;
    const wasPaused = this.paused !== null;
    this.paused = null;
    if (wasPaused) this.host.statusChanged(this.status());
    this.limited = null;
    this.heldUntil = 0;
    this.clearRetry();
    if (off) {
      this.generation.abort();
      this.generation = new AbortController();
      void this.host.store.followups.marks.clear().catch(() => {});
      void this.look().catch(() => {});
      return;
    }
    void this.look().catch(() => {});
    this.wake();
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.bounds();
        await this.pass(this.generation);
      } while (this.again && this.isActive && !this.paused && !this.limited);
    } finally {
      this.running = false;
    }
  }

  private async bounds(): Promise<void> {
    const today = new Date(this.host.now()).toDateString();
    if (this.prunedDay === today) return;
    this.prunedDay = today;
    await this.host.store.followups.marks.prune(this.host.now());
    await this.host.store.followups.prune(this.host.now());
    await this.retire();
  }

  /**
   * Plan 210 (iteration 3, the Codex review's revision 7): a promise past its day for good (`promiseOver`: its Missed week
   * over, from the day it sits under, a request it answers included) is retired, as the dated reader retires what's over,
   * so the open set's bound of 1,000 holds only what can still show. History says "Over".
   */
  async retire(): Promise<number> {
    const { store } = this.host;
    const now = this.host.now();
    const promises = (await store.followups.active()).filter((r) => r.kind === "promise");
    // the requests they answer or hold, in one batch: a request's day still ahead keeps its promise
    const linked = [...new Set(promises.flatMap((p) => [p.answers, p.holds].flatMap((id) => (id == null ? [] : [refKey({ source: "dated", id })]))))];
    const requests = new Map((linked.length ? (await store.today.members(linked)).dated : []).map((r) => [r.id, r]));
    const over = withNeeds(promises, requests).filter((r) => promiseOver(r, now));
    // plan 210 (iteration 4): a promise that only held a request ends with it (answered, done, removed, gone): never a row
    // of its own after it, and no history line (the request's says it)
    const held = promises.filter((p) => p.holds != null && requests.get(p.holds)?.state !== "open");
    let n = 0;
    await this.host.runBudgeted([...over.map((r) => ({ r, reason: "expired" })), ...held.map((r) => ({ r, reason: HELD_REQUEST_CLOSED }))], async (chunk) => {
      for (const { r, reason } of chunk) if (await store.followups.update(r.id, r.revision, { state: "dismissed", inboxState: "none", closedReason: reason, closedAt: now })) n++;
    });
    if (n) await this.look();
    return n;
  }

  private async pass(generation: AbortController): Promise<void> {
    let after: { sentAt: number; messageId: number } | null = null;
    const held = new Set<number>();
    for (;;) {
      const page: SentMark[] = await this.host.store.followups.marks.page(after, PAGE);
      if (!page.length) return;
      for (const mark of page) {
        if (generation !== this.generation || !this.isActive) return;
        after = { sentAt: mark.sentAt, messageId: mark.messageId };
        // "Here's the contract" isn't read before the promise it keeps
        if (held.has(mark.threadId)) continue;
        const next = await this.consider(mark, generation);
        if (next === "stop") return;
        if (next === "hold") held.add(mark.threadId);
      }
    }
  }

  private async consider(mark: SentMark, generation: AbortController): Promise<"next" | "hold" | "stop"> {
    const { store } = this.host;
    const clearGeneration = store.followups.clearGeneration();
    const settings = await this.host.settings();
    if (!settings.followups.enabled) return "stop";
    const src = await store.followups.source(mark.messageId);
    const drop = async () => {
      await store.followups.marks.consume(mark.messageId);
      return "next" as const;
    };
    if (!src || src.draft || src.spam || src.trash || src.bulk) return drop();
    // from here on an opt-out reaches it, whatever it's waiting for
    const mine = { accountId: src.accountId, controller: new AbortController() };
    this.reading = mine;
    const left = () => this.reading === mine && (this.reading = null);
    // what was sent before it went on is read only with a yes: the check's own marks are that yes
    if (mark.source === "live" && settings.followups.enabledAt !== null && src.date < settings.followups.enabledAt) return drop();
    if (!(await this.host.accountWanted(src.accountId))) {
      left();
      return drop();
    }
    if ((await this.host.templated(src.accountId)).has(src.id)) {
      left();
      return drop();
    }
    if (src.bodyState !== "full" && !src.bodyUnavailable) {
      left();
      return "hold";
    }
    if (src.answering && src.answering.bodyState === "none" && !src.answering.bodyUnavailable) {
      left();
      return "hold";
    }
    // plan 210 (iteration 3): its verdict is on the conversation's requests, so the mail before it is read first
    if (settings.dated?.enabled && (await this.host.datedPending(src.threadId, src.date))) {
      left();
      return "hold";
    }
    const asked = this.host.begin(`followup:${mark.messageId}`, "followup-worker");
    try {
      const ai = await this.host.forTask();
      const language = await this.readerLanguage(settings);
      const { own, answering } = await this.texts(src);
      if (!own) return await drop();
      const open = (await store.followups.ofThread(src.threadId)).filter((r) => r.kind === "promise" && r.sentAt < src.date).sort((a, b) => b.sentAt - a.sentAt).slice(0, FOLLOWUP_OPEN_MAX);
      const openLabels = new Map(open.map((r, i) => [`p${i + 1}`, r]));
      // plan 210 (iteration 3): what the conversation asked of you before this, open (a promise may already answer one)
      const requested = settings.dated?.enabled ? (await store.dated.ofThread(src.threadId)).filter((r) => ANSWERED_KINDS.includes(r.kind) && r.arrivedAt < src.date).sort((a, b) => b.arrivedAt - a.arrivedAt).slice(0, FOLLOWUP_REQUESTS_MAX) : [];
      const requestLabels = new Map(requested.map((r, i) => [`q${i + 1}`, r]));
      const recipients = [...src.to, ...src.cc].slice(0, 20).map((r, i) => ({ label: `r${i + 1}`, name: r.name || r.email.split("@")[0]!, email: r.email }));
      const budget = followupBudget(ai.contextTokens);
      const input = fitSentMail({ ownText: own, ...(answering ? { answering } : {}), subject: src.subject, recipients: recipients.map(({ label, name }) => ({ label, name })), attachments: src.attachments, openPromises: [...openLabels].map(([label, r]) => ({ label, text: r.text })), requests: [...requestLabels].map(([label, r]) => ({ label, text: r.text, due: r.dated ? r.dueDay : null })), sentAt: inWords(src.date, language), language, outputTokens: budget.outputTokens }, budget.promptChars);
      // a change of provider or key, the account's switch, the setting: each stops it, at the provider too
      const signal = AbortSignal.any([generation.signal, asked.signal, mine.controller.signal]);
      // the last look before anything leaves
      if (signal.aborted || !(await this.host.accountWanted(src.accountId))) return await drop();
      const result = await ai.readSentMail(input, signal);
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      if (!(await this.host.accountWanted(src.accountId))) return await drop();
      // only what was really sent, after fitting to the window, may be named back
      const shown = new Set((input.requests ?? []).map((r) => r.label));
      const checked = checkSentMail(result, { ownText: own, recipients, open: openLabels, requests: new Map([...requestLabels].filter(([l]) => shown.has(l))), sentAt: src.date, nudgeAfterDays: settings.followups.nudgeAfterDays });
      const fromScan = mark.source === "scan";
      const now = this.host.now();
      const rows = fromScan ? checked.rows.filter((r) => scanKeeps(r, src.date, now)) : checked.rows;
      // a promise a scan leaves out links nothing
      const verdicts = checked.verdicts.filter((v) => v.verdict === "fulfilled" || rows.some((r) => r.item === v.item));
      await store.followups.finish({ messageId: src.id, threadId: src.threadId, fromScan, rows, kept: checked.kept, verdicts, now, model: ai.model, provider: ai.providerId, promptVersion: FOLLOWUP_PROMPT_VERSION, clearGeneration });
      // a request settled or answered: What matters reads again
      if (verdicts.length) this.host.requestsAnswered();
      this.attempts.delete(src.id);
      await this.look();
      return "next";
    } catch (error) {
      // the account's switch went off under it: it isn't read, nor asked about again
      if (!(await this.host.accountWanted(src.accountId).catch(() => true))) return await drop();
      return this.failed(mark, error);
    } finally {
      asked.release();
      if (this.reading === mine) this.reading = null;
    }
  }

  private async texts(src: FollowupSource): Promise<{ own: string; answering: string | null }> {
    const { store } = this.host;
    const texts = await store.aiSummaries.text([{ messageId: src.id, limit: FOLLOWUP_OWN_CHARS * 4 }, ...(src.answering ? [{ messageId: src.answering.id, limit: FOLLOWUP_ANSWERING_CHARS * 4 }] : [])]);
    const signature = await this.host.signature(src.accountId);
    const [written] = readCorpus([{ id: src.id, to: src.to.map((r) => r.email), cc: src.cc.map((r) => r.email), at: src.date, isReply: !!src.answering, body: texts.get(src.id) ?? "" }], { signature });
    const answering = src.answering ? withoutQuotes(texts.get(src.answering.id) ?? "") : null;
    return { own: written?.text ?? "", answering: answering || null };
  }

  private async failed(mark: SentMark, error: unknown): Promise<"next" | "stop"> {
    const { store } = this.host;
    if (error instanceof DailyLimitError || error instanceof MonthlyLimitError) {
      this.limited = new Date(this.host.now()).toDateString();
      return "stop";
    }
    if (!(error instanceof AiError)) captureError(error instanceof Error ? new Error(error.name) : new Error("error"), { code: "ai.failed" });
    const kind: AiErrorKind = error instanceof AiError ? error.kind : "unavailable";
    this.host.log("info", "follow-up read failed", { aiKind: kind });
    switch (kind) {
      case "cancelled":
        // what stopped it (a new provider) may let it run: the next look decides
        if (this.isActive) this.again = true;
        return "stop";
      case "auth":
      case "not_configured":
      case "blocked":
        this.paused = { kind, message: error instanceof Error ? error.message : String(error) };
        this.host.statusChanged(this.status());
        return "stop";
      case "invalid_output":
      case "refused":
      case "unsupported":
        await store.followups.marks.consume(mark.messageId);
        return "next";
      case "rate_limited":
      case "unavailable":
      case "timeout": {
        const tries = (this.attempts.get(mark.messageId) ?? 0) + 1;
        if (tries >= MAX_ATTEMPTS) {
          this.attempts.delete(mark.messageId);
          await store.followups.marks.consume(mark.messageId);
        } else this.attempts.set(mark.messageId, tries);
        this.heldUntil = this.host.now() + RETRY_WAIT_MS;
        // the one timer: a provider that said "slow down", with work still queued (the network coming back wakes the rest)
        if (kind === "rate_limited" && !this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.wake({ network: true });
          }, RETRY_WAIT_MS);
          (this.retryTimer as { unref?: () => void }).unref?.();
        }
        return "stop";
      }
    }
  }

  private async readerLanguage(settings: AppSettings): Promise<LocaleId> {
    if (isLocaleId(settings.language)) return settings.language;
    const ui = await this.host.store.settings.get<string | null>(UI_LOCALE_KEY, null);
    return isLocaleId(ui) ? ui : DEFAULT_LOCALE;
  }

  // ─── what's tracked, and when it comes due ───────────────────────────────

  /** Mail changed: while there's anything active, one look a second at most. */
  touched(): void {
    if (this.stopped || this.touchTimer || this.ids.size === 0) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      if (!this.stopped) void this.look().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    }, TOUCH_EVERY_MS);
    (this.touchTimer as { unref?: () => void }).unref?.();
  }

  /** The rows now: replies end waits, what's come due comes due, and one timer for the next. */
  async look(): Promise<FollowupsSnapshot> {
    const { store } = this.host;
    // off: nothing comes due and no timer runs; rows stay until Clear AI data, so turning it back on loses nothing
    if (!this.active) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.armedAt = null;
      return { rows: await store.followups.active() };
    }
    const now = this.host.now();
    const waits = (await store.followups.active()).filter((r) => r.kind === "awaiting");
    await this.host.runBudgeted(waits.map((r) => r.id), async (chunk) => {
      await store.followups.closeAnswered(chunk, now);
    });
    await store.followups.makeDue(now);
    const rows = await store.followups.active();
    // what's due and hasn't been said, not only what came due just now: a quit between the two says it on the way back
    await this.announce(rows.filter((r) => r.state === "due" && r.notifiedAt === null), now);
    this.ids = new Set(rows.map((r) => r.threadId));
    const snapshot: FollowupsSnapshot = { rows };
    if (this.stopped) return snapshot;
    await this.arm(now);
    const text = JSON.stringify(rows.map((r) => [r.id, r.revision]));
    if (text !== this.sent) {
      this.sent = text;
      this.host.emit(snapshot);
    }
    return snapshot;
  }

  /** A due promise says so, once, per row (revision 7). A nudge doesn't. */
  private async announce(due: readonly FollowupRow[], now: number): Promise<void> {
    if (this.stopped) return;
    const fresh = due.filter((r) => r.kind === "promise" && !r.fromScan && r.inboxState === "onTop" && followupWakeAt(r) > now - NOTIFY_WINDOW_MS);
    if (!fresh.length) return;
    const claimed = new Set(await this.host.store.followups.claimNotice(fresh.map((r) => r.id), now));
    const rows = fresh.filter((r) => claimed.has(r.id));
    if (!rows.length) return;
    const threads = new Map((await this.host.summaries(rows.map((r) => r.threadId))).map((t) => [t.id, t]));
    const shown = rows.filter((r) => {
      const t = threads.get(r.threadId);
      return t && !t.inTrash && !t.inSpam;
    });
    const notice = followupNotice(shown.map((r) => ({ threadId: r.threadId, text: r.text, personName: r.personName, subject: threads.get(r.threadId)!.subject })), `followup-${now.toString(36)}`);
    if (notice && !this.stopped) this.host.notify(notice);
  }

  private async arm(now: number): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = null;
    const next = await this.host.store.followups.nextDue();
    if (next === null || this.stopped) return;
    this.armedAt = next;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedAt = null;
      if (!this.stopped) void this.look().catch((error: unknown) => captureError(error, { code: "ai.failed" }));
    }, Math.max(0, Math.min(MAX_DELAY, next - now)));
    (this.timer as { unref?: () => void }).unref?.();
  }

  // ─── what the user does ──────────────────────────────────────────────────

  private remember(entries: { snapshot: FollowupSnapshot; expectRevision: number }[]): string | null {
    if (!entries.length) return null;
    const id = `f${++this.undoSeq}`;
    this.undo.set(id, entries);
    while (this.undo.size > UNDO_KEPT) this.undo.delete(this.undo.keys().next().value!);
    return id;
  }

  /**
   * Done, Not a promise / Dismiss, and Later: one journal entry on the row (revision 6). Plan 204 (the fifth panel round):
   * a promise's Later is its own (`deferredUntil`), so its day stays and Today places it by both; a nudge's moves its moment.
   */
  async act(id: number, revision: number, action: "done" | "dismiss" | "later", dueAt?: number): Promise<{ undoId: string | null; row: FollowupRow | null }> {
    const now = this.host.now();
    const promise = action === "later" && (await this.host.store.followups.get(id))?.kind === "promise";
    const patch: Parameters<MailStore["followups"]["update"]>[2] =
      action !== "later" ? { state: action === "done" ? "done" : "dismissed", inboxState: "none", closedReason: "user", closedAt: now }
      : promise ? { state: "open", inboxState: "none", deferredUntil: dueAt ?? now }
      : { state: "open", inboxState: "none", dueAt: dueAt ?? now };
    const before = await this.host.store.followups.update(id, revision, patch);
    if (!before) throw new RpcError("STALE", L("errors.followups.changed"));
    await this.look();
    const row = await this.host.store.followups.get(id);
    return { undoId: this.remember([{ snapshot: before, expectRevision: before.revision + 1 }]), row };
  }

  async undoAct(undoId: string): Promise<void> {
    const entries = this.undo.get(undoId);
    if (!entries) return;
    this.undo.delete(undoId);
    await this.host.store.followups.restore(entries);
    await this.look();
  }

  /** The Inbox's top ends for these threads; what an Undo would put back. */
  async endTop(threadIds: readonly number[]): Promise<FollowupSnapshot[]> {
    if (!threadIds.some((id) => this.ids.has(id))) return [];
    const ended = await this.host.store.followups.endTop(threadIds);
    if (ended.length) await this.look();
    return ended;
  }

  async putBack(snapshots: readonly FollowupSnapshot[]): Promise<void> {
    if (!snapshots.length) return;
    await this.host.store.followups.restore(snapshots.map((s) => ({ snapshot: s, expectRevision: s.revision + 1 })));
    await this.look();
  }

  /** One row a thread, its most urgent first: the Inbox's top, or the whole list (revision 10). */
  async threads(onTop: boolean, accountId?: number): Promise<ThreadSummary[]> {
    const rows = (await this.host.store.followups.active()).filter((r) => !onTop || r.inboxState === "onTop");
    // the row's own order (`byUrgency`, as its line picks), so a thread is placed by the promise it shows
    const order = [...new Set(rows.sort(byUrgency).map((r) => r.threadId))];
    const threads = new Map((await this.host.summaries(order)).map((t) => [t.id, t]));
    return order.flatMap((id) => {
      const t = threads.get(id);
      // Trash and Spam hide it, and it comes back with them
      return t && !t.inTrash && !t.inSpam && (accountId === undefined || t.accountId === accountId) ? [t] : [];
    });
  }

  // ─── §8: the one-time check ──────────────────────────────────────────────

  async scanOffer(): Promise<{ count: number; usd: number | null }> {
    const ids = await this.host.store.followups.scanCandidates(this.host.now() - SCAN_DAYS * 86_400_000, SCAN_MESSAGES_MAX);
    const ai = await this.host.forTask().catch(() => null);
    const price = ai && !ai.local ? priceOf(ai.model) : null;
    return { count: ids.length, usd: ai?.local ? 0 : price ? costAt(price, SCAN_TOKENS) * ids.length : null };
  }

  async scan(): Promise<number> {
    const now = this.host.now();
    const ids = await this.host.store.followups.scanCandidates(now - SCAN_DAYS * 86_400_000, SCAN_MESSAGES_MAX);
    const queued = await this.host.store.followups.marks.queueScan(ids, now);
    this.wake();
    return queued;
  }

  status(): { blockedBy: { kind: AiErrorKind; message: string } | null } {
    return { blockedBy: this.paused };
  }

  /** Clear AI data: nothing in flight may bring back what was cleared. */
  async clear(): Promise<void> {
    this.generation.abort();
    this.generation = new AbortController();
    this.undo.clear();
    await this.host.store.followups.clear();
    await this.look();
  }
}


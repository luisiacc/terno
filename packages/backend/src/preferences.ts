import { AiError, MATCH_BATCH, MATCH_EXCERPT_CHARS, PREFERENCES_COMPILER_VERSION, WANTED_PROMPT_VERSION, WANTED_TEXT_CHARS, type AiTasks, type MatchRule, type MatchTarget, type WantedResult } from "@terno/ai";
import {
  activeRules,
  addressKey,
  checkPreferences,
  datedOver,
  datedTiming,
  exactlyReaches,
  isSemantic,
  normalizeText,
  PREFERENCES_TEXT_MAX,
  preferenceDecision,
  rowPrint,
  semanticReaching,
  verdictBasis,
  wantedBy,
  withoutQuotes,
  type AiErrorKind,
  type DatedKind,
  type DatedRow,
  type FollowupRow,
  type PreferenceKind,
  type PreferenceRule,
  type PreferenceTarget,
  type PreferenceVerdict,
  type WhatMattersPreferences,
} from "@terno/core";
import { captureError } from "@terno/core/diag";
import type { AppSettings, I18nRef } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, L, type LocaleId } from "@terno/i18n";
import { WANTED_LOOK_MAX, wantedAsDated, type MailStore, type WantedMark, type WantedWrite } from "@terno/store";
import type { AccountGate } from "./account-gate";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { asksForSecrets, inWords, readerZone } from "./dated";
import { giftCardScam, scamPressure } from "./dated-evidence";
import { silenced, silenceOf } from "./dated-mutes";
import { UI_LOCALE_KEY } from "./forwarding";
import { untrustedSenders } from "./suspicious-sender";

/**
 * Plan 248: What matters, in the user's words. `WhatMattersWords` keeps the words (Save compiles them, Clear and its Undo,
 * the draft), and `PreferenceWorker` does what they need in the background: the matcher (which semantic hide and first
 * rules apply to the rows the projection found unjudged) and the second reader (what a show rule asked for in mail the
 * words admitted). Neither touches the dated reader's prompt, its store or its marks: with no rules there's nothing here to
 * run, and v16 reads as it always did (§9).
 */

export interface WordsHost {
  readonly store: MailStore;
  now(): number;
  settings(): Promise<AppSettings>;
  /** the gate (plans 147, 150): AI can run at all */
  allowed(settings: AppSettings): Promise<boolean>;
  /** plan 211: an account's mail is read only where both AI and What matters are on */
  readonly gate: Pick<AccountGate, "reads">;
  forTask(o: { foreground: boolean }): Promise<AiTasks>;
  /** what What matters holds or shows changed: the list and the count read again */
  changed(): void;
  /** the words' record, the draft or the status changed: the windows read them again */
  emit(state: PreferencesState): void;
  runBudgeted<T>(items: readonly T[], work: (chunk: T[]) => void | Promise<void>): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

/** What the windows show of the words (Settings' row, the gear). */
export interface PreferencesState {
  preferences: WhatMattersPreferences;
  draft: { text: string | null; seq: number } | null;
  status: PreferencesStatus;
}

export interface PreferencesStatus {
  /** rows the matcher still has to judge against the current words, of those the last projection asked about */
  applying: { left: number; total: number } | null;
  /** the look back on its way: messages left to read */
  looking: { left: number } | null;
  /** why the background work is stopped (a provider failing, a limit reached); null: it isn't */
  blockedBy: { kind: AiErrorKind; message: string; i18n?: I18nRef } | null;
}

const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60_000;
/** a new row a semantic hide could reach waits this long for its verdict at most (the Codex review's revision 8) */
export const WITHHOLD_MS = 10 * 60_000;
const LOOK_DAYS = 14;
const LOOK_WALK = 3000;
const MARKS_PAGE = 50;
/** the revision whose words the look back's yes was given for */
const LOOK_REVISION_KEY = "whatMatters:lookRevision";
/** what a message costs the second reader, for the look back's estimate: ~900 tokens in, ~150 out */
export const WANTED_TOKENS_IN = 900;
export const WANTED_TOKENS_OUT = 150;

async function readerLanguage(store: MailStore, settings: AppSettings): Promise<LocaleId> {
  if (isLocaleId(settings.language)) return settings.language;
  const ui = await store.settings.get<string | null>(UI_LOCALE_KEY, null);
  return isLocaleId(ui) ? ui : DEFAULT_LOCALE;
}

// ─── the rows, as targets ──────────────────────────────────────────────────

/** A row the rules may judge: its key (with its revision, so a changed row is judged again), and what it is. */
export interface RowTarget extends PreferenceTarget {
  key: string;
  source: "dated" | "wanted" | "promise" | "waiting";
  id: number;
  threadId: number;
  /** the dated or wanted item's message; a waiting conversation's is resolved by the worker */
  messageId: number | null;
  /** when the row appeared: a new one a semantic hide could reach is withheld until judged */
  since: number;
  text: string;
  quote: string;
  /** a waiting conversation's: since when it waits */
  waitingSince?: number;
}

export function datedTarget(r: DatedRow): RowTarget {
  const wanted = r.id < 0;
  const id = wanted ? -r.id : r.id;
  return { key: `${wanted ? "n" : "d"}:${id}:${rowPrint(r.kind, r.text, r.quote, r.dueDay)}`, source: wanted ? "wanted" : "dated", id, threadId: r.threadId, messageId: r.messageId, kind: r.kind, senderKey: r.senderKey, since: r.createdAt, text: r.text, quote: r.quote };
}

export function promiseTarget(p: FollowupRow): RowTarget {
  return { key: `p:${p.id}:${rowPrint(p.text, p.quote, p.dueAt)}`, source: "promise", id: p.id, threadId: p.threadId, messageId: p.messageId, kind: "promise", senderKey: p.personEmail ? addressKey(p.personEmail) : "", ...(p.personName ? { senderName: p.personName } : {}), since: p.createdAt, text: p.text, quote: p.quote ?? "" };
}

export function waitingTarget(w: { id: number; waitingSince: number; from: string; fromName?: string; subject: string }): RowTarget {
  return { key: `w:${w.id}:${w.waitingSince}`, source: "waiting", id: w.id, threadId: w.id, messageId: null, kind: "waiting", senderKey: addressKey(w.from), ...(w.fromName ? { senderName: w.fromName } : {}), since: w.waitingSince, text: w.subject, quote: "", waitingSince: w.waitingSince };
}

/** The words as the projection applies them: their rules and basis, read once per projection. */
export interface Visibility {
  rules: readonly PreferenceRule[];
  basis: string;
  savedAt: number;
  /** the show rules' keys: a wanted item shows while any of its rules is one */
  shows: ReadonlySet<string>;
  /** a row's decision, from the verdicts read for this projection */
  decide(t: RowTarget): { hide: boolean; first: boolean };
}

// ─── the words ─────────────────────────────────────────────────────────────

export class WhatMattersWords {
  private cache: WhatMattersPreferences | null = null;
  /** the record's last Clear, for its Undo: the words and rules as they were */
  private cleared = new Map<string, Omit<WhatMattersPreferences, "revision">>();
  private undoSeq = 0;
  readonly worker: PreferenceWorker;

  constructor(private readonly host: WordsHost) {
    this.worker = new PreferenceWorker(host, this);
  }

  async record(): Promise<WhatMattersPreferences> {
    return (this.cache ??= await this.host.store.whatMatters.preferences.get());
  }

  /** The words are known (read once) and empty: the worker has nothing to wake for, with no read at all (§9). */
  knownEmpty(): boolean {
    return this.cache !== null && !activeRules(this.cache).length;
  }

  /** The rules in force: none for the empty box (§9) */
  async rules(): Promise<readonly PreferenceRule[]> {
    return activeRules(await this.record());
  }

  async state(): Promise<PreferencesState> {
    return { preferences: await this.record(), draft: await this.host.store.whatMatters.preferences.draft.get(), status: this.worker.status() };
  }

  private async changed(saved: WhatMattersPreferences): Promise<void> {
    this.cache = saved;
    this.host.changed();
    this.host.emit(await this.state());
    await this.worker.rulesChanged(activeRules(saved));
  }

  /** Words typed, kept as they're typed (never the saved words); an older `seq` changes nothing */
  async saveDraft(text: string, seq: number): Promise<boolean> {
    const kept = await this.host.store.whatMatters.preferences.draft.put({ text: text.slice(0, PREFERENCES_TEXT_MAX), seq });
    if (kept) this.host.emit(await this.state());
    return kept;
  }

  /**
   * Save: the words compiled (the user's provider, sees no mail), checked against the words themselves, and saved against
   * the revision they were typed on. Words over the limit are refused, never cut; empty words are Clear.
   */
  async save(text: string, expect: number, signal?: AbortSignal): Promise<{ preferences: WhatMattersPreferences } | { stale: true }> {
    if (text.length > PREFERENCES_TEXT_MAX) throw new AiError(L("errors.whatMatters.wordsTooLong", { max: PREFERENCES_TEXT_MAX }), "invalid_output");
    if (!text.trim()) {
      const cleared = await this.clear(expect);
      return "stale" in cleared ? cleared : { preferences: cleared.preferences };
    }
    const settings = await this.host.settings();
    const language = await readerLanguage(this.host.store, settings);
    const ai = await this.host.forTask({ foreground: true });
    const compiled = await ai.compilePreferences({ text, language }, signal);
    const { rules, notes } = checkPreferences(compiled, text, (said) => L("whatMatters.words.unclear", { said: said.slice(0, 80) }).message);
    const saved = await this.host.store.whatMatters.preferences.save(
      { text, rules, notes, compiledWith: { version: PREFERENCES_COMPILER_VERSION, provider: ai.providerId, model: ai.model }, savedAt: this.host.now(), language },
      expect,
    );
    if (!saved) {
      this.cache = null;
      return { stale: true };
    }
    await this.dropDraft();
    await this.changed(saved);
    return { preferences: saved };
  }

  /** the draft is the saved words now: a typed draft older than this (a late debounced write) is refused by its `seq` */
  private async dropDraft(): Promise<void> {
    const was = (await this.host.store.whatMatters.preferences.draft.get())?.seq ?? 0;
    await this.host.store.whatMatters.preferences.draft.put({ text: null, seq: Math.max(was + 1, this.host.now()) });
  }

  /** Clear: no AI, works offline; everything the words did stops at once, kept for the Undo */
  async clear(expect: number): Promise<{ preferences: WhatMattersPreferences; undoId: string | null } | { stale: true }> {
    const was = await this.host.store.whatMatters.preferences.get();
    const saved = await this.host.store.whatMatters.preferences.save({ text: "", rules: [], notes: [], compiledWith: null, savedAt: this.host.now(), language: was.language }, expect);
    if (!saved) {
      this.cache = null;
      return { stale: true };
    }
    await this.dropDraft();
    let undoId: string | null = null;
    if (was.text.trim()) {
      undoId = `w${++this.undoSeq}`;
      const { revision: _r, ...words } = was;
      this.cleared.set(undoId, words);
      while (this.cleared.size > 5) this.cleared.delete(this.cleared.keys().next().value!);
    }
    await this.host.store.whatMatters.wanted.marks.clearLook();
    await this.changed(saved);
    return { preferences: saved, undoId };
  }

  /** Clear's Undo: the words and their rules back, with no compile, unless something was saved since */
  async undoClear(undoId: string, expect: number): Promise<{ preferences: WhatMattersPreferences } | { stale: true }> {
    const words = this.cleared.get(undoId);
    if (!words) return { stale: true };
    const saved = await this.host.store.whatMatters.preferences.save({ ...words, savedAt: this.host.now() }, expect);
    if (!saved) return { stale: true };
    this.cleared.delete(undoId);
    await this.changed(saved);
    return { preferences: saved };
  }

  /** Clear AI data: what AI made of the words goes (verdicts, wanted items, marks); the words stay, they're the user's */
  async clearAiData(): Promise<void> {
    await this.worker.stop();
    await this.host.store.whatMatters.verdicts.clear();
    await this.host.store.whatMatters.wanted.clear();
    this.host.changed();
  }

  /**
   * The projection's view of the words: none (null) for the empty box, so nothing else runs. The verdicts for `targets` are
   * read in one batch; those a semantic rule could reach and that have no current verdict are handed to the worker.
   */
  async visibility(targets: readonly RowTarget[], o: { ask: boolean }): Promise<Visibility | null> {
    const record = await this.record();
    const rules = activeRules(record);
    if (!rules.length) return null;
    const basis = verdictBasis(rules);
    const reaching = targets.filter((t) => semanticReaching(rules, t).length);
    const verdicts = reaching.length ? await this.host.store.whatMatters.verdicts.get(reaching.map((t) => t.key)) : new Map<string, PreferenceVerdict & { failed: boolean }>();
    const now = this.host.now();
    const savedAt = record.savedAt ?? 0;
    const blocked = this.worker.blocked();
    const unjudged = reaching.filter((t) => verdicts.get(t.key)?.basis !== basis);
    if (o.ask) this.worker.want(unjudged, reaching.length);
    return {
      rules,
      basis,
      savedAt,
      shows: new Set(rules.filter((r) => r.effect === "show").map((r) => r.key)),
      decide: (t) => {
        const v = verdicts.get(t.key);
        // a row that couldn't be judged is shown: a failure never hides mail (an `only` keeps it too)
        const d = preferenceDecision(rules, t, v, basis);
        // withheld while it's judged: new since the words were saved, recent, and the worker able to judge it
        if (d.pending && t.since > savedAt && now - t.since < WITHHOLD_MS && !blocked) return { hide: true, first: false };
        return d;
      },
    };
  }

  // ─── the look back ───────────────────────────────────────────────────────

  /** How many of the last 14 days' messages the show rules may want, and what reading them would cost (input and output tokens). */
  async lookOffer(): Promise<{ count: number; tokensIn: number; tokensOut: number } | null> {
    const rules = (await this.rules()).filter((r) => r.effect === "show");
    if (!rules.length) return null;
    const picks = await this.lookPicks(rules);
    return { count: picks.length, tokensIn: picks.length * WANTED_TOKENS_IN, tokensOut: picks.length * WANTED_TOKENS_OUT };
  }

  /**
   * The user's yes: the picks marked for the second reader, after new mail. The yes is for these words (the Codex code
   * review): it's recorded with their revision, and the worker reads the look's marks only while that's still the words'
   * (a Clear or another Save meanwhile drops them, never reads old mail under new rules).
   */
  async look(): Promise<number> {
    const { revision } = await this.record();
    const rules = (await this.rules()).filter((r) => r.effect === "show");
    if (!rules.length) return 0;
    const picks = await this.lookPicks(rules);
    if ((await this.host.store.whatMatters.preferences.get()).revision !== revision) return 0;
    await this.host.store.settings.set(LOOK_REVISION_KEY, revision);
    const now = this.host.now();
    let n = 0;
    for (const p of picks) if (await this.host.store.whatMatters.wanted.marks.add({ messageId: p.id, threadId: p.threadId, arrivedAt: p.date, source: "look" }, now)) n++;
    this.worker.wake();
    this.host.emit(await this.state());
    return n;
  }

  /** Settings moved: the worker resumes or stops (a provider, a key, a limit, the reader's switch, AI's gate). */
  async settingsChanged(settings: AppSettings): Promise<void> {
    this.worker.settingsChanged(settings, await this.host.allowed(settings));
  }

  /** Plan 248's daily bounds: what the words brought that's over is closed, so their open bound holds only what can show. */
  async daily(): Promise<void> {
    await this.worker.retire();
  }

  private async lookPicks(rules: readonly PreferenceRule[]) {
    const { store } = this.host;
    const now = this.host.now();
    const walked = await store.whatMatters.wanted.lookCandidates(now - LOOK_DAYS * 86_400_000, LOOK_WALK);
    const silence = await silenceOf(store);
    const picks: typeof walked = [];
    await this.host.runBudgeted(walked, async (chunk) => {
      const open = chunk.filter((m) => this.host.gate.reads(m.accountId) && !silenced({ senderKey: addressKey(m.fromEmail), date: m.date }, silence));
      if (!open.length) return;
      const texts = await store.aiSummaries.text(open.map((m) => ({ messageId: m.id, limit: WANTED_TEXT_CHARS })));
      for (const m of open) {
        if (picks.length >= WANTED_LOOK_MAX) return;
        if (wantedBy(rules, { senderKey: addressKey(m.fromEmail), subject: m.subject, fromName: m.fromName, text: withoutQuotes(texts.get(m.id) ?? "") }).length) picks.push(m);
      }
    });
    return picks;
  }
}

// ─── the worker ────────────────────────────────────────────────────────────

/** What's on its way to the provider: what the limiter's last check re-reads before it leaves (revision 7). */
interface Leaving {
  revision: number;
  /** the second reader's (mail read for a show): stops with the reader's switch too */
  reading: boolean;
  /** each source's message (dated, wanted, a waiting message) or thread (a promise's) */
  sources: { messageId: number | null; threadId: number; senderKey: string }[];
  stop: AbortController;
}

export class PreferenceWorker {
  private running = false;
  private again = false;
  private generation = new AbortController();
  private queue = new Map<string, RowTarget>();
  private asked = new Set<string>();
  private total = 0;
  private attempts = new Map<string, number>();
  private wantedAttempts = new Map<number, number>();
  private leaving: Leaving | null = null;
  private paused: { kind: AiErrorKind; message: string; i18n?: I18nRef } | null = null;
  private heldUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lookLeft: number | null = null;

  constructor(
    private readonly host: WordsHost,
    private readonly words: WhatMattersWords,
  ) {}

  status(): PreferencesStatus {
    const left = this.queue.size;
    return { applying: left ? { left, total: Math.max(this.total, left) } : null, looking: this.lookLeft ? { left: this.lookLeft } : null, blockedBy: this.paused };
  }

  blocked(): boolean {
    return this.paused !== null || this.host.now() < this.heldUntil;
  }

  /** The projection's unjudged rows: queued (once each), the worker woken. Nothing queued, nothing runs. */
  want(targets: readonly RowTarget[], reaching: number): void {
    this.asked = new Set(targets.map((t) => t.key));
    let added = false;
    for (const t of targets) {
      if (this.queue.has(t.key) || (this.attempts.get(t.key) ?? 0) >= MAX_ATTEMPTS) continue;
      this.queue.set(t.key, t);
      added = true;
    }
    this.total = Math.max(reaching, this.queue.size);
    if (added) this.wake();
  }

  /** The words changed: work for the old ones stops; marks the new ones don't want go; wanted items' reasons are brought in step. */
  async rulesChanged(rules: readonly PreferenceRule[]): Promise<void> {
    this.generation.abort();
    this.generation = new AbortController();
    this.leaving?.stop.abort();
    this.queue.clear();
    this.attempts.clear();
    this.paused = null;
    const { store } = this.host;
    const shows = rules.filter((r) => r.effect === "show");
    if (!shows.length) await store.whatMatters.wanted.marks.clearLook();
    await store.whatMatters.wanted.reconcile(new Set(shows.map((r) => r.key)), this.host.now());
    await store.whatMatters.verdicts.prune(verdictBasis(rules), new Set());
    this.wake();
  }

  async stop(): Promise<void> {
    this.generation.abort();
    this.generation = new AbortController();
    this.leaving?.stop.abort();
    this.queue.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  wake(): void {
    // the empty box (known): nothing to do and nothing read (§9)
    if (this.words.knownEmpty() && !this.queue.size) return;
    if (this.host.now() < this.heldUntil) return;
    void this.drain().catch((error: unknown) => captureError(error instanceof Error ? error : new Error(String(error)), { code: "ai.failed" }));
  }

  /**
   * Settings moved (a provider, a key, the limits, the reader's switch: the Codex code review): a pause ends and the work
   * starts again; the reader turned off or AI gone stops what's on its way (its marks wait for it to come back on).
   */
  settingsChanged(settings: AppSettings, allowed: boolean): void {
    this.paused = null;
    this.heldUntil = 0;
    if (!allowed || !settings.dated?.enabled) {
      this.generation.abort();
      this.generation = new AbortController();
      this.leaving?.stop.abort();
      if (!allowed) this.queue.clear();
    }
    this.wake();
  }

  /** What the words brought that's over (a Plan ended, a deadline past Missed's days) is closed as expired. */
  async retire(): Promise<number> {
    const { store } = this.host;
    const now = this.host.now();
    const over = (await store.whatMatters.wanted.active()).filter((w) => datedOver(wantedAsDated(w), now));
    if (!over.length) return 0;
    const done = await store.whatMatters.wanted.act(over.map((w) => ({ id: w.id, revision: w.revision, patch: { state: "dismissed" as const, closedReason: "expired", closedAt: now } })));
    if (done) this.host.changed();
    return done?.length ?? 0;
  }

  /**
   * The limiter's last look before a request leaves (revision 7): each source still received, not in Spam or Trash, its
   * account still reading, its sender not muted, the words not changed; else it stops, and the pass rebuilds it without.
   */
  async holdingUp(): Promise<void> {
    const leaving = this.leaving;
    if (!leaving || leaving.stop.signal.aborted) return;
    const { store } = this.host;
    if ((await store.whatMatters.preferences.get()).revision !== leaving.revision) return leaving.stop.abort();
    // the reader's own switch for what it reads, AI's for anything (the Codex code review)
    const settings = await this.host.settings();
    if (!(await this.host.allowed(settings)) || (leaving.reading && !settings.dated?.enabled)) return leaving.stop.abort();
    const silence = await silenceOf(store);
    for (const s of leaving.sources) {
      if (s.messageId !== null) {
        const src = await store.dated.source(s.messageId);
        if (!src || src.spam || src.trash || src.threadSpam || !this.host.gate.reads(src.accountId) || silenced(src, silence)) return leaving.stop.abort();
      } else {
        const t = (await store.threads.summaries([s.threadId]))[0];
        if (!t || t.inSpam || t.inTrash) return leaving.stop.abort();
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    let worked = false;
    try {
      do {
        this.again = false;
        const generation = this.generation;
        const settings = await this.host.settings();
        if (!(await this.host.allowed(settings))) return;
        const record = await this.words.record();
        const rules = activeRules(record);
        if (!rules.length) {
          this.queue.clear();
          return;
        }
        if (this.paused || this.host.now() < this.heldUntil) return;
        worked = true;
        if (settings.dated?.enabled && rules.some((r) => r.effect === "show")) {
          if ((await this.wantedPass(record, rules, settings, generation)) === "stop") return;
        }
        if ((await this.matchPass(record, rules, generation)) === "stop") return;
      } while (this.again);
    } finally {
      this.running = false;
      // the windows hear only when there was work (idle stays quiet)
      if (worked) this.host.emit(await this.words.state());
    }
  }

  // ─── the matcher ─────────────────────────────────────────────────────────

  private async matchPass(record: WhatMattersPreferences, rules: readonly PreferenceRule[], generation: AbortController): Promise<"next" | "stop"> {
    const basis = verdictBasis(rules);
    while (this.queue.size && !generation.signal.aborted) {
      const batch = [...this.queue.values()].slice(0, MATCH_BATCH);
      const built = await this.targetsOf(batch, rules);
      const { store } = this.host;
      // rows nothing can be sent for (Spam, Trash, an account not reading, gone) get a failed verdict: shown, never withheld
      const now = this.host.now();
      if (built.skipped.length) {
        await store.whatMatters.verdicts.put(built.skipped.map((t) => ({ target: t.key, basis, rules: [], at: now, failed: true })), record.revision);
        for (const t of built.skipped) this.queue.delete(t.key);
      }
      if (!built.targets.length) continue;
      const stop = new AbortController();
      this.leaving = { revision: record.revision, reading: false, sources: built.targets.map((b) => b.source), stop };
      try {
        const ai = await this.host.forTask({ foreground: false });
        const signal = AbortSignal.any([generation.signal, stop.signal]);
        const judged = await judgeRows(ai, rules, built.targets.map((b) => ({ row: b.row, target: b.target })), signal);
        if (signal.aborted) return "next";
        const byTarget = judged;
        const verdicts = built.targets.map((b) => ({ target: b.row.key, basis, rules: byTarget.get(b.row.key) ?? [], at: this.host.now() }));
        if (!(await store.whatMatters.verdicts.put(verdicts, record.revision))) return "stop";
        for (const b of built.targets) {
          this.queue.delete(b.row.key);
          this.attempts.delete(b.row.key);
        }
        this.host.changed();
      } catch (error) {
        if (stop.signal.aborted && !generation.signal.aborted) continue;
        if (generation.signal.aborted) return "stop";
        const verdict = await this.failed(error);
        if (verdict === "drop") {
          // what can never be judged: shown, and not asked again until the words change
          await store.whatMatters.verdicts.put(built.targets.map((b) => ({ target: b.row.key, basis, rules: [], at: this.host.now(), failed: true })), record.revision);
          for (const b of built.targets) this.queue.delete(b.row.key);
          continue;
        }
        if (verdict === "retry") {
          for (const b of built.targets) {
            const tries = (this.attempts.get(b.row.key) ?? 0) + 1;
            this.attempts.set(b.row.key, tries);
            if (tries >= MAX_ATTEMPTS) {
              await store.whatMatters.verdicts.put([{ target: b.row.key, basis, rules: [], at: this.host.now(), failed: true }], record.revision);
              this.queue.delete(b.row.key);
            }
          }
        }
        this.host.changed();
        return "stop";
      } finally {
        if (this.leaving?.stop === stop) this.leaving = null;
      }
    }
    await this.host.store.whatMatters.verdicts.prune(basis, this.asked);
    return "next";
  }

  /** Each row's words for the matcher, read locally, and only for a row whose source may go to AI now. */
  private async targetsOf(batch: readonly RowTarget[], rules: readonly PreferenceRule[]): Promise<{ targets: { row: RowTarget; target: MatchTarget; source: Leaving["sources"][number] }[]; skipped: RowTarget[] }> {
    const { store } = this.host;
    const silence = await silenceOf(store);
    const targets: { row: RowTarget; target: MatchTarget; source: Leaving["sources"][number] }[] = [];
    const skipped: RowTarget[] = [];
    for (const row of batch) {
      if (!semanticReaching(rules, row).length) {
        skipped.push(row);
        continue;
      }
      let messageId = row.messageId;
      if (row.source === "waiting") {
        const acts = await store.today.waiting.rows([{ threadId: row.threadId, since: row.waitingSince ?? 0 }], this.host.now(), { messages: true });
        messageId = acts.get(row.threadId)?.message ?? null;
      }
      if (messageId === null) {
        skipped.push(row);
        continue;
      }
      const src = await store.dated.source(messageId);
      if (!src || src.spam || src.trash || src.threadSpam || !this.host.gate.reads(src.accountId) || silenced(src, silence)) {
        skipped.push(row);
        continue;
      }
      const text = withoutQuotes((await store.aiSummaries.text([{ messageId, limit: MATCH_EXCERPT_CHARS * 4 }])).get(messageId) ?? "");
      const excerpt = excerptAround(text, row.quote, MATCH_EXCERPT_CHARS);
      const id = `t${targets.length + 1}`;
      targets.push({
        row,
        target: { id, kind: row.kind, text: row.source === "waiting" ? src.subject : row.text, from: src.fromName || src.fromEmail.split("@")[0]!, subject: src.subject, excerpt },
        source: { messageId, threadId: row.threadId, senderKey: src.senderKey },
      });
    }
    return { targets, skipped };
  }

  // ─── the second reader ───────────────────────────────────────────────────

  private async wantedPass(record: WhatMattersPreferences, rules: readonly PreferenceRule[], _settings: AppSettings, generation: AbortController): Promise<"next" | "stop"> {
    const { store } = this.host;
    await store.whatMatters.wanted.marks.prune(this.host.now());
    // the look back's marks only for the words it was said yes to (the Codex code review)
    if ((await store.whatMatters.wanted.marks.count("look")) && (await store.settings.get<number | null>(LOOK_REVISION_KEY, null)) !== record.revision) await store.whatMatters.wanted.marks.clearLook();
    const shows = rules.filter((r) => r.effect === "show");
    // page after page while something moves (a 300-message look back is six pages); what waits (its body, v16) stays
    const waiting = new Set<number>();
    for (;;) {
      const marks = (await store.whatMatters.wanted.marks.page(MARKS_PAGE + waiting.size)).filter((m) => !waiting.has(m.messageId));
      this.lookLeft = (await store.whatMatters.wanted.marks.count("look")) || null;
      if (!marks.length) break;
      for (const mark of marks) {
        if (generation.signal.aborted) return "stop";
        // the reader's switch, read again before each: turned off, nothing more is read
        const settings = await this.host.settings();
        if (!settings.dated?.enabled || !(await this.host.allowed(settings))) return "stop";
        const next = await this.readOne(mark, record, shows, settings, generation);
        if (next === "stop") return "stop";
        if (next === "waits") waiting.add(mark.messageId);
      }
    }
    this.lookLeft = null;
    return "next";
  }

  private async readOne(mark: WantedMark, record: WhatMattersPreferences, shows: readonly PreferenceRule[], settings: AppSettings, generation: AbortController): Promise<"next" | "stop" | "waits"> {
    const { store } = this.host;
    const consume = async () => {
      await store.whatMatters.wanted.marks.consume(mark.messageId);
      return "next" as const;
    };
    // v16 first: its items are what this one mustn't repeat (its pass's end wakes this one again: `caughtUp`)
    if (await store.dated.marks.pendingOn(mark.threadId, mark.arrivedAt + 1)) return "waits";
    const src = await store.dated.source(mark.messageId);
    // the owner's rule: Spam reaches no AI, the whole thread's; nor an account not reading, a muted sender, an untrusted one
    if (!src || src.draft || src.sent || src.own || src.spam || src.trash || src.threadSpam) return consume();
    if (!this.host.gate.reads(src.accountId)) return consume();
    if (silenced(src, await silenceOf(store))) return consume();
    const accounts = await store.accounts.list();
    if ((await untrustedSenders([src.fromEmail], (keys) => store.dated.trusted(keys), accounts.map((a) => a.email))).size) return consume();
    // its body first (it may come later: the mark waits, at most its 3 days)
    if (src.bodyState !== "full" && !src.bodyUnavailable) return "waits";
    const raw = (await store.aiSummaries.text([{ messageId: src.id, limit: WANTED_TEXT_CHARS * 2 }])).get(src.id) ?? "";
    const text = withoutQuotes(raw);
    const wanting = wantedBy(shows, { senderKey: src.senderKey, subject: src.subject, fromName: src.fromName, text });
    if (!wanting.length || (!text.trim() && !src.subject.trim())) return consume();
    const language = await readerLanguage(store, settings);
    const ids = new Map(wanting.map((r, i) => [`r${i + 1}`, r]));
    // v16's items aren't repeated; one the words brought before is, so its finish adds this rule as a reason too (the Codex
    // code review: an item two shows want shows while either does)
    const already = (await store.dated.ofThread(src.threadId)).filter((r) => r.messageId === src.id);
    const stop = new AbortController();
    this.leaving = { revision: record.revision, reading: true, sources: [{ messageId: src.id, threadId: src.threadId, senderKey: src.senderKey }], stop };
    try {
      const ai = await this.host.forTask({ foreground: false });
      const signal = AbortSignal.any([generation.signal, stop.signal]);
      const readerName = accounts.find((a) => a.id === src.accountId)?.displayName ?? "";
      const result = await ai.readWanted(
        {
          text: text.slice(0, WANTED_TEXT_CHARS),
          subject: src.subject,
          from: { name: src.fromName || src.fromEmail.split("@")[0]!, automated: src.automated || !src.person },
          reader: readerName,
          receivedAt: inWords(src.date, language),
          zone: readerZone(),
          language,
          rules: [...ids].map(([id, r]) => ({ id, about: r.about ?? null, unless: r.unless ?? null, understood: r.understood, ...(r.kinds?.length ? { kinds: r.kinds } : {}) })),
          open: already.map((r) => ({ kind: r.kind, text: r.text })),
        },
        signal,
      );
      if (signal.aborted) return stop.signal.aborted && !generation.signal.aborted ? "next" : "stop";
      const rows = checkWanted(result, { text, subject: src.subject, arrivedAt: src.date, rules: ids, already });
      const outcome = await store.whatMatters.wanted.finish({ messageId: src.id, threadId: src.threadId, senderKey: src.senderKey, arrivedAt: src.date, rows, now: this.host.now(), model: ai.model, provider: ai.providerId, promptVersion: WANTED_PROMPT_VERSION, fromLook: mark.source === "look", revision: record.revision });
      this.wantedAttempts.delete(src.id);
      if (outcome === "stale") return "stop";
      if (outcome === "written" && rows.length) this.host.changed();
      return "next";
    } catch (error) {
      if (stop.signal.aborted && !generation.signal.aborted) return "next";
      if (generation.signal.aborted) return "stop";
      const verdict = await this.failed(error);
      if (verdict === "drop") return consume();
      if (verdict === "retry") {
        const tries = (this.wantedAttempts.get(src.id) ?? 0) + 1;
        if (tries >= MAX_ATTEMPTS) {
          this.wantedAttempts.delete(src.id);
          await consume();
        } else this.wantedAttempts.set(src.id, tries);
      }
      return "stop";
    } finally {
      if (this.leaving?.stop === stop) this.leaving = null;
    }
  }

  /** One rule for both passes: a pause, a hold or a drop, as the dated reader's (plan 132's table). */
  private async failed(error: unknown): Promise<"drop" | "retry" | "pause"> {
    if (error instanceof DailyLimitError || error instanceof MonthlyLimitError) {
      this.paused = { kind: error.kind, message: error.message, ...(error.i18n ? { i18n: error.i18n } : {}) };
      return "pause";
    }
    if (!(error instanceof AiError)) captureError(error instanceof Error ? new Error(error.name) : new Error("error"), { code: "ai.failed" });
    const kind: AiErrorKind = error instanceof AiError ? error.kind : "unavailable";
    this.host.log("info", "what matters words failed", { aiKind: kind });
    switch (kind) {
      case "cancelled":
        this.again = true;
        return "pause";
      case "auth":
      case "not_configured":
      case "blocked":
        this.paused = { kind, message: error instanceof Error ? error.message : String(error), ...(error instanceof AiError && error.i18n ? { i18n: error.i18n } : {}) };
        return "pause";
      case "invalid_output":
      case "refused":
      case "unsupported":
        return "drop";
      default:
        this.heldUntil = this.host.now() + RETRY_WAIT_MS;
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.wake();
          }, RETRY_WAIT_MS);
          (this.retryTimer as { unref?: () => void }).unref?.();
        }
        return "retry";
    }
  }
}

/**
 * Which semantic rules apply to each row (rule keys by row key), as the projection reads them: the matcher's first reading,
 * then a second question where a mistake would cost the person a row (the held-out eval): a hide it matched is confirmed,
 * strictly, before it counts; a row no `only` kept is asked about again, leniently, before it's hidden. A rule counts only
 * for a row its exact parts reach (revision 12). Shared by the worker and the eval, so both judge the same way.
 */
export async function judgeRows(ai: Pick<AiTasks, "matchPreferences">, rules: readonly PreferenceRule[], rows: readonly { row: RowTarget | (PreferenceTarget & { key: string }); target: MatchTarget }[], signal?: AbortSignal): Promise<Map<string, string[]>> {
  const ids = new Map<string, PreferenceRule>();
  const matchRules: MatchRule[] = [];
  for (const r of rules) {
    if (r.effect === "show" || !isSemantic(r)) continue;
    const id = `r${ids.size + 1}`;
    ids.set(id, r);
    matchRules.push({ id, effect: r.effect as MatchRule["effect"], about: r.about ?? null, unless: r.unless ?? null, ...(r.kinds?.length ? { kinds: r.kinds } : {}) });
  }
  const byTarget = new Map<string, Set<string>>(rows.map((r) => [r.row.key, new Set<string>()]));
  const rowOf = new Map(rows.map((r) => [r.target.id, r]));
  const take = (matches: readonly { target: string; rule: string }[]) => {
    const out: { row: (typeof rows)[number]; rule: PreferenceRule }[] = [];
    for (const m of matches) {
      const row = rowOf.get(m.target);
      const rule = ids.get(m.rule);
      if (row && rule && semanticReaching([rule], row.row).length) out.push({ row, rule });
    }
    return out;
  };
  const first = take(await ai.matchPreferences({ rules: matchRules, targets: rows.map((r) => r.target) }, signal));
  for (const m of first) if (m.rule.effect !== "hide") byTarget.get(m.row.row.key)!.add(m.rule.key);
  // the hides, confirmed: only the rows and rules a first reading matched
  const hides = first.filter((m) => m.rule.effect === "hide");
  if (hides.length) {
    const hideIds = new Set(hides.map((m) => [...ids].find(([, r]) => r === m.rule)![0]));
    const confirmRows = [...new Set(hides.map((m) => m.row))];
    for (const m of take(await ai.matchPreferences({ rules: matchRules.filter((r) => hideIds.has(r.id)), targets: confirmRows.map((r) => r.target), mode: "confirm" }, signal))) {
      if (m.rule.effect === "hide" && hides.some((h) => h.row === m.row && h.rule === m.rule)) byTarget.get(m.row.row.key)!.add(m.rule.key);
    }
  }
  // the rows an `only` would hide (none kept them, exactly or judged), asked about again
  const onlies = rules.filter((r) => r.effect === "only");
  const semanticOnlies = matchRules.filter((r) => r.effect === "only");
  if (semanticOnlies.length) {
    const dropped = rows.filter((r) => !onlies.some((o) => exactlyReaches(o, r.row) && (!isSemantic(o) || byTarget.get(r.row.key)!.has(o.key))));
    const reached = dropped.filter((r) => semanticOnlies.some((o) => semanticReaching([ids.get(o.id)!], r.row).length));
    if (reached.length) for (const m of take(await ai.matchPreferences({ rules: semanticOnlies, targets: reached.map((r) => r.target), mode: "recheck" }, signal))) if (m.rule.effect === "only") byTarget.get(m.row.row.key)!.add(m.rule.key);
  }
  return new Map([...byTarget].map(([k, v]) => [k, [...v]]));
}

// ─── pure parts ────────────────────────────────────────────────────────────

const squash = (s: string) => normalizeText(s).replace(/[“”‘’«»"'`]/gu, "").replace(/\s+/gu, " ").trim();

/** The mail around a quote (its paragraph's neighbourhood), else its start: what the matcher sees of a row's mail. */
export function excerptAround(text: string, quote: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!quote.trim()) return flat.slice(0, max);
  const at = squash(flat).indexOf(squash(quote).slice(0, 60));
  if (at < 0) return flat.slice(0, max);
  const start = Math.max(0, at - Math.floor((max - Math.min(quote.length, max)) / 2));
  return flat.slice(start, start + max);
}

/**
 * The second reader's local checks (§5): a rule it was given; the quote the mail's own words (subject or text); a day that
 * parses and is ahead (`datedTiming`: not past at arrival, within a year); never what the message already has (v16's items or
 * an earlier reading's); and the safety checks v16's items get (a scam's pressure, gift cards, secrets).
 */
export function checkWanted(result: WantedResult, o: { text: string; subject: string; arrivedAt: number; rules: ReadonlyMap<string, PreferenceRule>; already: readonly { kind: DatedKind; text: string; dueDay?: string; quote?: string }[] }): WantedWrite[] {
  const mail = squash(`${o.subject}\n${o.text}`);
  // a scam's pressure or gift cards anywhere in the mail: nothing from it at all (the Codex code review: a quoted offer
  // beside a demand for codes in the next sentence). A show brings in what the app leaves out, never what it keeps out
  if (scamPressure(`${o.subject}\n${o.text}`) || giftCardScam(`${o.subject}\n${o.text}`)) return [];
  const rows: WantedWrite[] = [];
  for (const item of result.items) {
    const rule = o.rules.get(item.rule);
    if (!rule) continue;
    const quote = squash(item.quote);
    if (quote.length < 3 || !mail.includes(quote)) continue;
    if (rule.kinds?.length && !rule.kinds.includes(item.kind as PreferenceKind)) continue;
    if (asksForSecrets({ text: item.text, quote: item.quote }) || asksForSecrets({ text: o.subject, quote: o.text })) continue;
    // an item with no day is news the user asked to see: shown for its week, as an alert is (never Missed)
    const kind: DatedKind = item.due ? item.kind : "alert";
    const timing = datedTiming({ kind, due: item.due, time: item.time, arrivedAt: o.arrivedAt });
    if (!timing) continue;
    if (o.already.some((a) => a.kind === kind && (squash(a.text) === squash(item.text) || (a.quote && squash(a.quote) === quote)))) continue;
    // the same item for two rules: one item, both reasons
    const same = rows.find((r) => r.kind === kind && r.dueDay === timing.dueDay && squash(r.quote) === quote);
    if (same) {
      if (!same.rules.includes(rule.key)) same.rules.push(rule.key);
      continue;
    }
    rows.push({ kind, text: item.text.trim(), quote: item.quote.trim(), dueDay: timing.dueDay, dueAt: timing.dueAt, timed: timing.timed, dated: timing.dated, actAt: timing.actAt, rules: [rule.key] });
  }
  return rows;
}

/** For the tests and the projection: a decision with no verdicts (the exact rules alone). */
export const exactDecision = (rules: readonly PreferenceRule[], t: PreferenceTarget) => preferenceDecision(rules, t, undefined, verdictBasis(rules));

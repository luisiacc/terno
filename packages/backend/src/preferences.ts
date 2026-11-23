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
import { PREFERENCE_VERDICTS_MAX, WANTED_LOOK_MAX, wantedAsDated, type MailStore, type WantedMark, type WantedWrite } from "@terno/store";
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
  /** what What matters holds changed (items came, closed or moved): the list and the count read again */
  changed(): void;
  /** only what shows changed (verdicts): the list and the count project again, nothing re-read (the Astra review) */
  shown(): void;
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

const RETRY_WAIT_MS = 60_000;
/** a failed verdict (refused, gated off) holds this long, then the row is asked again */
const FAILED_KEPT_MS = 60 * 60_000;
/** the matcher's queue at most (rows a projection found unjudged, newest kept) */
const QUEUE_MAX = 4000;
/** the second reader's marks read for one drain */
const MARKS_READ = 1000;
/** status to the windows at most this often while work runs */
const STATUS_EVERY_MS = 1000;
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

/** a row's target, made once per row object (the projection's rows are cached between changes: no hash each time) */
const targetsOfRows = new WeakMap<object, RowTarget>();

export function datedTarget(r: DatedRow): RowTarget {
  let t = targetsOfRows.get(r);
  if (!t) targetsOfRows.set(r, (t = makeDatedTarget(r)));
  return t;
}

function makeDatedTarget(r: DatedRow): RowTarget {
  const wanted = r.id < 0;
  const id = wanted ? -r.id : r.id;
  return { key: `${wanted ? "n" : "d"}:${id}:${rowPrint(r.kind, r.text, r.quote, r.dueDay)}`, source: wanted ? "wanted" : "dated", id, threadId: r.threadId, messageId: r.messageId, kind: r.kind, senderKey: r.senderKey, since: r.createdAt, text: r.text, quote: r.quote };
}

export function promiseTarget(p: FollowupRow): RowTarget {
  let t = targetsOfRows.get(p);
  if (!t) targetsOfRows.set(p, (t = makePromiseTarget(p)));
  return t;
}

function makePromiseTarget(p: FollowupRow): RowTarget {
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
  async save(text: string, expect: number, signal?: AbortSignal): Promise<{ preferences: WhatMattersPreferences } | { stale: true; preferences: WhatMattersPreferences }> {
    if (text.length > PREFERENCES_TEXT_MAX) throw new AiError(L("errors.whatMatters.wordsTooLong", { max: PREFERENCES_TEXT_MAX }), "invalid_output");
    if (!text.trim()) {
      const cleared = await this.clear(expect);
      return "stale" in cleared ? { stale: true, preferences: await this.record() } : { preferences: cleared.preferences };
    }
    const settings = await this.host.settings();
    const language = await readerLanguage(this.host.store, settings);
    const ai = await this.host.forTask({ foreground: true });
    const compiled = await ai.compilePreferences({ text, language }, signal);
    // the app's own note in each window's language (its catalog message, the Fable review), the compile's in the words'
    const { rules, notes } = checkPreferences(compiled, text, (said) => {
      const l = L("whatMatters.words.unclear", { said: said.slice(0, 80) });
      return { text: l.message, i18n: { key: l.key, ...(l.params ? { params: l.params } : {}) } };
    });
    const saved = await this.host.store.whatMatters.preferences.save(
      { text, rules, notes, compiledWith: { version: PREFERENCES_COMPILER_VERSION, provider: ai.providerId, model: ai.model }, savedAt: this.host.now(), language },
      expect,
    );
    if (!saved) {
      this.cache = null;
      return { stale: true, preferences: await this.record() };
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

  // ─── verdicts, kept in memory for the projection (only the worker writes them) ───

  private verdictCache = new Map<string, PreferenceVerdict & { failed: boolean }>();
  private verdictBasisCached = "";

  /** One store read for the keys the cache hasn't seen (the projection runs on every mailbox change: the Fable review). */
  private async verdictsOf(keys: readonly string[], basis: string): Promise<Map<string, PreferenceVerdict & { failed: boolean }>> {
    if (basis !== this.verdictBasisCached) {
      this.verdictCache.clear();
      this.verdictBasisCached = basis;
    }
    const missing = keys.filter((k) => !this.verdictCache.has(k));
    if (missing.length) {
      const read = await this.host.store.whatMatters.verdicts.get(missing);
      if (this.verdictCache.size + read.size > PREFERENCE_VERDICTS_MAX) this.verdictCache.clear();
      for (const [k, v] of read) this.verdictCache.set(k, v);
    }
    const out = new Map<string, PreferenceVerdict & { failed: boolean }>();
    for (const k of keys) {
      const v = this.verdictCache.get(k);
      if (v) out.set(k, v);
    }
    return out;
  }

  /** The worker wrote verdicts: the cache takes them as written. */
  noteVerdicts(rows: readonly (PreferenceVerdict & { failed?: boolean })[]): void {
    for (const v of rows) if (v.basis === this.verdictBasisCached) this.verdictCache.set(v.target, { ...v, failed: v.failed === true });
  }

  /** verdicts pruned or cleared: read again from the store */
  forgetVerdicts(): void {
    this.verdictCache.clear();
  }

  /** Clear AI data: what AI made of the words goes (verdicts, wanted items, marks); the words stay, they're the user's */
  async clearAiData(): Promise<void> {
    this.forgetVerdicts();
    await this.worker.stop();
    await this.host.store.whatMatters.verdicts.clear();
    await this.host.store.whatMatters.wanted.clear();
    this.host.changed();
  }

  /**
   * The projection's view of the words: none (null) for the empty box, so nothing else runs. The verdicts for `targets` are
   * read in one batch; those a semantic rule could reach and that have no current verdict are handed to the worker.
   */
  async visibility(targets: readonly RowTarget[], o: { ask: boolean; from?: "list" | "count" }): Promise<Visibility | null> {
    const record = await this.record();
    const rules = activeRules(record);
    if (!rules.length) return null;
    const basis = verdictBasis(rules);
    const now = this.host.now();
    // a row an exact hide already takes away isn't asked about (no verdict could bring it back: the Fable review)
    const exactHides = rules.filter((r) => r.effect === "hide" && !isSemantic(r));
    const reaching = targets.filter((t) => semanticReaching(rules, t).length && !exactHides.some((r) => exactlyReaches(r, t)));
    const verdicts = reaching.length ? await this.verdictsOf(reaching.map((t) => t.key), basis) : new Map<string, PreferenceVerdict & { failed: boolean }>();
    // a failure is a verdict for a while only: then it's asked again (an outage never ends a rule for good, the Fable review)
    for (const [key, v] of verdicts) if (v.failed && now - v.at > FAILED_KEPT_MS) verdicts.delete(key);
    const savedAt = record.savedAt ?? 0;
    const blocked = this.worker.blocked();
    const unjudged = reaching.filter((t) => verdicts.get(t.key)?.basis !== basis);
    if (o.ask && reaching.length) this.worker.want(unjudged, reaching.map((t) => t.key), o.from ?? "list");
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
  async lookOffer(): Promise<{ count: number; tokensIn: number; tokensOut: number; revision: number; looked: boolean } | null> {
    const { revision } = await this.record();
    const rules = (await this.rules()).filter((r) => r.effect === "show");
    if (!rules.length) return null;
    // looked already for these words: a second yes would buy the same readings again (the Astra and Fable reviews)
    if ((await this.host.store.settings.get<number | null>(LOOK_REVISION_KEY, null)) === revision) return { count: 0, tokensIn: 0, tokensOut: 0, revision, looked: true };
    const picks = await this.lookPicks(rules);
    // the yes reads what was counted, without walking the mailbox again
    this.offered = { revision, picks };
    return { count: picks.length, tokensIn: picks.length * WANTED_TOKENS_IN, tokensOut: picks.length * WANTED_TOKENS_OUT, revision, looked: false };
  }

  /** the last offer's picks, for its words */
  private offered: { revision: number; picks: Awaited<ReturnType<WhatMattersWords["lookPicks"]>> } | null = null;

  /**
   * The user's yes: the picks marked for the second reader, after new mail. The yes is for these words (the Codex code
   * review): it's recorded with their revision, and the worker reads the look's marks only while that's still the words'
   * (a Clear or another Save meanwhile drops them, never reads old mail under new rules).
   */
  async look(offered: number): Promise<number | "stale"> {
    // the yes is for the words and the count it was shown with: words saved since (another window) are asked again
    const { revision } = await this.record();
    if (revision !== offered) return "stale";
    const rules = (await this.rules()).filter((r) => r.effect === "show");
    if (!rules.length) return 0;
    // a yes is once per words: a second (a double click, another window) queues nothing more
    if ((await this.host.store.settings.get<number | null>(LOOK_REVISION_KEY, null)) === revision) return 0;
    const picks = this.offered?.revision === revision ? this.offered.picks : await this.lookPicks(rules);
    this.offered = null;
    if ((await this.host.store.whatMatters.preferences.get()).revision !== revision) return "stale";
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
    const shows = (await this.rules()).filter((r) => r.effect === "show");
    if (!shows.length) return;
    await this.worker.retire();
    // and what's done or no show wants any more goes past its days, with the words unchanged too (the Astra review)
    await this.host.store.whatMatters.wanted.reconcile(new Set(shows.map((r) => r.key)), this.host.now());
  }

  /** The record read again from the store (a test that writes it directly; nothing in the app does). */
  reload(): void {
    this.cache = null;
    this.forgetVerdicts();
  }

  private async lookPicks(rules: readonly PreferenceRule[]) {
    const { store } = this.host;
    const now = this.host.now();
    const walked = await store.whatMatters.wanted.lookCandidates(now - LOOK_DAYS * 86_400_000, LOOK_WALK);
    const silence = await silenceOf(store);
    const picks: typeof walked = [];
    // the bodies only when a cue may be in one (a rule by sender or name alone decides on the headers)
    const needsText = rules.some((r) => r.cues?.length);
    await this.host.runBudgeted(walked, async (chunk) => {
      // the cap reached, nothing more is read (the Astra review)
      if (picks.length >= WANTED_LOOK_MAX) return;
      const open = chunk.filter((m) => this.host.gate.reads(m.accountId) && !silenced({ senderKey: addressKey(m.fromEmail), date: m.date }, silence));
      if (!open.length) return;
      const texts = needsText ? await store.aiSummaries.text(open.map((m) => ({ messageId: m.id, limit: WANTED_TEXT_CHARS }))) : new Map<number, string>();
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
  /** the rows the last list and the last count reached: kept from the verdicts' prune (the Astra review) */
  private asked = { list: new Set<string>(), count: new Set<string>() };
  private total = 0;
  private lastStatus = "";
  private statusAt = 0;
  /** this drain's marks, read once (the Astra review: never re-read and re-sorted a page at a time) */
  private markQueue: WantedMark[] | null = null;
  private leaving: Leaving | null = null;
  private paused: { kind: AiErrorKind; message: string; i18n?: I18nRef } | null = null;
  private heldUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lookLeft: number | null = null;
  /** this drain's marks that wait (a body, v16's reading): passed over until the next wake */
  private wantedChecked = false;

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

  /**
   * The projection's rows: those a semantic rule reaches are kept from the verdicts' prune (the list's and the count's alike,
   * until the words change), the unjudged queued once each and the worker woken. Nothing queued, nothing runs; a pause or
   * a hold wakes nothing either (each mailbox change projects).
   */
  want(targets: readonly RowTarget[], reaching: readonly string[], from: "list" | "count"): void {
    this.asked[from] = new Set(reaching);
    let added = false;
    for (const t of targets) {
      if (this.queue.has(t.key)) continue;
      this.queue.set(t.key, t);
      added = true;
    }
    // bounded: the oldest asked go first (a later projection asks again for what still shows)
    for (const key of this.queue.keys()) {
      if (this.queue.size <= QUEUE_MAX) break;
      this.queue.delete(key);
    }
    this.total = Math.max(reaching.length, this.queue.size);
    if (added) {
      this.tick();
      if (!this.blocked()) this.wake();
    }
  }

  /** The status to the windows when it changed, at most every second while work runs (`force`: now). */
  private tick(force = false): void {
    const status = JSON.stringify(this.status());
    if (status === this.lastStatus) return;
    if (!force && this.host.now() - this.statusAt < STATUS_EVERY_MS) return;
    this.lastStatus = status;
    this.statusAt = this.host.now();
    void this.words.state().then((s) => this.host.emit(s), () => {});
  }

  /** The words changed: work for the old ones stops; marks the new ones don't want go; wanted items' reasons are brought in step. */
  async rulesChanged(rules: readonly PreferenceRule[]): Promise<void> {
    this.generation.abort();
    this.generation = new AbortController();
    this.leaving?.stop.abort();
    this.queue.clear();
    this.asked = { list: new Set(), count: new Set() };
    this.paused = null;
    this.words.forgetVerdicts();
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
    // what's in flight stops, whatever moved: a provider switched mid-judgment must never get the follow-up question (the
    // Codex re-review); what's queued is asked again on the provider now set
    this.generation.abort();
    this.generation = new AbortController();
    this.leaving?.stop.abort();
    if (!allowed) this.queue.clear();
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
    this.markQueue = null;
    this.wantedChecked = false;
    try {
      do {
        this.again = false;
        const generation = this.generation;
        const record = await this.words.record();
        const rules = activeRules(record);
        if (!rules.length) {
          this.queue.clear();
          return;
        }
        if (this.paused || this.host.now() < this.heldUntil) return;
        // nothing to judge and (for a show) nothing marked: done before any other read (the Astra and Fable reviews)
        const shows = rules.some((r) => r.effect === "show");
        if (!this.queue.size && (!shows || !(await this.host.store.whatMatters.wanted.marks.count()))) return;
        const settings = await this.host.settings();
        if (!(await this.host.allowed(settings))) return;
        let more = false;
        if (settings.dated?.enabled && shows) {
          const read = await this.wantedPass(record, rules, settings, generation);
          if (read === "stop") return;
          more = read === "more";
        }
        if ((await this.matchPass(record, rules, generation)) === "stop") return;
        // a page at a time: what's judged waits for no more than a page of a look back (the Codex re-review)
        if (more) this.again = true;
      } while (this.again);
    } finally {
      this.running = false;
      this.markQueue = null;
      // the windows hear only when what they show changed (idle stays quiet)
      this.tick(true);
    }
  }

  // ─── the matcher ─────────────────────────────────────────────────────────

  private async matchPass(record: WhatMattersPreferences, rules: readonly PreferenceRule[], generation: AbortController): Promise<"next" | "stop"> {
    const basis = verdictBasis(rules);
    const savedAt = record.savedAt ?? 0;
    const { store } = this.host;
    let wrote = false;
    // what shows changes only with a verdict that applies a rule, or one for a row withheld meanwhile; the rest wait for the
    // pass's end, one refresh for all of them (the Astra review: each batch re-read the whole of Today)
    let owed = false;
    const put = async (rows: (PreferenceVerdict & { failed?: boolean })[], urgent: boolean) => {
      if (!(await store.whatMatters.verdicts.put(rows, record.revision))) return false;
      this.words.noteVerdicts(rows);
      wrote = true;
      if (urgent) {
        this.host.shown();
        owed = false;
      } else owed = true;
      return true;
    };
    const fresh = (t: RowTarget) => t.since > savedAt && this.host.now() - t.since < WITHHOLD_MS;
    while (this.queue.size && !generation.signal.aborted) {
      const batch: RowTarget[] = [];
      for (const t of this.queue.values()) {
        batch.push(t);
        if (batch.length >= MATCH_BATCH) break;
      }
      const built = await this.targetsOf(batch, rules);
      const now = this.host.now();
      // rows nothing can be sent for (Spam, Trash, an account not reading, gone): a failed verdict, shown, asked again later
      if (built.skipped.length) {
        if (!(await put(built.skipped.map((t) => ({ target: t.key, basis, rules: [], at: now, failed: true })), built.skipped.some(fresh)))) return "stop";
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
        const verdicts = built.targets.map((b) => ({ target: b.row.key, basis, rules: judged.rules.get(b.row.key) ?? [], at: this.host.now(), ...(judged.failed.has(b.row.key) && { failed: true }) }));
        if (!(await put(verdicts, verdicts.some((v) => v.rules.length) || built.targets.some((b) => fresh(b.row))))) return "stop";
        for (const b of built.targets) this.queue.delete(b.row.key);
        this.tick();
      } catch (error) {
        if (stop.signal.aborted && !generation.signal.aborted) continue;
        if (generation.signal.aborted) return "stop";
        const verdict = await this.failed(error);
        if (verdict === "drop") {
          // what can never be judged (refused, invalid): shown, and asked again only after a while
          if (!(await put(built.targets.map((b) => ({ target: b.row.key, basis, rules: [], at: this.host.now(), failed: true })), built.targets.some((b) => fresh(b.row))))) return "stop";
          for (const b of built.targets) this.queue.delete(b.row.key);
          continue;
        }
        // a provider's hiccup or a pause: the rows stay queued, asked when it's back (never a verdict: the Fable review)
        if (owed) this.host.shown();
        return "stop";
      } finally {
        if (this.leaving?.stop === stop) this.leaving = null;
      }
    }
    if (owed) this.host.shown();
    if (wrote) {
      await store.whatMatters.verdicts.prune(basis, new Set([...this.asked.list, ...this.asked.count]));
      this.words.forgetVerdicts();
    }
    return "next";
  }

  /** Each row's words for the matcher, read locally (bodies in one batch), and only for a row whose source may go to AI now. */
  private async targetsOf(batch: readonly RowTarget[], rules: readonly PreferenceRule[]): Promise<{ targets: { row: RowTarget; target: MatchTarget; source: Leaving["sources"][number] }[]; skipped: RowTarget[] }> {
    const { store } = this.host;
    const silence = await silenceOf(store);
    const skipped: RowTarget[] = [];
    const waiting = batch.filter((r) => r.source === "waiting");
    const messages = waiting.length ? await store.today.waiting.rows(waiting.map((r) => ({ threadId: r.threadId, since: r.waitingSince ?? 0 })), this.host.now(), { messages: true }) : new Map();
    const ready: { row: RowTarget; src: NonNullable<Awaited<ReturnType<MailStore["dated"]["source"]>>> }[] = [];
    for (const row of batch) {
      const messageId = row.source === "waiting" ? (messages.get(row.threadId)?.message ?? null) : row.messageId;
      const src = semanticReaching(rules, row).length && messageId !== null ? await store.dated.source(messageId) : null;
      if (!src || src.spam || src.trash || src.threadSpam || !this.host.gate.reads(src.accountId) || silenced(src, silence)) skipped.push(row);
      else ready.push({ row, src });
    }
    const texts = ready.length ? await store.aiSummaries.text(ready.map((r) => ({ messageId: r.src.id, limit: MATCH_EXCERPT_CHARS * 4 }))) : new Map<number, string>();
    const targets = ready.map(({ row, src }, i) => ({
      row,
      target: { id: `t${i + 1}`, kind: row.kind, text: row.source === "waiting" ? src.subject : row.text, from: src.fromName || src.fromEmail.split("@")[0]!, subject: src.subject, excerpt: excerptAround(withoutQuotes(texts.get(src.id) ?? ""), row.quote, MATCH_EXCERPT_CHARS) },
      source: { messageId: src.id, threadId: row.threadId, senderKey: src.senderKey },
    }));
    return { targets, skipped };
  }

  // ─── the second reader ───────────────────────────────────────────────────

  /** A page of this drain's marks ("more": another waits); what waits (its body, v16's reading) waits for the next wake. */
  private async wantedPass(record: WhatMattersPreferences, rules: readonly PreferenceRule[], _settings: AppSettings, generation: AbortController): Promise<"next" | "more" | "stop"> {
    const { store } = this.host;
    if (!this.wantedChecked) {
      // once a drain: marks past their days go, and what's over is retired so the open bound never refuses for old items
      // (the Codex re-review: expired while the app was closed)
      this.wantedChecked = true;
      await store.whatMatters.wanted.marks.prune(this.host.now());
      await this.retire();
    }
    if (!this.markQueue) {
      // the look back's marks only for the words it was said yes to (the Codex code review), read then with the rest
      if ((await store.whatMatters.wanted.marks.count("look")) && (await store.settings.get<number | null>(LOOK_REVISION_KEY, null)) !== record.revision) await store.whatMatters.wanted.marks.clearLook();
      this.markQueue = await store.whatMatters.wanted.marks.page(MARKS_READ);
    }
    this.lookLeft = this.markQueue.filter((m) => m.source === "look").length || null;
    const marks = this.markQueue.splice(0, MARKS_PAGE);
    if (!marks.length) return "next";
    const shows = rules.filter((r) => r.effect === "show");
    // read once a page: who the user is, what's muted (the Fable review: they were read a mark at a time)
    const pass = { accounts: await store.accounts.list(), silence: await silenceOf(store) };
    for (const mark of marks) {
      if (generation.signal.aborted) return "stop";
      // the reader's switch, read again before each: turned off, nothing more is read
      const settings = await this.host.settings();
      if (!settings.dated?.enabled || !(await this.host.allowed(settings))) return "stop";
      if ((await this.readOne(mark, record, shows, settings, generation, pass)) === "stop") return "stop";
      this.tick();
    }
    return this.markQueue.length ? "more" : "next";
  }

  private async readOne(mark: WantedMark, record: WhatMattersPreferences, shows: readonly PreferenceRule[], settings: AppSettings, generation: AbortController, pass: { accounts: readonly { id: number; email: string; displayName: string }[]; silence: Awaited<ReturnType<typeof silenceOf>> }): Promise<"next" | "stop" | "waits"> {
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
    if (silenced(src, pass.silence)) return consume();
    if ((await untrustedSenders([src.fromEmail], (keys) => store.dated.trusted(keys), pass.accounts.map((a) => a.email))).size) return consume();
    // by its headers first: a show none of whose senders, names or subject cues fit, and none of which has cues for a body,
    // reads no body at all (the Astra review)
    if (!wantedBy(shows, { senderKey: src.senderKey, subject: src.subject, fromName: src.fromName }).length && !shows.some((r) => r.cues?.length && !(r.senders?.length && !r.names?.length))) return consume();
    // its body first (it may come later: the mark waits, at most its 3 days)
    if (src.bodyState !== "full" && !src.bodyUnavailable) return "waits";
    const raw = (await store.aiSummaries.text([{ messageId: src.id, limit: WANTED_TEXT_CHARS }])).get(src.id) ?? "";
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
      const readerName = pass.accounts.find((a) => a.id === src.accountId)?.displayName ?? "";
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
      if (outcome === "stale") return "stop";
      if (outcome === "written" && rows.length) this.host.changed();
      return "next";
    } catch (error) {
      if (stop.signal.aborted && !generation.signal.aborted) return "next";
      if (generation.signal.aborted) return "stop";
      // a provider's hiccup keeps the mark (it goes with its days); what can never be read goes now
      if ((await this.failed(error)) === "drop") return consume();
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
export async function judgeRows(ai: Pick<AiTasks, "matchPreferences">, rules: readonly PreferenceRule[], rows: readonly { row: RowTarget | (PreferenceTarget & { key: string }); target: MatchTarget }[], signal?: AbortSignal): Promise<{ rules: Map<string, string[]>; failed: Set<string> }> {
  const ids = new Map<string, PreferenceRule>();
  const idOf = new Map<PreferenceRule, string>();
  const matchRules: MatchRule[] = [];
  for (const r of rules) {
    if (r.effect === "show" || !isSemantic(r)) continue;
    const id = `r${ids.size + 1}`;
    ids.set(id, r);
    idOf.set(r, id);
    matchRules.push({ id, effect: r.effect as MatchRule["effect"], about: r.about ?? null, unless: r.unless ?? null, ...(r.kinds?.length ? { kinds: r.kinds } : {}) });
  }
  const byTarget = new Map<string, Set<string>>(rows.map((r) => [r.row.key, new Set<string>()]));
  // rows whose second question failed (refused, invalid): their verdict fails open, the rest of the batch keeps its own
  const failed = new Set<string>();
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
  /** a follow-up question: an abort is the caller's; any other failure is its rows' alone (the Codex re-review) */
  const followUp = async (input: Parameters<typeof ai.matchPreferences>[0], on: readonly (typeof rows)[number][]) => {
    try {
      return take(await ai.matchPreferences(input, signal));
    } catch (error) {
      // only an answer that can never come (refused, invalid) fails its rows; an outage is the batch's to retry (the Fable review)
      if (signal?.aborted || !(error instanceof AiError) || !TERMINAL.has(error.kind)) throw error;
      for (const r of on) failed.add(r.row.key);
      return [];
    }
  };
  const first = take(await ai.matchPreferences({ rules: matchRules, targets: rows.map((r) => r.target) }, signal));
  for (const m of first) if (m.rule.effect !== "hide") byTarget.get(m.row.row.key)!.add(m.rule.key);
  // the hides, confirmed: only the rows and rules a first reading matched
  const hides = first.filter((m) => m.rule.effect === "hide");
  if (hides.length) {
    const hideIds = new Set(hides.map((m) => idOf.get(m.rule)!));
    const confirmRows = [...new Set(hides.map((m) => m.row))];
    for (const m of await followUp({ rules: matchRules.filter((r) => hideIds.has(r.id)), targets: confirmRows.map((r) => r.target), mode: "confirm" }, confirmRows)) {
      if (m.rule.effect === "hide" && hides.some((h) => h.row === m.row && h.rule === m.rule)) byTarget.get(m.row.row.key)!.add(m.rule.key);
    }
  }
  // the rows no semantic `only` kept, asked about again: an exact keep doesn't spare a row its question, so the verdict is
  // the criterion's own whatever exact rules sit beside it (the Codex re-review: one removed later mustn't leave a miss)
  const semanticOnlies = matchRules.filter((r) => r.effect === "only");
  if (semanticOnlies.length) {
    // (never a row a confirmed hide takes away: keeping it couldn't bring it back, the Astra review)
    const hiddenRows = new Set(hides.filter((h) => byTarget.get(h.row.row.key)!.has(h.rule.key)).map((h) => h.row.row.key));
    const dropped = rows.filter((r) => !hiddenRows.has(r.row.key) && semanticOnlies.some((o) => semanticReaching([ids.get(o.id)!], r.row).length) && !semanticOnlies.some((o) => byTarget.get(r.row.key)!.has(ids.get(o.id)!.key)));
    if (dropped.length) for (const m of await followUp({ rules: semanticOnlies, targets: dropped.map((r) => r.target), mode: "recheck" }, dropped)) if (m.rule.effect === "only") byTarget.get(m.row.row.key)!.add(m.rule.key);
  }
  return { rules: new Map([...byTarget].map(([k, v]) => [k, [...v]])), failed };
}

/** the failures no retry would mend */
const TERMINAL: ReadonlySet<AiErrorKind> = new Set(["invalid_output", "refused", "unsupported"]);

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
    // every rule it answers is a reason (the Codex re-review): it shows while any of them is current
    const answers = item.rules.flatMap((id) => {
      const r = o.rules.get(id);
      return r && (!r.kinds?.length || r.kinds.includes(item.kind as PreferenceKind)) ? [r] : [];
    });
    if (!answers.length) continue;
    const quote = squash(item.quote);
    if (quote.length < 3 || !mail.includes(quote)) continue;
    // (the item's own words: a security footer elsewhere in the mail, "never share your password", isn't the item's ask)
    if (asksForSecrets({ text: item.text, quote: item.quote })) continue;
    // an item with no day is news the user asked to see: shown for its week, as an alert is (never Missed)
    const kind: DatedKind = item.due ? item.kind : "alert";
    const timing = datedTiming({ kind, due: item.due, time: item.time, arrivedAt: o.arrivedAt });
    if (!timing) continue;
    if (o.already.some((a) => a.kind === kind && (squash(a.text) === squash(item.text) || (a.quote && squash(a.quote) === quote)))) continue;
    const keys = answers.map((r) => r.key);
    // the same item twice: one item, every reason
    const same = rows.find((r) => r.kind === kind && r.dueDay === timing.dueDay && squash(r.quote) === quote);
    if (same) {
      for (const k of keys) if (!same.rules.includes(k)) same.rules.push(k);
      continue;
    }
    rows.push({ kind, text: item.text.trim(), quote: item.quote.trim(), dueDay: timing.dueDay, dueAt: timing.dueAt, timed: timing.timed, dated: timing.dated, actAt: timing.actAt, rules: keys });
  }
  return rows;
}

/** For the tests and the projection: a decision with no verdicts (the exact rules alone). */
export const exactDecision = (rules: readonly PreferenceRule[], t: PreferenceTarget) => preferenceDecision(rules, t, undefined, verdictBasis(rules));

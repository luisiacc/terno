import { AiError, costOf, JUDGE_PROMPT_VERSION, type AiTasks } from "@terno/ai";
import { L } from "@terno/i18n";
import { captureError } from "@terno/core/diag";
import {
  chooseSample,
  CONSUMER_DOMAINS,
  habitsOf,
  mailFeatures,
  mergeHabits,
  mergePhrases,
  MIN_SAMPLES,
  phraseSteps,
  reduceMail,
  SAMPLE_LIMITS,
  scopeKeys,
  TrailerCounter,
  withoutTrailers,
  writtenText,
  type Account,
  type AiProviderId,
  type AiStudyProgress,
  type CorpusContext,
  type Habits,
  type MailFeatures,
  type VoiceScope,
  type WritingPrefs,
  type WritingStatus,
  type WritingStudyResult,
  type WrittenMail,
} from "@terno/core";
import { CORPUS_WINDOW, RevisionError, sameRevision, type CorpusHeader, type MailStore, type Platform, type ProfileUpsert, type Revision, type WritingProfileRow } from "@terno/store";
import { SliceClock } from "@terno/store/autocomplete";

/**
 * Plan 133 §2: how someone writes, worked out on this machine with no network and nothing spent. Runs in slices on
 * wake-ups that already happen, no timers, only once the feature has been used (the checkpoint exists from then on).
 *
 * - The revision log says what changed, as additions and removals from each account's window of newest sent mail.
 *   A log that was pruned past the checkpoint costs a walk of headers and the same comparison.
 * - A pass rebuilds one account's scopes from its window, so a removal or a message leaving the window can't linger:
 *   nothing is subtracted, everything is counted again, rarely (`passDue`).
 * - A pass's rows, its window and the checkpoint go in one commit. Interrupted, the account is still due; accounts
 *   done before that aren't read again.
 * - "You" is merged from the accounts' rows, reading no mail.
 */

export const LEARNER_KEY = "writing:learner";
export const STUDY_KEY = "writing:study";
export const windowKey = (accountId: number): string => `writing:window:${accountId}`;

const HEADER_PAGE = 200;
const BODY_PAGE = 16;
/** what's kept of the user's words per message, for phrases and a sample: the rest of a long message adds little */
const WRITTEN_CHARS = 8000;
/** the newest mails phrases are counted over: the counting grows with the words, and these are plenty for a stock phrase */
const PHRASE_MAILS = 1000;
const PERSONS_MAX = 200;
const DOMAINS_MAX = 50;
/** a message to more than this many isn't how someone writes to each of them */
const PERSON_MAX_RECIPIENTS = 5;
const DOMAIN_MIN_ADDRESSES = 2;
const LANGUAGE_MIN = 8;
/** a language with nearly all of a scope's mail is that scope's own row */
const LANGUAGE_ALMOST_ALL = 0.95;
/** at most this often when woken by changes: a sync's burst shouldn't read the log twice over */
const CATCH_UP_EVERY_MS = 30_000;
const CHANGES_PAGE = 64;
const MAX_FAILURES = 3;
/** §3: what a model judgment waits for */
const REFRESH_AFTER: Readonly<Record<VoiceScope, number>> = { you: 20, account: 20, domain: 8, person: 8 };
const REFRESHES_A_DAY = 20;
/** §2: who gets one to start, per account */
const STUDY_DOMAINS = 5;
const STUDY_PEOPLE = 10;
/** how far back a scope's sample looks */
const SAMPLE_HEADERS = 400;

export interface LearnerCheckpoint {
  revision: Revision | null;
  /** changes to each account's window since its last pass, by account id */
  dirty: Record<string, number>;
  /** due whatever the count: a Rebuild, a Reset, a first pass */
  forced: number[];
  /** the accounts "you" was last merged from */
  merged: number[];
  youStale: boolean;
  refreshDay: string | null;
  refreshes: number;
  /** sent messages the profiles count, for Settings */
  messages: number;
  updatedAt: number | null;
}

export interface StudyConsent {
  provider: string;
  /** where the samples were agreed to go, from `destinationOf`: a consent from before this has none, and refreshes nothing */
  destination?: string;
  accountIds: number[];
  at: number;
}

/** Where a request goes, as a user would mean it: another server of the same kind isn't what they agreed to. */
export function destinationOf(ai: Pick<AiTasks, "providerId" | "preset" | "endpoint" | "local">): string {
  return JSON.stringify({ provider: ai.providerId, preset: ai.preset ?? null, origin: URL.canParse(ai.endpoint ?? "") ? new URL(ai.endpoint!).origin : ai.endpoint, local: ai.local });
}

export interface VoiceLearnerHost {
  readonly store: MailStore;
  readonly platform: Pick<Platform, "yield">;
  now(): number;
  prefs(): Promise<WritingPrefs>;
  /** the writing task's model, counted as the limiter's `voice` task */
  forVoice(): Promise<AiTasks>;
  begin(requestId: string, clientId: string): { signal: AbortSignal; release: () => void };
  /** to the one connection that asked */
  studyProgress(clientId: string, progress: AiStudyProgress): void;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
  sliceMs?: number;
}

/**
 * What may be reported of a failure here: its kind and where. A message could hold anything it was reading (a JSON
 * parser's quotes a profile, a provider's quotes a prompt), so it never leaves with one.
 */
export function scrubbed(error: unknown): Error {
  const name = error instanceof AiError ? `AiError:${error.kind}` : error instanceof Error ? error.name : "error";
  const out = new Error(name);
  if (error instanceof Error && error.stack) out.stack = [name, ...error.stack.split("\n").filter((line) => /^\s+at /.test(line))].join("\n");
  return out;
}

export const usesSentMail = (prefs: WritingPrefs, accountId: number): boolean => prefs.global.enabled && (prefs.accounts[String(accountId)]?.useSentMail ?? prefs.global.useSentMail);

const passThreshold = (size: number) => Math.max(1, Math.min(20, Math.floor(size / 20)));

const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const contextOf = (account: Account, names: ReadonlyMap<string, string>): CorpusContext => ({
  signature: account.signature,
  selfNames: [account.senderName, account.displayName, account.senderName.split(/\s+/)[0] ?? ""].filter(Boolean),
  namesOf: (address) => {
    const name = names.get(address);
    return name ? name.split(/\s+/).filter(Boolean) : [];
  },
});

interface CountedMail {
  mail: WrittenMail;
  features: MailFeatures;
}

export class VoiceLearner {
  private stopped = false;
  private running: Promise<void> | null = null;
  private again = false;
  private lastCatchUp = 0;
  private active = false;
  private failures = 0;
  /** ups when the data is cleared or the feature goes off: a pass in flight doesn't commit */
  private epoch = 0;
  /** aborted with each withdrawal: what studies and refreshes run under, on top of their own */
  private permission = new AbortController();
  /** asked for while a run was going */
  private readonly pendingForced = new Set<number>();
  /** each account's window, once read: what's in it, as of the last pass and the log read since */
  private readonly windows = new Map<number, Set<number>>();
  private readonly clock: SliceClock;
  private studying: { requestId: string; total: number } | null = null;
  private studyRun: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  /** the longest stretch between yields, for the budget test */
  get longestSliceMs(): number {
    return this.clock.longestMs;
  }

  constructor(private readonly host: VoiceLearnerHost) {
    this.clock = new SliceClock({ yield: host.platform.yield, sliceMs: host.sliceMs ?? 6 });
  }

  /** Boot: one setting read. Nothing runs unless the feature has been used. */
  start(): Promise<void> {
    this.starting = (async () => {
      if (this.stopped) return;
      this.active = (await this.checkpoint()) !== null;
      if (this.active) this.wake({ force: true });
    })();
    return this.starting;
  }

  /** The feature was used, or its settings opened: from now on it stays on. */
  async activate(): Promise<void> {
    if (this.active || this.stopped) return;
    this.active = true;
    if (!(await this.checkpoint())) {
      const head = await this.host.store.autocomplete.head();
      const accounts = (await this.host.store.accounts.list()).map((a) => a.id);
      await this.save({ revision: head, dirty: {}, forced: accounts, merged: [], youStale: true, refreshDay: null, refreshes: 0, messages: 0, updatedAt: null });
    }
    this.wake({ force: true });
  }

  /** Something changed that may matter (mail, an account, a setting). Coalesced; idle stays idle. */
  wake(o: { force?: boolean } = {}): void {
    if (this.stopped || !this.active || this.failures >= MAX_FAILURES) return;
    const now = this.host.now();
    if (!o.force && now - this.lastCatchUp < CATCH_UP_EVERY_MS) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.lastCatchUp = now;
    this.running = this.run()
      .catch((error: unknown) => {
        this.failures++;
        captureError(scrubbed(error), { code: "ai.failed" });
        this.host.log("warn", "voice learner stopped", error instanceof Error ? error.name : "error");
      })
      .finally(() => {
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.wake({ force: true });
        }
      });
  }

  /** Resolves when the current run (and any it queued) is over. */
  async idle(): Promise<void> {
    await this.starting?.catch(() => {});
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => {});
    await this.studyRun;
  }

  /** Rebuild, Reset: `accountId` undefined means every account. */
  async rebuild(accountId?: number): Promise<void> {
    const ids = accountId !== undefined ? [accountId] : (await this.host.store.accounts.list()).map((a) => a.id);
    for (const id of ids) this.pendingForced.add(id);
    if (!this.active) await this.activate();
    else this.wake({ force: true });
  }

  /** "Learn from my sent mail" or the feature itself changed: off drops judgments and stops what's running. */
  async prefsChanged(before: WritingPrefs, after: WritingPrefs): Promise<void> {
    const { store } = this.host;
    const learns = (p: WritingPrefs, id: number) => p.accounts[String(id)]?.useSentMail ?? p.global.useSentMail;
    const accounts = await store.accounts.list();
    // first of all: what's running may be counting, or asking a provider about, what was just turned off
    if (accounts.some((a) => usesSentMail(before, a.id) && !usesSentMail(after, a.id))) this.withdraw();
    for (const a of accounts) {
      // the setting went off, not the feature: turning drafting off for a while keeps what was learned
      if (learns(before, a.id) && !learns(after, a.id)) await store.writing.profiles.clearJudgments(a.id);
      if (!usesSentMail(before, a.id) && usesSentMail(after, a.id)) this.pendingForced.add(a.id);
    }
    if (before.global.useSentMail && !after.global.useSentMail) await store.writing.profiles.clearJudgments();
    this.wake({ force: true });
  }

  /** Permission went: a pass in flight doesn't commit, and studies and refreshes stop at the provider too. */
  private withdraw(): void {
    this.epoch++;
    this.permission.abort();
    this.permission = new AbortController();
  }

  /** Clear all: nothing learned stays, and it sleeps until the feature is used again. */
  async clear(): Promise<void> {
    this.withdraw();
    this.active = false;
    await this.running?.catch(() => {});
    const cp = await this.checkpoint();
    const ids = new Set([...(cp?.merged ?? []), ...(await this.host.store.accounts.list()).map((a) => a.id)]);
    await this.host.store.writing.profiles.clear([LEARNER_KEY, STUDY_KEY, ...[...ids].map(windowKey)]);
    this.windows.clear();
    this.pendingForced.clear();
  }

  async status(): Promise<WritingStatus> {
    const [cp, prefs, study] = await Promise.all([this.checkpoint(), this.host.prefs(), this.host.store.settings.get<StudyConsent | null>(STUDY_KEY, null)]);
    if (!prefs.global.enabled || !(prefs.global.useSentMail || Object.values(prefs.accounts).some((a) => a.useSentMail))) return { state: "off", messages: cp?.messages ?? 0, updatedAt: cp?.updatedAt ?? null, study };
    if (!cp) return { state: "idle", messages: 0, updatedAt: null, study };
    const learning = this.running !== null || cp.forced.length > 0 || cp.updatedAt === null;
    return { state: learning ? "learning" : "ready", messages: cp.messages, updatedAt: cp.updatedAt, study };
  }

  private checkpoint(): Promise<LearnerCheckpoint | null> {
    return this.host.store.settings.get<LearnerCheckpoint | null>(LEARNER_KEY, null);
  }

  private save(cp: LearnerCheckpoint): Promise<void> {
    return this.host.store.settings.set(LEARNER_KEY, cp);
  }

  private async windowOf(accountId: number): Promise<Set<number> | null> {
    const held = this.windows.get(accountId);
    if (held) return held;
    const ids = await this.host.store.settings.get<number[] | null>(windowKey(accountId), null);
    if (!ids) return null;
    const set = new Set(ids);
    this.windows.set(accountId, set);
    return set;
  }

  // ─── a run ───────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const { store } = this.host;
    if (!store.isOpen) return;
    const epoch = this.epoch;
    const live = () => !this.stopped && epoch === this.epoch && store.isOpen;
    let cp = await this.checkpoint();
    if (!cp) return;
    const prefs = await this.host.prefs();
    const accounts = await store.accounts.list();
    const ids = new Set(accounts.map((a) => a.id));
    this.clock.restart();

    for (const id of this.pendingForced) if (ids.has(id) && !cp.forced.includes(id)) cp.forced.push(id);
    this.pendingForced.clear();
    cp.forced = cp.forced.filter((id) => ids.has(id));
    for (const id of Object.keys(cp.dirty)) if (!ids.has(Number(id))) delete cp.dirty[id];

    cp = await this.catchUp(cp, accounts, prefs, live);
    if (!live()) return;

    let passed = false;
    for (const account of accounts) {
      if (!live()) return;
      if (!usesSentMail(prefs, account.id)) continue;
      const window = await this.windowOf(account.id);
      if (cp.forced.includes(account.id) || !window || (cp.dirty[String(account.id)] ?? 0) >= passThreshold(window.size)) {
        const next = await this.pass(account, cp, live);
        if (!next) return;
        cp = next;
        passed = true;
      }
    }
    if (!live()) return;

    // who "you" is made of changed, or an account did
    const merging = accounts.filter((a) => usesSentMail(prefs, a.id)).map((a) => a.id).sort((a, b) => a - b);
    if (passed || cp.youStale || merging.join() !== cp.merged.join()) cp = await this.mergeYou(cp, merging, epoch);
    if (!live()) return;
    if (passed) await this.refreshJudgments(cp, accounts, prefs, live);
  }

  /** The log since the checkpoint, as changes to the windows; never a body read. */
  private async catchUp(start: LearnerCheckpoint, accounts: readonly Account[], prefs: WritingPrefs, live: () => boolean): Promise<LearnerCheckpoint> {
    const { store } = this.host;
    const cp: LearnerCheckpoint = { ...start, dirty: { ...start.dirty } };
    const head = await store.autocomplete.head();
    if (sameRevision(cp.revision, head)) return cp;
    const note = (accountId: number, by = 1) => {
      cp.dirty[String(accountId)] = (cp.dirty[String(accountId)] ?? 0) + by;
    };
    try {
      let after = cp.revision;
      if (!after) throw new RevisionError("gap", "no revision yet");
      for (;;) {
        const batches = await store.autocomplete.changes(after, head, CHANGES_PAGE);
        if (!batches.length) break;
        for (const batch of batches) {
          if (!live()) return start;
          const sent = batch.messages.filter((m) => m.sent);
          const usable = new Set(sent.length ? await store.writing.corpus.usable(sent.map((m) => m.id)) : []);
          this.clock.restart();
          for (const m of sent) {
            if (!usesSentMail(prefs, m.accountId)) continue;
            const window = await this.windowOf(m.accountId);
            if (!window) continue;
            const inside = window.has(m.id);
            if (inside === usable.has(m.id)) continue;
            note(m.accountId);
            if (inside) window.delete(m.id);
            else window.add(m.id);
          }
          for (const id of batch.removed) {
            for (const a of accounts) {
              const window = await this.windowOf(a.id);
              if (window?.delete(id)) note(a.id);
            }
          }
          after = batch.to;
          await this.clock.tick();
        }
        if (sameRevision(after, head)) break;
      }
    } catch (error) {
      if (!(error instanceof RevisionError)) throw error;
      // pruned past the checkpoint, or another epoch: the headers say what the log can't
      for (const a of accounts) {
        if (!live()) return start;
        if (!usesSentMail(prefs, a.id)) continue;
        const window = await this.windowOf(a.id);
        if (!window) continue;
        const now = new Set((await this.walk(a.id, live)).map((h) => h.id));
        let moved = 0;
        for (const id of now) if (!window.has(id)) moved++;
        for (const id of window) if (!now.has(id)) moved++;
        if (moved) note(a.id, moved);
      }
    }
    cp.revision = head;
    await this.save(cp);
    return cp;
  }

  private async walk(accountId: number, live: () => boolean, limit = CORPUS_WINDOW): Promise<CorpusHeader[]> {
    const out: CorpusHeader[] = [];
    let before: { date: number; id: number } | undefined;
    while (out.length < limit && live()) {
      const page: CorpusHeader[] = await this.host.store.writing.corpus.headers({ accountId, ...(before ? { before } : {}), limit: Math.min(HEADER_PAGE, limit - out.length) });
      if (!page.length) break;
      out.push(...page);
      const last = page[page.length - 1]!;
      before = { date: last.date, id: last.id };
      await this.host.platform.yield();
      this.clock.restart();
    }
    return out;
  }

  /** What the user wrote in these messages, in slices: trailers measured over all of them first. */
  private async read(account: Account, headers: readonly CorpusHeader[], live: () => boolean): Promise<CountedMail[] | null> {
    const names = new Map<string, string>();
    const bases = new Map<number, string>();
    const counter = new TrailerCounter();
    for (const h of headers) for (const [address, name] of Object.entries(h.names)) names.set(address, name);
    for (let i = 0; i < headers.length; i += BODY_PAGE) {
      if (!live()) return null;
      const texts = await this.host.store.writing.corpus.texts(headers.slice(i, i + BODY_PAGE).map((h) => h.id));
      this.clock.restart();
      for (const t of texts) {
        const base = writtenText(t.text, { signature: account.signature }).slice(0, WRITTEN_CHARS);
        bases.set(t.id, base);
        counter.add(base);
        await this.clock.tick();
      }
    }
    const trailers = counter.trailers();
    const context = contextOf(account, names);
    const out: CountedMail[] = [];
    for (const h of headers) {
      const base = bases.get(h.id);
      // no text came for it: nothing to count
      if (base === undefined) continue;
      const mail = reduceMail({ id: h.id, to: h.to, cc: h.cc, at: h.date, isReply: h.isReply, bulk: h.bulk }, withoutTrailers(base, trailers), context);
      out.push({ mail, features: mailFeatures(mail) });
      await this.clock.tick();
    }
    return out;
  }

  private async countScope(scope: VoiceScope, scopeKey: string, accountId: number | null, mails: readonly CountedMail[], upserts: ProfileUpsert[], live: () => boolean): Promise<boolean> {
    if (mails.length < MIN_SAMPLES[scope]) return true;
    const write = async (language: string, subset: readonly CountedMail[]): Promise<boolean> => {
      const habits = habitsOf(subset.map((m) => m.features));
      await this.clock.tick();
      const steps = phraseSteps(subset.slice(0, PHRASE_MAILS).map((m) => m.mail));
      for (;;) {
        const step = steps.next();
        if (step.done) {
          upserts.push({ scope, scopeKey, language, accountId, habitsJson: JSON.stringify(habits), phrasesJson: JSON.stringify(step.value), samples: subset.length });
          return true;
        }
        if (this.clock.due) {
          await this.clock.pause();
          if (!live()) return false;
        }
      }
    };
    if (!(await write("", mails))) return false;
    const byLanguage = new Map<string, CountedMail[]>();
    for (const m of mails) {
      if (!m.mail.language) continue;
      const list = byLanguage.get(m.mail.language);
      if (list) list.push(m);
      else byLanguage.set(m.mail.language, [m]);
    }
    const min = Math.min(LANGUAGE_MIN, MIN_SAMPLES[scope]);
    for (const [language, subset] of byLanguage) {
      if (subset.length < min || subset.length >= mails.length * LANGUAGE_ALMOST_ALL) continue;
      if (!(await write(language, subset))) return false;
    }
    return true;
  }

  /** One account, whole: its rows, its window and the checkpoint in one commit. Null: it was stopped; nothing was written. */
  private async pass(account: Account, cp: LearnerCheckpoint, live: () => boolean): Promise<LearnerCheckpoint | null> {
    const { store } = this.host;
    const headers = await this.walk(account.id, live);
    if (!live()) return null;
    const mails = await this.read(account, headers, live);
    if (!mails || !live()) return null;

    const own = new Set((await store.accounts.list()).map((a) => a.email.toLowerCase()));
    const people = new Map<string, CountedMail[]>();
    const domains = new Map<string, { mails: Set<CountedMail>; addresses: Set<string> }>();
    for (const m of mails) {
      if (m.mail.bulk || m.mail.to.length > PERSON_MAX_RECIPIENTS) continue;
      for (const address of m.mail.to) {
        if (own.has(address)) continue;
        const list = people.get(address);
        if (list) list.push(m);
        else people.set(address, [m]);
        const domain = address.slice(address.lastIndexOf("@") + 1);
        if (!domain || CONSUMER_DOMAINS.has(domain)) continue;
        let d = domains.get(domain);
        if (!d) domains.set(domain, (d = { mails: new Set(), addresses: new Set() }));
        d.mails.add(m);
        d.addresses.add(address);
      }
    }
    await this.clock.tick();

    const upserts: ProfileUpsert[] = [];
    if (!(await this.countScope("account", scopeKeys.account(account.id), account.id, mails, upserts, live))) return null;
    const topPeople = [...people].filter(([, list]) => list.length >= MIN_SAMPLES.person).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, PERSONS_MAX);
    for (const [address, list] of topPeople) if (!(await this.countScope("person", scopeKeys.person(account.id, address), account.id, list, upserts, live))) return null;
    const topDomains = [...domains].filter(([, d]) => d.addresses.size >= DOMAIN_MIN_ADDRESSES).sort((a, b) => b[1].mails.size - a[1].mails.size || (a[0] < b[0] ? -1 : 1)).slice(0, DOMAINS_MAX);
    for (const [domain, d] of topDomains) if (!(await this.countScope("domain", scopeKeys.domain(account.id, domain), account.id, [...d.mails], upserts, live))) return null;
    if (!live()) return null;

    const dirty = { ...cp.dirty };
    delete dirty[String(account.id)];
    const next: LearnerCheckpoint = { ...cp, dirty, forced: cp.forced.filter((id) => id !== account.id), youStale: true, updatedAt: this.host.now() };
    const ids = headers.map((h) => h.id);
    await store.writing.profiles.commit({ upserts, replaceAccount: account.id, state: { [LEARNER_KEY]: next, [windowKey(account.id)]: ids }, now: this.host.now() });
    this.windows.set(account.id, new Set(ids));
    this.host.log("info", "voice learner: account pass", { messages: mails.length, rows: upserts.length });
    return next;
  }

  /** "You", from what the accounts hold: no message read. */
  private async mergeYou(cp: LearnerCheckpoint, accounts: readonly number[], epoch: number): Promise<LearnerCheckpoint> {
    const { store } = this.host;
    const rows: WritingProfileRow[] = [];
    for (const id of accounts) rows.push(...(await store.writing.profiles.list({ scope: "account", accountId: id, limit: 16 })));
    const languages = new Map<string, { habits: Habits[]; phrases: string[][] }>();
    for (const row of rows) {
      let entry = languages.get(row.language);
      if (!entry) languages.set(row.language, (entry = { habits: [], phrases: [] }));
      try {
        const habits = JSON.parse(row.habitsJson) as Habits;
        const phrases = JSON.parse(row.phrasesJson) as string[];
        entry.habits.push(habits);
        entry.phrases.push(phrases);
      } catch {
        // an edited row that doesn't parse says nothing about the others
      }
    }
    const upserts: ProfileUpsert[] = [];
    for (const [language, { habits, phrases }] of languages) {
      const merged = mergeHabits(habits);
      if (merged.messages < (language === "" ? MIN_SAMPLES.you : LANGUAGE_MIN)) continue;
      upserts.push({ scope: "you", scopeKey: scopeKeys.you, language, accountId: null, habitsJson: JSON.stringify(merged), phrasesJson: JSON.stringify(mergePhrases(phrases)), samples: merged.messages });
    }
    const messages = rows.filter((r) => r.language === "").reduce((n, r) => n + r.samples, 0);
    const next: LearnerCheckpoint = { ...cp, merged: [...accounts], youStale: false, messages };
    if (epoch !== this.epoch) return next;
    // an account that went: its window with it (the id never comes back)
    const known = new Set((await store.accounts.list()).map((a) => a.id));
    const gone = cp.merged.filter((id) => !known.has(id));
    for (const id of gone) this.windows.delete(id);
    await store.writing.profiles.commit({ upserts, replaceYou: true, state: { [LEARNER_KEY]: next, ...Object.fromEntries(gone.map((id) => [windowKey(id), null])) }, now: this.host.now() });
    return next;
  }

  // ─── the optional model step ─────────────────────────────────────────────

  /** A scope's messages, newest first: its own sample's worth, from the account's window. */
  private async scopeMails(row: Pick<WritingProfileRow, "scope" | "scopeKey" | "accountId" | "language">, accounts: readonly Account[], live: () => boolean): Promise<WrittenMail[]> {
    const targets = row.accountId === null ? accounts : accounts.filter((a) => a.id === row.accountId);
    const out: WrittenMail[] = [];
    for (const account of targets) {
      const broad = row.scope === "you" || row.scope === "account";
      const headers = await this.walk(account.id, live, broad ? SAMPLE_HEADERS : CORPUS_WINDOW);
      const wanted = headers.filter((h) => {
        if (broad) return true;
        const key = row.scopeKey.slice(row.scopeKey.indexOf(":", row.scopeKey.indexOf(":") + 1) + 1);
        return row.scope === "person" ? h.to.includes(key) : h.to.some((a) => a.endsWith(`@${key}`));
      });
      const mails = await this.read(account, wanted.slice(0, SAMPLE_HEADERS), live);
      if (!mails) return [];
      out.push(...mails.map((m) => m.mail));
    }
    return row.language ? out.filter((m) => m.language === row.language) : out;
  }

  /** One scope's judgment; the same sample on the same prompt and model needs no request. */
  private async judge(row: WritingProfileRow, accounts: readonly Account[], ai: AiTasks, signal: AbortSignal, live: () => boolean): Promise<void> {
    const mails = await this.scopeMails(row, accounts, live);
    const sample = chooseSample(mails, SAMPLE_LIMITS[row.scope]);
    if (!sample.length || !live()) return;
    const hash = await sha256(JSON.stringify({ model: ai.model, provider: ai.providerId, version: JUDGE_PROMPT_VERSION, sample: sample.map((m) => [m.id, m.text]) }));
    if (hash === row.sampleHash && row.promptVersion === JUDGE_PROMPT_VERSION && row.model === ai.model && row.provider === ai.providerId) return;
    const result = await ai.judgeVoice({ scope: row.scope, language: row.language, sample: sample.map((m) => ({ text: m.text, to: m.to })) }, signal);
    if (signal.aborted || !live()) return;
    await this.host.store.writing.profiles.judge({ scopeKey: row.scopeKey, language: row.language, judgmentJson: JSON.stringify(result.judgment), sampleHash: hash, model: ai.model, provider: ai.providerId, promptVersion: JUDGE_PROMPT_VERSION, now: this.host.now() });
  }

  /** §3: a judgment already asked for comes up to date, only while the consent still holds, and rarely. */
  private async refreshJudgments(start: LearnerCheckpoint, accounts: readonly Account[], prefs: WritingPrefs, live: () => boolean): Promise<void> {
    const { store } = this.host;
    const consent = await store.settings.get<StudyConsent | null>(STUDY_KEY, null);
    if (!consent) return;
    let ai: AiTasks;
    try {
      ai = await this.host.forVoice();
    } catch {
      return;
    }
    // a study on this machine says nothing about a cloud service, nor one server about another
    if (consent.destination !== destinationOf(ai)) return;
    let cp = start;
    const today = dayOf(this.host.now());
    if (cp.refreshDay !== today) cp = { ...cp, refreshDay: today, refreshes: 0 };
    const allowed = accounts.filter((a) => consent.accountIds.includes(a.id) && usesSentMail(prefs, a.id));
    const { signal: asked, release } = this.host.begin(`voice-refresh:${this.host.now()}`, "voice-learner");
    const signal = AbortSignal.any([asked, this.permission.signal]);
    try {
      let after: { scopeKey: string; language: string } | undefined;
      for (;;) {
        const page: WritingProfileRow[] = await store.writing.profiles.list({ ...(after ? { after } : {}), limit: 200 });
        if (!page.length) break;
        for (const row of page) {
          after = { scopeKey: row.scopeKey, language: row.language };
          if (!row.judgmentJson || row.edited) continue;
          if (row.accountId !== null && !allowed.some((a) => a.id === row.accountId)) continue;
          if (row.promptVersion === JUDGE_PROMPT_VERSION && row.newSince < REFRESH_AFTER[row.scope]) continue;
          if (cp.refreshes >= REFRESHES_A_DAY || !live()) return;
          cp = { ...cp, refreshes: cp.refreshes + 1 };
          await this.judge(row, allowed, ai, signal, live);
        }
        await this.host.platform.yield();
      }
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      this.host.log("info", "voice refresh stopped", { aiKind: error.kind });
    } finally {
      release();
      await this.save(cp);
    }
  }

  private async studyTargets(accounts: readonly Account[]): Promise<WritingProfileRow[]> {
    const { store } = this.host;
    const out: WritingProfileRow[] = [...(await store.writing.profiles.read([{ scopeKey: scopeKeys.you, language: "" }]))];
    for (const account of accounts) {
      const rows = (await store.writing.profiles.list({ accountId: account.id, limit: 500 })).filter((r) => r.language === "" && !r.edited);
      const top = (scope: VoiceScope, n: number) => rows.filter((r) => r.scope === scope).sort((a, b) => b.samples - a.samples || (a.scopeKey < b.scopeKey ? -1 : 1)).slice(0, n);
      out.push(...top("account", 1), ...top("domain", STUDY_DOMAINS), ...top("person", STUDY_PEOPLE));
    }
    return out;
  }

  /** "Let AI study my style": sends samples of sent mail to the provider, so it says what first and waits for `confirm`. */
  async study(p: { requestId: string; clientId: string; confirm?: { provider: string; accountIds: readonly number[]; destination?: string } }): Promise<WritingStudyResult> {
    // before anything is read: a withdrawal from here on stops it, and leaves no consent behind
    const epoch = this.epoch;
    await this.activate();
    const { store } = this.host;
    await this.idle();
    const prefs = await this.host.prefs();
    const accounts = (await store.accounts.list()).filter((a) => usesSentMail(prefs, a.id));
    const targets = await this.studyTargets(accounts);
    if (!targets.length) return { status: "nothing" };
    const ai = await this.host.forVoice();
    const accountIds = accounts.map((a) => a.id);
    const destination = destinationOf(ai);
    if (!ai.local) {
      const agreed = p.confirm && p.confirm.provider === ai.providerId && p.confirm.destination === destination && accountIds.every((id) => p.confirm!.accountIds.includes(id));
      if (!agreed) {
        let messages = 0;
        let tokens = 0;
        for (const t of targets) {
          const limits = SAMPLE_LIMITS[t.scope];
          const used = Math.min(limits.maxMessages, t.samples);
          messages += used;
          const habits = JSON.parse(t.habitsJson) as Habits;
          tokens += Math.min(limits.maxTokens, Math.ceil(used * Math.max(1, habits.words.median) * 1.4));
        }
        const usd = costOf(ai.model, { inputTokens: tokens, outputTokens: 300 * targets.length });
        return { status: "consent", provider: ai.providerId as AiProviderId, destination, messages, tokens, usd, accountIds };
      }
    }
    if (epoch !== this.epoch) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    await store.settings.set(STUDY_KEY, { provider: ai.providerId, destination, accountIds, at: this.host.now() } satisfies StudyConsent);
    if (this.studying) return { status: "started", total: this.studying.total };
    const total = targets.length;
    this.studying = { requestId: p.requestId, total };
    const progress = (state: AiStudyProgress["state"], done: number, errorKind?: string) => this.host.studyProgress(p.clientId, { requestId: p.requestId, state, done, total, ...(errorKind ? { errorKind } : {}) });
    const { signal: asked, release } = this.host.begin(p.requestId, p.clientId);
    const signal = AbortSignal.any([asked, this.permission.signal]);
    const live = () => !this.stopped && epoch === this.epoch && !signal.aborted;
    this.studyRun = (async () => {
      let done = 0;
      try {
        for (const row of targets) {
          if (!live()) break;
          await this.judge(row, accounts, ai, signal, live);
          progress("running", ++done);
        }
        progress(signal.aborted || !live() ? "cancelled" : "done", done);
      } catch (error) {
        if (!(error instanceof AiError)) captureError(scrubbed(error), { code: "ai.failed" });
        const kind = error instanceof AiError ? error.kind : "unavailable";
        this.host.log("info", "style study stopped", { aiKind: kind });
        progress(kind === "cancelled" || signal.aborted ? "cancelled" : "failed", done, kind);
      } finally {
        release();
        this.studying = null;
      }
    })();
    return { status: "started", total };
  }
}

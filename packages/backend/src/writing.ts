import { AiError, COMPOSE_MAX_TOKENS, WRITING_RULES, type AiTasks, type ComposeInput, type ComposeTask } from "@terno/ai";
import {
  ALL_PARTS,
  canonicalAuthored,
  checkSpecifics,
  chooseExamples,
  CONSUMER_DOMAINS,
  DEFAULT_WRITING_PREFS,
  chooseLanguage,
  detectWritingLanguage,
  leadOfMail,
  DraftTooLargeError,
  estimateTokens,
  findPlaceholders,
  fitDraftBudget,
  headAndTail,
  languageName,
  namedLanguage,
  OUTPUT_TOKENS_LARGE,
  readCorpus,
  renderVoices,
  repeatedCorrections,
  resolveIntent,
  scopeKeys,
  UNKNOWN_LOCAL_CAPACITY,
  voiceForLanguage,
  type Account,
  type AiComposeResult,
  type AiIntentResult,
  type Address,
  type Habits,
  type IntentDecision,
  type IntentInput,
  type IntentPerson,
  type IntentSurface,
  type IntentSurfaceParam,
  type RenderedVoice,
  type VoiceJudgment,
  type VoiceProfile,
  type VoiceScope,
  type WritingPrefs,
  type WritingProfileView,
  type WritingUsed,
  type WrittenMail,
} from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError, type ParsedParamsOf } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { GENERATIONS_MAX_ROWS, SearchCancelledError, summaryBlocked, type MailStore, type SummarySourceMessage, type ThreadContextMessage, type WritingProfileRow } from "@terno/store";
import type { BackendCore as Backend } from "./core";
import { toRpcError } from "./ai-service";
import { withoutQuotes } from "./summaries";
import { scrubbed, usesSentMail, VoiceLearner } from "./voice-learner";

/**
 * Plan 133 §6: what goes into a draft. Everything here is read on request, from indexes and one thread, and held only
 * for the draft's session. Nothing here, and nothing this file logs, carries mail: only kinds and counts.
 */

export const PREFS_KEY = "writing:prefs";

/** What a window into one thread reads: the answered message's start, the rest's. */
const THREAD_BUDGET = { maxBodies: 21, maxChars: 256 * 1024 };
/** Past this the message goes in as its start and end: thinking of the whole of a huge one costs more than it helps. */
const INBOUND_MAX_TOKENS = 12_000;
const EXAMPLE_CANDIDATES = 24;
const EXAMPLES = 4;
/** A message longer than this isn't a usable example of someone's voice, and would shut out the others. */
const EXAMPLE_MAX_CHARS = 4800;
const PAST_CONVERSATIONS = 5;
/** Mail naming someone with no history: enough to know who they are and what they said, not a search of the mailbox. */
const MENTIONS = 2;
const MENTION_CHARS = 3000;
const MENTION_CANDIDATES = 6;
/** Longer than this and the draft goes without. */
const MENTION_WAIT_MS = 400;

interface Mention {
  threadId: number;
  stamp: string;
  date: string;
  subject: string;
  text: string;
}

/** This address and no longer one that ends with it: a search's phrase would also find x.tom@acme.test for tom@acme.test. */
const namesAddress = (address: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}._%+-])${address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_%+-]|\\.[\\p{L}\\p{N}])`, "iu");
/** Cloud models with no reported window: all of them hold this and more. */
const CLOUD_ASSUMED_CAPACITY = 200_000;
/** §6.1: a session's snapshot, in memory: released with the session, or the oldest past this. */
const SNAPSHOTS_MAX = 8;
const SNAPSHOT_MAX_CHARS = 512 * 1024;
const RECENT_THREAD_MS = 30 * 86_400_000;
const STREAM_EVERY_MS = 30;

type ComposeParams = ParsedParamsOf<"ai.compose">;
type IntentParams = ParsedParamsOf<"ai.resolveIntent">;
type EditParams = ParsedParamsOf<"writing.profiles.edit">;
type PrefsPatch = ParsedParamsOf<"writing.prefs.set">;

interface Snapshot {
  key: string;
  input: Omit<ComposeInput, "task">;
  used: Omit<WritingUsed, "reused">;
  /** what a specific in the draft may come from */
  authorized: string[];
  maxTokens: number;
  /** the mail naming the person: reused only while it's all still as it was */
  mentionSources: readonly { threadId: number; stamp: string }[];
}

export async function readPrefs(store: Backend["store"]): Promise<WritingPrefs> {
  const saved = await store.settings.get<Partial<WritingPrefs> | null>(PREFS_KEY, null);
  return { global: { ...DEFAULT_WRITING_PREFS.global, ...saved?.global }, accounts: saved?.accounts ?? {} };
}

const dayIn = (ms: number, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
};

const addressesOf = (list: readonly Address[]) => list.map((a) => a.email.toLowerCase());
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const nameOf = (m: Pick<SummarySourceMessage, "fromName" | "fromEmail">) => (m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail);

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toProfile(row: WritingProfileRow, fromOtherAccount = false): VoiceProfile | null {
  try {
    return { scope: row.scope, key: row.scopeKey, language: row.language, samples: row.samples, habits: JSON.parse(row.habitsJson) as Habits, phrases: JSON.parse(row.phrasesJson) as string[], judgment: row.judgmentJson ? (JSON.parse(row.judgmentJson) as VoiceJudgment) : null, ...(fromOtherAccount ? { fromOtherAccount } : {}) };
  } catch {
    return null;
  }
}

function toView(row: WritingProfileRow): WritingProfileView | null {
  const profile = toProfile(row);
  if (!profile) return null;
  return { scope: row.scope, scopeKey: row.scopeKey, language: row.language, accountId: row.accountId, samples: row.samples, newSince: row.newSince, edited: row.edited, updatedAt: row.updatedAt, habits: profile.habits, phrases: profile.phrases, judgment: profile.judgment, model: row.model, provider: row.provider };
}

const accountOfKey = (scopeKey: string): number | null => {
  const m = /^(?:account|domain|person):(\d+)/.exec(scopeKey);
  return m ? Number(m[1]) : null;
};

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new AiError(L("errors.ai.cancelled"), "cancelled"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
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

/** A failure that isn't the provider's verdict could hold anything from the prompt: it's reported by its name alone. */
function clean(error: unknown): unknown {
  if (error instanceof RpcError || error instanceof AiError) return error;
  if (error instanceof DraftTooLargeError) return new AiError(L("errors.ai.draftTooLarge"), "unsupported");
  captureError(scrubbed(error), { code: "ai.failed" });
  return new AiError(L("errors.ai.draftFailed"), "unavailable");
}

export class WritingService {
  readonly learner: VoiceLearner;
  private readonly snapshots = new Map<string, Snapshot>();
  /** each draft and each "who is this for" while it runs: `accountId` null is any account's */
  private readonly asking = new Set<{ accountId: number | null; controller: AbortController }>();
  /** ups when what snapshots are made of goes away: an assembly that started before it starts over */
  private learned = 0;

  constructor(private readonly b: Backend) {
    this.learner = new VoiceLearner({
      store: b.store,
      platform: b.platform,
      now: () => b.now(),
      prefs: () => readPrefs(b.store),
      forVoice: () => b.aiService.forTask("voice", { foreground: false }),
      begin: (requestId, clientId) => b.aiService.begin(requestId, clientId),
      studyProgress: (clientId, progress) => b.server.emitTo(clientId, "aiStudy", progress),
      log: (level, message, extra) => b.log(level, message, extra),
    });
  }

  /** A window closed: nothing it held has anywhere to go. */
  disconnected(clientId: string): void {
    for (const key of this.snapshots.keys()) if (key.startsWith(`${clientId}\n`)) this.snapshots.delete(key);
  }

  endSession(session: string, clientId: string): void {
    this.snapshots.delete(`${clientId}\n${session}`);
  }

  private keep(session: string, snapshot: Snapshot): void {
    if (JSON.stringify(snapshot.input).length > SNAPSHOT_MAX_CHARS) return void this.snapshots.delete(session);
    this.snapshots.delete(session);
    this.snapshots.set(session, snapshot);
    while (this.snapshots.size > SNAPSHOTS_MAX) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  /** A request that stops, at the provider too, the moment the user takes back the permission it runs under. */
  private underPermission(accountId: number | null, signal: AbortSignal): { signal: AbortSignal; done: () => void } {
    const entry = { accountId, controller: new AbortController() };
    this.asking.add(entry);
    return { signal: AbortSignal.any([signal, entry.controller.signal]), done: () => void this.asking.delete(entry) };
  }

  private forgetSnapshots(): void {
    this.learned++;
    this.snapshots.clear();
  }

  /** Clear all, from any window: no draft goes on with a copy of what was just cleared. */
  async clearProfiles(): Promise<void> {
    this.forgetSnapshots();
    await this.learner.clear();
    // what assembled while that ran read what it was clearing
    this.forgetSnapshots();
  }

  // ─── settings ────────────────────────────────────────────────────────────

  getPrefs(): Promise<WritingPrefs> {
    return readPrefs(this.b.store);
  }

  async setPrefs(patch: PrefsPatch): Promise<WritingPrefs> {
    const before = await readPrefs(this.b.store);
    const after = await this.b.store.settings.update<Partial<WritingPrefs> | null, WritingPrefs>(PREFS_KEY, null, (saved) => {
      const global = { ...DEFAULT_WRITING_PREFS.global, ...saved?.global, ...patch.global };
      const accounts = { ...saved?.accounts };
      if (patch.account) {
        if (patch.account.prefs === null) delete accounts[String(patch.account.accountId)];
        else accounts[String(patch.account.accountId)] = { ...accounts[String(patch.account.accountId)], ...patch.account.prefs };
      }
      const value = { global, accounts };
      return { value, result: value };
    });
    // before anything else: nothing already asked for goes on under a permission that's gone
    const accountsLost = (accountId: number) => usesSentMail(before, accountId) && !usesSentMail(after, accountId);
    let lost = false;
    for (const { accountId, controller } of this.asking) {
      if (!after.global.enabled || (accountId !== null && accountsLost(accountId))) {
        controller.abort();
        lost = true;
      }
    }
    if (lost || (before.global.useSentMail && !after.global.useSentMail) || (before.global.enabled && !after.global.enabled)) this.forgetSnapshots();
    await this.learner.prefsChanged(before, after);
    return after;
  }

  // ─── profiles ────────────────────────────────────────────────────────────

  async listProfiles(p: ParsedParamsOf<"writing.profiles.list">) {
    void this.learner.activate();
    const rows = await this.b.store.writing.profiles.list({ limit: p.limit, ...(p.scope ? { scope: p.scope } : {}), ...(p.accountId !== undefined ? { accountId: p.accountId } : {}), ...(p.after ? { after: p.after } : {}) });
    const last = rows[rows.length - 1];
    return {
      items: rows.flatMap((r) => toView(r) ?? []),
      next: rows.length === p.limit && last ? { scopeKey: last.scopeKey, language: last.language } : null,
      status: await this.learner.status(),
    };
  }

  async editProfile(p: EditParams): Promise<WritingProfileView> {
    const { store } = this.b;
    const [row] = await store.writing.profiles.read([{ scopeKey: p.scopeKey, language: p.language }]);
    const view = row && toView(row);
    if (!view) throw new RpcError("NOT_FOUND", L("errors.writing.profileGone"));
    const habits: Habits = { ...view.habits, ...(p.greetings ? { greetings: p.greetings } : {}), ...(p.signOffs ? { signOffs: p.signOffs } : {}) };
    const ok = await store.writing.profiles.edit({
      scopeKey: p.scopeKey,
      language: p.language,
      ...(p.greetings || p.signOffs ? { habitsJson: JSON.stringify(habits) } : {}),
      ...(p.phrases ? { phrasesJson: JSON.stringify(p.phrases) } : {}),
      ...(p.judgment !== undefined ? { judgmentJson: p.judgment ? JSON.stringify(p.judgment) : null } : {}),
      now: this.b.now(),
    });
    if (!ok) throw new RpcError("BAD_REQUEST", L("errors.writing.profileTooLarge"));
    const [edited] = await store.writing.profiles.read([{ scopeKey: p.scopeKey, language: p.language }]);
    return toView(edited!)!;
  }

  async resetProfile(scopeKey: string, language: string | undefined): Promise<void> {
    this.forgetSnapshots();
    await this.b.store.writing.profiles.reset(scopeKey, language);
    this.forgetSnapshots();
    await this.learner.rebuild(accountOfKey(scopeKey) ?? undefined);
  }

  // ─── provenance ──────────────────────────────────────────────────────────

  commitGeneration(p: ParsedParamsOf<"writing.commitGeneration">): Promise<boolean> {
    return this.b.store.writing.generations.commit({ accountId: p.accountId, draftId: p.draftId, draftGeneration: p.draftGeneration, address: p.address, generated: canonicalAuthored(p.text), now: this.b.now() });
  }

  // ─── §6: a draft ─────────────────────────────────────────────────────────

  private capacity(ai: AiTasks): { capacityTokens: number; outputTokens: number } {
    const capacityTokens = ai.contextTokens ?? (ai.local ? UNKNOWN_LOCAL_CAPACITY : CLOUD_ASSUMED_CAPACITY);
    return { capacityTokens, outputTokens: Math.min(OUTPUT_TOKENS_LARGE, COMPOSE_MAX_TOKENS, Math.floor(capacityTokens / 4)) };
  }

  /** §1: the levels that exist, general to specific, in the language it's writing in where one's kept. */
  private async voiceChain(account: Account, address: string | null, language: string): Promise<VoiceProfile[]> {
    const { store } = this.b;
    const scopes: string[] = [scopeKeys.you, scopeKeys.account(account.id)];
    if (address) {
      const domain = domainOf(address);
      if (domain && !CONSUMER_DOMAINS.has(domain)) scopes.push(scopeKeys.domain(account.id, domain));
      scopes.push(scopeKeys.person(account.id, address));
    }
    const pick = async (scopeKey: string): Promise<WritingProfileRow | null> => {
      const rows = await store.writing.profiles.read(language ? [{ scopeKey, language }, { scopeKey, language: "" }] : [{ scopeKey, language: "" }]);
      return rows[0] ?? null;
    };
    const chain: VoiceProfile[] = [];
    for (const scopeKey of scopes) {
      const row = await pick(scopeKey);
      const profile = row && toProfile(row);
      if (profile) chain.push(profile);
    }
    // §1: this account has never written to them, and another has: that profile is absolute, so it carries over
    if (address && !chain.some((p) => p.scope === "person")) {
      for (const other of await store.accounts.list()) {
        if (other.id === account.id) continue;
        const row = await pick(scopeKeys.person(other.id, address));
        const profile = row && toProfile(row, true);
        if (profile) {
          chain.push(profile);
          break;
        }
      }
    }
    return chain;
  }

  /** §8: only what repeats, at the narrowest level it fits. */
  private async withCorrections(voice: RenderedVoice[], accountId: number, address: string | null, selfNames: readonly string[]): Promise<RenderedVoice[]> {
    const { store } = this.b;
    const all = await store.writing.generations.pairs({ accountId, limit: GENERATIONS_MAX_ROWS });
    if (!all.length) return voice;
    const person = address ? repeatedCorrections(all.filter((p) => p.address === address), selfNames) : [];
    const account = repeatedCorrections(all, selfNames).filter((line) => !person.includes(line));
    const add = (out: RenderedVoice[], scope: "person" | "account", lines: string[]) => {
      if (!lines.length) return out;
      const at = out.findIndex((v) => v.scope === scope);
      if (at >= 0) return out.map((v, i) => (i === at ? { ...v, text: `${v.text}\n${lines.join("\n")}` } : v));
      const next = [...out, { scope, text: lines.join("\n"), fromOtherAccount: false }];
      // general before specific, as the prompt's layers want them
      const order = { you: 0, account: 1, domain: 2, person: 3 };
      return next.sort((a, b) => order[a.scope] - order[b.scope]);
    };
    return add(add(voice, "account", account), "person", person);
  }

  private async assemble(p: ComposeParams, ai: AiTasks, account: Account, prefs: WritingPrefs, key: string): Promise<Snapshot | { waiting: number }> {
    const { store } = this.b;
    const useMail = usesSentMail(prefs, account.id);
    const address = addressesOf(p.to)[0] ?? addressesOf(p.cc)[0] ?? null;

    const context = p.threadId !== undefined ? await store.writing.threadContext(p.threadId, THREAD_BUDGET) : null;
    if (p.threadId !== undefined && !context) throw new RpcError("NOT_FOUND", L("errors.threadGone"));
    const answering: ThreadContextMessage | null = context ? (context.messages.find((m) => m.id === (p.answeringMessageId ?? context.newestInbound)) ?? null) : null;
    if (answering && answering.bodyState === "none" && !answering.bodyUnavailable) return { waiting: answering.id };
    const inboundText = answering ? withoutQuotes(answering.text ?? "") : "";
    const snippetOnly = answering !== null && !inboundText;
    const inbound = answering ? headAndTail(inboundText || answering.snippet, INBOUND_MAX_TOKENS) : null;
    const templated = await this.learner.templatedIn(account.id);

    let history: WritingUsed["history"] = "none";
    let examples: { date: string; subject: string; text: string }[] = [];
    let past: { date: string; subject: string; snippet: string }[] = [];
    let mails: WrittenMail[] = [];
    let sentRefs = new Map<number, Awaited<ReturnType<MailStore["writing"]["sentTo"]>>["refs"][number]>();
    if (address && useMail) {
      const sent = await store.writing.sentTo({ addresses: [address], accountId: account.id, limit: EXAMPLE_CANDIDATES });
      history = sent.state;
      if (history === "none" && (await store.writing.sentTo({ addresses: [address], limit: 1 })).state !== "none") history = "unavailable";
      if (sent.refs.length) {
        sentRefs = new Map(sent.refs.map((r) => [r.id, r]));
        const texts = await store.writing.corpus.texts(sent.refs.filter((r) => !templated.has(r.id)).map((r) => r.id));
        mails = readCorpus(
          texts.flatMap((t) => {
            const r = sentRefs.get(t.id);
            return r ? [{ id: r.id, to: r.to, cc: r.cc, at: r.date, isReply: r.isReply, body: t.text }] : [];
          }),
          { signature: account.signature, selfNames: [account.senderName, account.displayName].filter(Boolean) },
        );
      }
    }

    // §6.3: per account and person, from what they've done: someone may write one language here and another there
    const neutral = useMail ? await this.voiceChain(account, address, "") : [];
    const level = (scope: VoiceScope, other = false) => neutral.find((v) => v.scope === scope && !!v.fromOtherAccount === other)?.habits ?? null;
    const { language, reason: languageReason } = chooseLanguage({
      instruction: p.instruction,
      // what they wrote, not their signature or a quote: "Thanks!" over a Spanish signature says nothing about Spanish
      threadOwn: readCorpus(
        (context?.messages ?? []).filter((m) => m.own && m.text).sort((a, b) => b.date - a.date).map((m) => ({ id: m.id, to: [], cc: [], at: m.date, isReply: true, body: m.text ?? "" })),
        { signature: account.signature, selfNames: [account.senderName, account.displayName].filter(Boolean) },
      ).sort((a, b) => b.at - a.at).map((m) => m.language),
      inbound: inboundText ? detectWritingLanguage(leadOfMail(inboundText)) : "",
      toPerson: [...mails].sort((a, b) => b.at - a.at).map((m) => m.language),
      otherAccount: level("person", true),
      domain: level("domain"),
      account: level("account"),
      you: level("you"),
    });
    const chain = (useMail && language ? await this.voiceChain(account, address, language) : neutral).map((v) => voiceForLanguage(v, language));
    const voice = useMail ? await this.withCorrections(renderVoices(chain, ALL_PARTS), account.id, address, [account.senderName, account.displayName].filter(Boolean)) : [];

    if (address && useMail) {
      if (mails.length) {
        const oneToOne = p.to.length + p.cc.length === 1;
        const chosen = chooseExamples(mails, { isReply: p.kind === "reply", oneToOne, language }, EXAMPLE_CANDIDATES).filter((m) => m.text.length <= EXAMPLE_MAX_CHARS);
        // §6.2: their earlier messages in this same conversation count first
        const inThread = (id: string | number) => sentRefs.get(Number(id))?.threadId === p.threadId;
        examples = [...chosen.filter((m) => inThread(m.id)), ...chosen.filter((m) => !inThread(m.id))].slice(0, EXAMPLES).map((m) => ({ date: dayIn(m.at, p.timezone), subject: sentRefs.get(Number(m.id))?.subject ?? "", text: m.text }));
      }
      const threads = await store.writing.threadsWith({ address, accountId: account.id, ...(p.threadId !== undefined ? { exclude: p.threadId } : {}), limit: PAST_CONVERSATIONS });
      const summaries = new Map((await store.threads.summaries(threads)).map((t) => [t.id, t]));
      past = threads.flatMap((id) => {
        const t = summaries.get(id);
        return t ? [{ date: dayIn(t.lastDate, p.timezone), subject: t.subject, snippet: t.snippet }] : [];
      });
    }

    // never written to, never heard from: the reason for writing may still be in the mailbox
    const mentions = address && useMail && p.kind === "new" && p.threadId === undefined && history === "none" && past.length === 0 ? await this.mailNaming(address, account.id, p.timezone) : [];

    const instructions = [...(prefs.accounts[String(account.id)]?.useGeneral === false ? [] : [prefs.global.instructions]), prefs.accounts[String(account.id)]?.instructions ?? ""].filter(Boolean);
    const others = (context?.messages ?? []).filter((m) => m !== answering);
    const before = answering ? others.filter((m) => m.date < answering.date || (m.date === answering.date && m.id < answering.id)).length : others.length;
    const threadEntries = others.map((m) => ({ from: nameOf(m), date: dayIn(m.date, p.timezone), own: m.own, text: m.text ? withoutQuotes(m.text) : m.snippet, snippet: m.snippet }));

    const { capacityTokens, outputTokens } = this.capacity(ai);
    const voiceText = (v: RenderedVoice) => v.text;
    const general = voice.filter((v) => v.scope === "you" || v.scope === "account");
    const specific = voice.filter((v) => v.scope === "domain" || v.scope === "person");
    const fixedText = [WRITING_RULES, account.senderName, account.signature, ...instructions, p.instruction, p.draft ?? "", p.previousDraft ?? "", ...addressesOf(p.to), ...addressesOf(p.cc)].join("\n");
    const fitted = fitDraftBudget(
      {
        fixedTokens: estimateTokens(fixedText),
        inbound,
        voiceGeneral: general.map(voiceText),
        voiceSpecific: specific.map(voiceText),
        thread: threadEntries,
        messagesToPerson: examples.map((e) => e.text),
        pastConversations: past.map((c) => `${c.subject} ${c.snippet}`),
        mentions: mentions.map((m) => m.text),
      },
      { capacityTokens, outputTokens },
    );
    const thread: ComposeInput["thread"] = fitted.thread.map((t) => ({ from: t.from, date: t.date, own: t.own, text: t.text }));
    if (answering && fitted.inbound !== null) (thread as ComposeInput["thread"][number][]).splice(before, 0, { from: nameOf(answering), date: dayIn(answering.date, p.timezone), own: answering.own, text: fitted.inbound });

    const input: Omit<ComposeInput, "task"> = {
      sender: { name: account.senderName || account.displayName, address: account.email },
      signature: account.signature || null,
      instructions,
      voice: [...general.slice(0, fitted.voiceGeneral.length), ...specific.slice(0, fitted.voiceSpecific.length)],
      messagesToPerson: examples.slice(0, fitted.messagesToPerson.length),
      pastConversations: past.slice(0, fitted.pastConversations.length),
      mentions: mentions.slice(0, fitted.mentions.length),
      thread,
      subject: context?.subject ?? (p.subject || null),
    };
    // a level that adds nothing to its parent renders as nothing and was still used; only one the budget cut wasn't
    const cut = new Set(voice.filter((v) => !input.voice.includes(v)).map((v) => v.scope));
    const usedChain = chain.filter((v) => !cut.has(v.scope));
    const used: Snapshot["used"] = {
      levels: usedChain.map((v) => v.scope),
      personFromOtherAccount: usedChain.some((v) => v.fromOtherAccount),
      examples: input.messagesToPerson.length,
      pastConversations: input.pastConversations.length,
      mentions: input.mentions?.length ?? 0,
      threadMessages: thread.length,
      history,
      learning: useMail && chain.length === 0 && (await this.learner.status()).state === "learning",
      inboundSnippetOnly: snippetOnly,
      language,
      languageReason,
      provider: ai.providerId,
      model: ai.model,
    };
    const authorized = [...thread.map((t) => t.text), ...input.messagesToPerson.map((m) => m.text), ...(input.mentions ?? []).map((m) => m.text), ...instructions, account.signature, account.email, account.senderName, context?.subject ?? ""];
    return { key, input, used, authorized, maxTokens: outputTokens, mentionSources: mentions.slice(0, fitted.mentions.length).map(({ threadId, stamp }) => ({ threadId, stamp })) };
  }

  /**
   * Mail in this account that names this exact address, never from Spam or Trash. Optional, so it never holds a draft up:
   * a search that can't answer quickly (its index still catching up), or fails, costs the draft nothing.
   */
  private async mailNaming(address: string, accountId: number, zone: string): Promise<Mention[]> {
    const { store } = this.b;
    const out: Mention[] = [];
    const named = namesAddress(address);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), MENTION_WAIT_MS);
    try {
      const lookup = (async () => {
        const found = await store.threads.searchText({ query: `"${address}"`, accountId, limit: MENTION_CANDIDATES, now: this.b.now(), signal: stop.signal });
        for (const { id } of found.items) {
          if (out.length >= MENTIONS || stop.signal.aborted) break;
          const sources = await store.aiSummaries.sources(id);
          if (!sources || summaryBlocked(sources)) continue;
          const context = await store.writing.threadContext(id, { maxBodies: MENTIONS, maxChars: MENTION_CHARS * MENTIONS });
          const message = context?.messages.find((m) => !m.own && m.text && named.test(m.text));
          if (context && message?.text) out.push({ threadId: id, stamp: sources.stamp, date: dayIn(message.date, zone), subject: context.subject, text: withoutQuotes(message.text).slice(0, MENTION_CHARS) });
        }
      })();
      await Promise.race([lookup, new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      // whatever it was still doing, it's no longer waited for, and a late failure is nobody's
      lookup.catch(() => {});
    } catch (error) {
      if (!(error instanceof SearchCancelledError)) captureError(scrubbed(error), { code: "ai.failed" });
    } finally {
      clearTimeout(timer);
    }
    return stop.signal.aborted ? [] : out;
  }

  private async mentionsHold(snapshot: Snapshot): Promise<boolean> {
    for (const { threadId, stamp } of snapshot.mentionSources) {
      const sources = await this.b.store.aiSummaries.sources(threadId);
      if (!sources || summaryBlocked(sources) || sources.stamp !== stamp) return false;
    }
    return true;
  }

  /** One session's sources and settings: anything else re-assembles. Reads headers, no bodies. */
  private async snapshotKey(p: ComposeParams, ai: AiTasks, account: Account, prefs: WritingPrefs): Promise<{ key: string; waiting: number | null }> {
    const sources = p.threadId !== undefined ? await this.b.store.aiSummaries.sources(p.threadId) : null;
    if (p.threadId !== undefined && !sources) throw new RpcError("NOT_FOUND", L("errors.threadGone"));
    let waiting: number | null = null;
    if (sources) {
      const live = sources.messages.filter((m) => !(m.trash && !sources.inTrash) && !(m.spam && !sources.inSpam));
      const answering = p.answeringMessageId !== undefined ? live.find((m) => m.id === p.answeringMessageId) : [...live].reverse().find((m) => !m.own);
      if (answering && answering.bodyState === "none" && !answering.bodyUnavailable) waiting = answering.id;
    }
    const key = await sha256(
      JSON.stringify({
        stamp: sources?.stamp ?? null,
        kind: p.kind,
        answering: p.answeringMessageId ?? null,
        to: addressesOf(p.to),
        cc: addressesOf(p.cc),
        subject: p.subject,
        account: { id: account.id, sender: account.senderName, signature: account.signature },
        prefs: { global: prefs.global, account: prefs.accounts[String(account.id)] ?? null },
        target: { provider: ai.providerId, model: ai.model, endpoint: ai.endpoint, capacity: ai.contextTokens },
        zone: p.timezone,
      }),
    );
    return { key, waiting };
  }

  async compose(p: ComposeParams, clientId: string): Promise<AiComposeResult> {
    const { store } = this.b;
    const { signal: asked, release } = this.b.aiService.begin(p.requestId, clientId);
    const { signal, done: permissionDone } = this.underPermission(p.accountId, asked);
    const stream = coalescer((text) => this.b.server.emitTo(clientId, "aiCompose", { requestId: p.requestId, text }));
    void this.learner.activate().catch(() => {});
    try {
      const prefs = await readPrefs(store);
      if (!prefs.global.enabled) throw new AiError(L("errors.ai.draftingOff"), "not_configured");
      const account = await store.accounts.get(p.accountId);
      if (!account) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
      // foreground: it waits for nothing but a local model's slot (plan 131 revision 3)
      const ai = await this.b.aiService.forTask("writing", { foreground: true });
      const { key, waiting } = await this.snapshotKey(p, ai, account, prefs);
      if (waiting !== null) return { status: "waitingBody", messageId: waiting };
      const session = `${clientId}\n${p.session}`;
      const held = this.snapshots.get(session);
      let snapshot: Snapshot;
      let reused = false;
      // "in French" on a refinement is a new draft in French: its voice, examples and everything after it follow
      const asked = namedLanguage(p.instruction);
      if (held?.key === key && (!asked || asked === held.used.language) && (await this.mentionsHold(held))) {
        snapshot = held;
        reused = true;
      } else {
        const current = async () => {
          for (;;) {
            const learned = this.learned;
            const out = await this.assemble(p, ai, account, prefs, key);
            // what it read may have been cleared meanwhile: then it starts over, on what's there now
            if (learned === this.learned || signal.aborted) return out;
          }
        };
        const assembled = await current();
        if ("waiting" in assembled) return { status: "waitingBody", messageId: assembled.waiting };
        if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
        snapshot = assembled;
        this.keep(session, snapshot);
      }
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      const today = dayIn(this.b.now(), p.timezone);
      const named = languageName(snapshot.used.language);
      const task: ComposeTask = {
        kind: p.kind,
        today,
        ...(named ? { language: named } : {}),
        timezone: p.timezone,
        recipients: [...p.to, ...p.cc].map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)),
        instruction: p.instruction,
        needsSubject: p.needsSubject,
        ...(p.draft !== undefined ? { draft: p.draft } : {}),
        ...(p.previousDraft !== undefined ? { previousDraft: p.previousDraft } : {}),
        ...(p.attachments?.length ? { attachments: p.attachments } : {}),
      };
      const result = await ai.compose({ ...snapshot.input, task }, { onDelta: (text) => stream.push(text), signal, effort: "low", maxTokens: snapshot.maxTokens });
      stream.flush();
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      const authorized = [...snapshot.authorized, p.instruction, p.draft ?? "", p.previousDraft ?? "", p.subject, ...[...p.to, ...p.cc].flatMap((a) => [a.email, a.name])];
      const stop = result.stop === "length" ? "length" : "end";
      return {
        status: "done",
        text: result.text,
        subject: result.subject,
        stop,
        used: { ...snapshot.used, reused },
        checks: { specifics: checkSpecifics(result.text, { texts: authorized, today }), placeholders: findPlaceholders(result.text) },
      };
    } catch (error) {
      stream.flush();
      throw toRpcError(clean(error));
    } finally {
      permissionDone();
      release();
    }
  }

  // ─── §5: where it goes ───────────────────────────────────────────────────

  private async surfaceOf(surface: IntentSurfaceParam): Promise<IntentSurface> {
    if (surface.kind === "list") return { kind: "list" };
    if (surface.kind === "draft") return { kind: "draft", recipients: surface.recipients.map((r) => ({ name: r.name, address: r.email })) };
    const context = await this.b.store.writing.threadContext(surface.threadId, { maxBodies: 0, maxChars: 0 });
    if (!context) throw new RpcError("NOT_FOUND", L("errors.threadGone"));
    const people = new Map<string, IntentPerson>();
    const own = new Set(context.messages.filter((m) => m.own).map((m) => m.fromEmail));
    for (const account of await this.b.store.accounts.list()) own.add(account.email.toLowerCase());
    const add = (name: string, address: string) => {
      const key = address.toLowerCase();
      if (!key || own.has(key)) return;
      const held = people.get(key);
      if (!held || (!held.name && name)) people.set(key, { name, address: key });
    };
    for (const m of context.messages) {
      add(m.fromName, m.fromEmail);
      for (const r of [...m.to, ...m.cc]) add(r.name, r.email);
    }
    const last = [...context.messages].reverse().find((m) => !m.own);
    return { kind: "thread", participants: [...people.values()], lastSender: last?.fromEmail.toLowerCase() ?? null };
  }

  async resolveIntent(p: IntentParams, clientId: string): Promise<AiIntentResult> {
    const { store } = this.b;
    const { signal: asked, release } = this.b.aiService.begin(p.requestId, clientId);
    const { signal, done: permissionDone } = this.underPermission(null, asked);
    void this.learner.activate().catch(() => {});
    try {
      const surface = await this.surfaceOf(p.surface as IntentSurfaceParam);
      // warming is what makes names resolvable: the answer to a `wait` comes when it's done, with nothing polling
      const warm = this.b.warmAutocomplete();
      if (p.waitForContacts) await Promise.race([warm, aborted(signal)]);
      else void warm.catch(() => {});
      const recent = new Map<string, { threadId: number; subject: string } | null>();
      const base: IntentInput = {
        instruction: p.instruction,
        surface,
        lookup: (token) => {
          const r = this.b.autocomplete.resolveExact(token, p.accountId !== undefined ? { accountId: p.accountId } : {});
          return { state: r.state, hits: r.hits.map((h) => ({ name: h.name, address: h.email.toLowerCase() })) };
        },
        recentThread: (address) => recent.get(address.toLowerCase()) ?? null,
      };
      let decision = resolveIntent(base);
      let confirmFailed = false;
      let confirmed: IntentPerson | null = null;
      if (decision.kind === "confirm") {
        const candidates = decision.candidates;
        const named = candidates.map((c, i) => ({ id: `p${i}`, name: c.name || c.address }));
        let answer: string | null = null;
        try {
          const ai = await this.b.aiService.forTask("intent", { foreground: true });
          const { recipient } = await ai.parseIntent({ instruction: p.instruction, candidates: named }, signal);
          const at = recipient === null ? -1 : named.findIndex((c) => c.id === recipient);
          confirmed = candidates[at] ?? null;
          answer = confirmed?.address ?? null;
        } catch (error) {
          if (signal.aborted || (error instanceof AiError && error.kind === "cancelled")) throw new AiError(L("errors.ai.cancelled"), "cancelled");
          // a match alone never changes a route: it stays as it was, and the row says so
          this.b.log("info", "intent confirmation failed", { aiKind: error instanceof AiError ? error.kind : "unavailable" });
          confirmFailed = true;
        }
        decision = resolveIntent({ ...base, confirmed: answer });
      }
      const to = this.personIn(decision);
      if (to && surface.kind === "list") {
        const thread = await this.recentThread(to.address, p.accountId);
        if (thread) {
          recent.set(to.address, thread);
          decision = resolveIntent(confirmed ? { ...base, confirmed: confirmed.address } : base);
        }
      }
      const named = decision.kind === "route" || decision.kind === "ask" ? this.named(decision, confirmed) : decision;
      const person = this.personIn(named);
      const newMessage = (named.kind === "route" && named.route.type === "new") || (named.kind === "ask" && named.question.type === "new-or-reply");
      const fromAccountId = person && newMessage ? ((await store.writing.sentTo({ addresses: [person.address], limit: 1 })).refs[0]?.accountId ?? null) : null;
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      return { decision: named, fromAccountId, confirmFailed };
    } catch (error) {
      throw toRpcError(clean(error));
    } finally {
      permissionDone();
      release();
    }
  }

  private personIn(decision: IntentDecision): IntentPerson | null {
    if (decision.kind === "route") {
      const { route } = decision;
      return route.type === "new" || route.type === "fill-draft" ? route.to : null;
    }
    if (decision.kind === "ask" && decision.question.type !== "who") return decision.question.to;
    return null;
  }

  /** The pure decision knows an address; the name the user knows them by was on the candidate. */
  private named(decision: IntentDecision, person: IntentPerson | null): IntentDecision {
    if (!person) return decision;
    const fill = (to: IntentPerson) => (!to.name && to.address === person.address ? person : to);
    if (decision.kind === "route" && (decision.route.type === "new" || decision.route.type === "fill-draft")) return { kind: "route", route: { ...decision.route, to: fill(decision.route.to) } };
    if (decision.kind === "ask" && decision.question.type !== "who") return { kind: "ask", question: { ...decision.question, to: fill(decision.question.to) } };
    return decision;
  }

  private async recentThread(address: string, accountId: number | undefined): Promise<{ threadId: number; subject: string } | null> {
    const { store } = this.b;
    const [id] = await store.writing.threadsWith({ address, ...(accountId !== undefined ? { accountId } : {}), limit: 1 });
    if (id === undefined) return null;
    const [thread] = await store.threads.summaries([id]);
    return thread && this.b.now() - thread.lastDate <= RECENT_THREAD_MS ? { threadId: thread.id, subject: thread.subject } : null;
  }
}

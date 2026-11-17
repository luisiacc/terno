import { AiError, FOLLOWUP_ANSWERING_CHARS, FOLLOWUP_OPEN_MAX, FOLLOWUP_OWN_CHARS, FOLLOWUP_PROMPT_VERSION, FOLLOWUP_REQUESTS_MAX, fitSentMail, followupBudget, type AiTasks, type SentMailResult } from "@terno/ai";
import { addressKey, automatedLevel, dayKeyOf, dueCutoff, byUrgency, followupDue, NUDGE_DEFAULT, followupWakeAt, normalizeText, promiseOver, readCorpus, refKey, replyAnswers, replyRecipients, SCAN_DAYS, SCAN_MESSAGES_MAX, SCAN_PROMISE_OVERDUE_MS, SCAN_WAIT_STALE_MS, validFollowupDate, withNeeds, withoutQuotes, followupNotice, type AiErrorKind, type DatedRow, type FollowupRow, type FollowupsSnapshot, type MailNotice, type ThreadSummary } from "@terno/core";
import { captureError } from "@terno/core/diag";
import { RpcError, type AppSettings } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, L, type LocaleId } from "@terno/i18n";
import { AWAITING_ITEM, HELD_REQUEST_CLOSED, type FollowupFinish, type FollowupSnapshot, type FollowupSource, type FollowupWrite, type MailStore, type SentMark } from "@terno/store";
import { AccountChecks, FOLLOWUPS_CHECKED_KEY } from "./account-checks";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { UI_LOCALE_KEY } from "./forwarding";
import { contextOf, directsReader, namingWords, norm as plain, paidSaid, plainEvidence, saidClauses, sameObject, sentencesOf, sentencesWith } from "./dated-evidence";
import { promiseMoment } from "./promise-time";

const MAX_DELAY = 2 ** 31 - 1;
const PAGE = 50;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60_000;
/** one that came due longer ago than this (Terno was closed for days) is on the Inbox's top, not announced */
const NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 1000;
const UNDO_KEPT = 50;
/**
 * Plan 211: on by default there's no moment it went on: what was sent before the check's window is never read live (the
 * check of mail already here reads that window, per account). Turned on by hand, from that moment, as before.
 */
const liveSince = (enabledAt: number | null, now: number): number => enabledAt ?? now - SCAN_DAYS * 86_400_000;

export interface FollowupHost {
  readonly store: MailStore;
  now(): number;
  /** plan 211: the account's AI and What matters switches both on (a lookup) */
  inFeed(accountId: number): boolean;
  settings(): Promise<AppSettings>;
  forTask(): Promise<AiTasks>;
  /** a request a change of provider aborts */
  begin(requestId: string, clientId: string): { signal: AbortSignal; release: () => void };
  /** the account's own switch */
  accountWanted(accountId: number): Promise<boolean>;
  /** the gate (plans 147, 150): AI can run at all */
  allowed(settings: AppSettings): Promise<boolean>;
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
 * Round 19: whether your words ask the person something back (a question, "could you", "let me know", "¿me dices…?"), as
 * `plain` reads them. Its code review: or tell them to do something, a clause that starts on its verb ("Send me the
 * available shifts in the meantime", "mándame los turnos", "pásame la lista").
 */
const ASKS_BACK = /\b(?:could you|can you|would you|will you|do you|are you|please|let me know|tell me|need you to|want you to|por favor|puedes|podrias|me (?:dices|avisas|confirmas|mandas|envias|pasas)|avisame|dime|confirmame|necesito que)\b/u;
const asksBack = (text: string): boolean => /[?¿]/u.test(text) || ASKS_BACK.test(plain(text)) || saidClauses(text).some(directsReader);

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

/** a promise's quote that is the evidence piece, or holds it, or makes half its words or more */
function answersBy(quote: string, piece: string): boolean {
  if (!sameWords(quote, piece)) return false;
  const [q, p] = [norm(quote).toLowerCase(), norm(piece).toLowerCase()];
  return q.includes(p) || wordCount(q) * 2 >= wordCount(p);
}
const WHEN_WORD = /^(?:today|tomorrow|tonight|next|week|weekend|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|hoy|manana|semana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|proxima|proximo)$/u;
/**
 * The Codex code review of round 18: a promise in the evidence is the answer unless it names something the request doesn't
 * ("do the merch plug in the next one" beside "Send Kai notes on cut v2"); one naming nothing but times ("send it Friday")
 * or the request's own thing ("send the final figures Friday") is the answer, however long the evidence around it.
 */
function aboutElse(promise: string, request: string | undefined): boolean {
  if (!request) return false;
  const asked = namingWords(request, { names: false });
  const named = [...namingWords(promise, { names: false })].filter((w) => !WHEN_WORD.test(w));
  return named.length > 0 && !named.some((w) => asked.has(w));
}

const ELLIPSIS =/\s*(?:\[(?:\.{3}|…)\]|\.{3}|…)\s*/u;
/**
 * Plan 210 (round 14's faults, Priya's 409A): a verdict's or a kept promise's evidence, as pieces of their own words. The
 * model shortens a long answer with an ellipsis ("We've used Calder Valuation for our last two. ... Yes, I'd use them
 * again."), which no text holds whole, so the answer settled nothing: such evidence is its pieces, each of two words or more
 * and in their words in that order. Words with an ellipsis of their own ("Well... yes") are read whole first. The second
 * morning: the model also joins them with no ellipsis at all (`joinedLines`). Null: not theirs.
 */
export function ownPieces(evidence: string, ownText: string): string[] | null {
  const own = norm(ownText);
  const whole = norm(evidence);
  if (!whole) return null;
  // round 18 (Theo's notes for Kai, quoted as "notes:" alone): a list's lead-in stands for the list it leads, their own lines
  // under it; one with no list under it is a word, which says nothing
  if (leadIn(whole)) return listUnder(whole, ownText);
  if (wordsAt(own, whole) >= 0) return [whole];
  const pieces = evidence.split(ELLIPSIS).map(norm).filter((p) => /[\p{L}\p{N}]/u.test(p));
  if (pieces.length < 2) return joinedLines(whole, ownText);
  let from = 0;
  for (const p of pieces) {
    const at = wordsAt(own, p, from);
    if (p.split(" ").length < 2 || at < 0) return null;
    from = at + p.length;
  }
  return pieces;
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
/**
 * The Codex code review of round 14's faults: where some words stand whole in a text, from `from`, never a word's tail or
 * head ("able to attend" inside "unable to attend", which a piece would turn into a yes); -1 when they don't.
 */
function wordsAt(text: string, words: string, from = 0): number {
  for (let at = text.indexOf(words, from); at >= 0; at = text.indexOf(words, at + 1)) {
    const end = at + words.length;
    const openEdge = !WORD_CHAR.test(words[0]!) || at === 0 || !WORD_CHAR.test(text[at - 1]!);
    const closeEdge = !WORD_CHAR.test(words[words.length - 1]!) || end === text.length || !WORD_CHAR.test(text[end]!);
    if (openEdge && closeEdge) return at;
  }
  return -1;
}

/** where a sentence or a line of their text ends (a colon's too: "- mic: a dynamic broadcast mic…") */
const UNIT_END = /(?<=[.!?:;])\s+|\s*\n\s*/u;
const wordCount = (s: string) => s.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Plan 210 (the second morning; round 15's Hannah and Rafa): evidence joined from their sentences or lines with nothing
 * between, the ones skipped left out ("We've used Calder Valuation for our last two. Yes, I'd use them again."; "Aquí van
 * los finales … con los ajustes: - Veracruz: aclaré el verde…", a list's lines), which no text holds whole, so the answer
 * settled or kept nothing. Such evidence is its runs: each run their words whole, two words or more, in their order; a join
 * only where a sentence or a line of theirs ends and the next run begins one, so no run is cut out of a sentence to make
 * another ("I can" of "I can't" never joins "send it"). The first run may begin, and the last end, inside one, as a quote.
 * Round 16 (Theo's notes for Kai): a list's lead-in of one word ("notes:", "cambios:") is a run before the list's lines, so
 * "notes: - 3:05 the zoom on the error log is too slow" answers; never as the answer's last run.
 */
const leadIn = (run: string) => /^[\p{L}\p{N}]+:$/u.test(run.trim());
const LIST_LINE = /^\s*(?:[-•*–]|\d{1,2}[.)])\s+(.+)$/u;
/** a lead-in's list: the lead-in, then the list lines right under it in their text (blank lines between allowed); null for none */
function listUnder(lead: string, ownText: string): string[] | null {
  const lines = normalizeText(ownText).split("\n");
  const at = lines.findIndex((l) => norm(l).endsWith(lead) && (norm(l) === lead || /[\s.!?]$/u.test(norm(l).slice(0, -lead.length))));
  if (at < 0) return null;
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) {
      if (items.length) break;
      continue;
    }
    const m = LIST_LINE.exec(line);
    if (!m) break;
    items.push(norm(m[1]!));
  }
  return items.length ? [lead, ...items] : null;
}
function joinedLines(evidence: string, ownText: string): string[] | null {
  const units = normalizeText(ownText).split(UNIT_END).map(norm).filter(Boolean);
  // the same text as `norm`'s, each unit's start and end in it
  const own = units.join(" ");
  const starts: number[] = [];
  let next = 0;
  for (const u of units) {
    starts.push(next);
    next += u.length + 1;
  }
  const ends = new Set(units.map((u, i) => starts[i]! + u.length));
  // round 17 (Theo's audio setup, "mic: a dynamic broadcast mic on a boom arm; interface: Audiomesh Duo; walls: …"): a list
  // line's words begin after its marker ("- ", "• ", "1. "), and a run may end at a comma inside a line of theirs when the
  // rest of that line qualifies nothing ("…boom arm, about 4 inches from my face"; never "…, but not before Friday")
  const lineStarts = starts.flatMap((x) => {
    const marker = /^(?:[-•*–]|\d{1,2}[.)]) /u.exec(own.slice(x));
    return marker ? [x, x + marker[0].length] : [x];
  });
  const unitEnd = (x: number) => Math.min(...[...ends].filter((e) => e >= x));
  // (the Codex code review: conditions too, "…, provided I get approval", "…, siempre que me lo aprueben")
  const QUALIFIES = /\b(?:but|not|no|never|unless|except|only|until|if|provided|providing|as long as|assuming|subject to|depending|once|after|pending|pero|sin|nunca|salvo|excepto|a menos que|hasta que|solo|si|siempre que|siempre y cuando|con tal de que|dependiendo|sujeto a|cuando|en cuanto|despues de)\b/u;
  // (or right before the stop that ends one of their sentences, "…3 mm." quoted as "…3 mm;")
  const clauseEnd = (x: number) => (own[x] === "," && !QUALIFIES.test(own.slice(x, unitEnd(x)))) || (/[.!?;:]/u.test(own[x] ?? "") && ends.has(x + 1));
  const wordEnd = (x: number) => x === own.length || !WORD_CHAR.test(own[x]!) || !WORD_CHAR.test(own[x - 1]!);
  const first = [...own].flatMap((c, i) => (c === evidence[0] && (i === 0 || !WORD_CHAR.test(c) || !WORD_CHAR.test(own[i - 1]!)) ? [i] : []));
  const failed = new Set<string>();
  const search = (p: number, after: number, runs: string[]): string[] | null => {
    const key = `${p}:${after}`;
    if (failed.has(key)) return null;
    for (const s of runs.length ? lineStarts.filter((x) => x >= after) : first) {
      let length = 0;
      while (p + length < evidence.length && s + length < own.length && evidence[p + length] === own[s + length]) length++;
      // the answer's last run, ending at a word's end
      if (p + length === evidence.length && wordEnd(s + length)) {
        const all = [...runs, own.slice(s, s + length)];
        if (all.length > 1 && all.every((r, i) => wordCount(r) >= 2 || (i < all.length - 1 && leadIn(r)))) return all;
      }
      // or a run to the end of one of their sentences or lines, the answer going on with another
      for (let k = length; k >= 0; k--) {
        if (!(ends.has(s + k) || clauseEnd(s + k))) continue;
        // joined with a space, or with "; " or ", " of the answer's own
        const sep = /^[;,]? /u.exec(evidence.slice(p + k));
        if (!sep || k === 0) continue;
        const run = own.slice(s, s + k);
        if (wordCount(run) < 2 && !leadIn(run)) continue;
        const found = search(p + k + sep[0].length, s + k + 1, [...runs, run]);
        if (found) return found;
      }
    }
    failed.add(key);
    return null;
  };
  return search(0, 0, []);
}

/**
 * Plan 210 (round 14's faults, the second morning): the open promise of yours a new one says again: to the same person, in
 * this conversation (`open`, newest first), of the same deliverable (`sameObject`: Theo's "full written update" for Monday
 * morning after Friday's "full written update with the numbers and the board deck appendix"), never two deliverables to one
 * person ("the board deck", "the signed term sheet"), one this reply keeps, or one that only holds a request. The older's
 * day counts as missed (`brokenDueAt`) only when it was over before this was said, as a person's move reads it, and only
 * when this one moves it (it names a day, or the older named none).
 */
export function renewedPromise(p: FollowupWrite, open: Iterable<FollowupRow>, o: { kept: ReadonlySet<number>; sentAt: number }): FollowupWrite["renews"] {
  if (p.kind !== "promise" || !p.personEmail) return undefined;
  const person = addressKey(p.personEmail);
  for (const x of open) {
    if (x.kind !== "promise" || x.holds != null || o.kept.has(x.id) || !x.personEmail || addressKey(x.personEmail) !== person || !sameObject(x.text, p.text)) continue;
    const moves = p.dated || !x.dated;
    const broken = moves && x.dated && dueCutoff(dayKeyOf(x.dueAt), x.partOfDay) <= o.sentAt ? x.dueAt : null;
    return { id: x.id, revision: x.revision, brokenDueAt: broken };
  }
  return undefined;
}

/** The sentences some words of the reply touch: each its quote's sentences is in, or one inside it (a quote across two). */
function touches(quote: string, sentences: ReturnType<typeof sentencesOf>): Set<number> {
  return new Set([...sentencesWith(quote, sentences), ...sentencesOf(quote).flatMap((q) => sentencesWith(q.said, sentences))]);
}
// what any holding says, never the thing held ("get back to her", "check whether")
const HOLDS_WORDS = new Set(["back", "check", "whether", "sure", "first"]);
/** Whether a holding promise and a request name a thing in common (names aside), as their texts say it. */
function namesBoth(promise: string, request: string): boolean {
  const asked = namingWords(request, { names: false });
  return [...namingWords(promise, { names: false })].some((w) => asked.has(w) && !HOLDS_WORDS.has(w));
}

export function checkSentMail(result: SentMailResult, input: { ownText: string; recipients: readonly { label: string; name: string; email: string }[]; open: ReadonlyMap<string, FollowupRow>; requests?: ReadonlyMap<string, Pick<DatedRow, "id" | "revision"> & Partial<Pick<DatedRow, "senderKey" | "text" | "kind">>>; sentAt: number; nudgeAfterDays: number }): { rows: FollowupWrite[]; kept: { id: number; revision: number }[]; verdicts: Verdict[] } {
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
    // plan 210 (iteration 2): a time its words state is its moment; iteration 5, only one its quote states, and a part of its
    // day stored, never written as a clock
    const { dueAt, timed, text, partOfDay } = promiseMoment({ text: p.text, quote: p.quote, day: due, part: p.partOfDay ?? null }, day, input.sentAt);
    rows.push({ kind: "promise", item, text: yourWords(text), quote: p.quote, personName: to?.name || null, personEmail: to?.email ?? null, dueAt, dated: day.dated, ...(timed ? { timed } : {}), ...(partOfDay ? { partOfDay } : {}) });
  });
  const kept = result.kept.flatMap((k) => {
    const row = input.open.get(k.label);
    return row && ownPieces(k.evidence, input.ownText) ? [{ id: row.id, revision: row.revision }] : [];
  });
  /**
   * Plan 210 (iteration 3, the Codex review's revision 1): a verdict on a request it was shown, evidence-checked like the rest:
   * their words, two or more, never words to the app. Done now settles it; a concrete promise kept above links it (one
   * that only holds it, "let me check and get back to you", holds it: iteration 4); a "done" whose words are a promise's is
   * that promise; anything else leaves it.
   */
  const sentences = sentencesOf(input.ownText);
  // a done verdict's sentences, by its request (the second morning: where a holding promise in them holds it instead)
  const doneIn = new Map<number, Set<number>>();
  const verdicts = (result.answers ?? []).flatMap((a): Verdict[] => {
    const request = input.requests?.get(a.label);
    if (!request || a.verdict === "unknown") return [];
    const pieces = ownPieces(a.evidence, input.ownText);
    if (!pieces || !plainEvidence(pieces.join(" "), pieces.map((p) => contextOf(p, sentences)).join(" "))) return [];
    // round 18 (Theo's notes for Kai): a promise is the answer when it's what the evidence says, its words most of a piece;
    // one said in passing inside a longer answer ("…drop the merch plug, we'll do it in the next one" among five notes sent)
    // is a promise of its own, and the answer stands
    // (its code review: judged on the whole answer, never one line of a list at a time; and by what the promise is about)
    const promise = rows.find((r) => r.kind === "promise" && r.quote && pieces.some((p) => sameWords(r.quote!, p)) && (answersBy(r.quote!, pieces.join(" ")) || (request.text !== undefined && !aboutElse(r.text, request.text))));
    // the code review of round 18: a list's lead-in answers only with a list about what was asked (the lead-in or its lines
    // name the request's thing: "notes:" for notes); "notes:" over lunch and parking never signs a contract
    if (pieces.length > 1 && leadIn(pieces[0]!) && request.text) {
      const asked = namingWords(request.text, { names: false });
      if (![...namingWords(pieces.join(" "), { names: false })].some((w) => asked.has(w) || asked.has(w.replace(/:$/u, "")))) return [];
    }
    const shown = { id: request.id, revision: request.revision };
    // round 16's code review: a bill (from a person this reply writes to) only by your saying it's paid ("just venmo'd you",
    // never "I have not paid it yet"); a promise to pay it links nothing, the bill keeping its own row
    // (its second round: judged on the whole sentences the evidence is in, never the words it quotes alone)
    const said = [...new Set(pieces.flatMap((p) => [...touches(p, sentences)]))].sort((x, y) => x - y).map((n) => sentences[n]!.said);
    if (request.kind === "pay") return a.verdict === "fulfilled" && !promise && paidSaid(said.length ? said : pieces) ? [{ request: shown, verdict: "fulfilled" as const }] : [];
    // plan 210 (iteration 4, the Codex review's revision 4): a promise that only holds it is stored with it, whatever the
    // model called it ("holding" kept, no longer dropped); a "holding" whose words also send or sign something links nothing
    if (promise && onlyHolds(promise.quote!)) return [{ request: shown, verdict: "holding" as const, item: promise.item }];
    if (promise) return a.verdict === "holding" ? [] : [{ request: shown, verdict: "promise" as const, item: promise.item }];
    if (a.verdict !== "fulfilled") return [];
    doneIn.set(request.id, new Set(pieces.flatMap((p) => [...touches(p, sentences)])));
    return [{ request: shown, verdict: "fulfilled" as const }];
  });
  /**
   * Plan 210 (the second morning, Priya's offsite): a reply that holds the question in the words it was "done" with ("My gut
   * says Sonoma too, but let me check … I'll get back to you") never does it: a "done" on a request from the person this
   * reply's holding promise is to, holding no other request, is that holding when it qualifies what was asked: its words in a
   * sentence of that evidence ("…too, but let me check"), or a thing named in both it and the request. Its code review: a
   * promise only beside it, the paragraph alone, holds nothing ("There will be five of us. I'll let you know Monday if I'm
   * working Thursday": the head count is done).
   */
  const holding = rows.filter((r) => r.kind === "promise" && r.quote && onlyHolds(r.quote) && !verdicts.some((v) => v.verdict !== "fulfilled" && v.item === r.item));
  const asked = new Map([...(input.requests?.values() ?? [])].map((r) => [r.id, r]));
  for (const [i, v] of verdicts.entries()) {
    if (v.verdict !== "fulfilled") continue;
    const request = asked.get(v.request.id);
    const from = request?.senderKey;
    const said = doneIn.get(v.request.id);
    const qualifies = (r: FollowupWrite) => [...touches(r.quote!, sentences)].some((n) => said?.has(n)) || (request?.text !== undefined && namesBoth(r.text, request.text));
    const held = holding.find((r) => (from === undefined || (r.personEmail != null && addressKey(r.personEmail) === from)) && qualifies(r));
    if (!held) continue;
    verdicts[i] = { request: v.request, verdict: "holding", item: held.item };
    holding.splice(holding.indexOf(held), 1);
  }
  if (result.expectsReply) {
    // round 19 (María's "let me check with Chris … and I'll get back to you", read as waiting on Jessica): a reply that holds
    // a person's request and asks them nothing waits on no reply of theirs: the next word is the reader's (the prompt's own
    // "false when it only promises to get back to them", which the reading broke)
    const quiet = !asksBack(input.ownText);
    const heldFrom = (email: string) =>
      verdicts.some((v) => {
        const from = v.verdict === "holding" ? asked.get(v.request.id)?.senderKey : null;
        return from === undefined || (!!from && from === addressKey(email));
      });
    const who = result.awaiting.flatMap((label) => person.get(label) ?? []).filter((r) => isPerson(r.email) && !(quiet && heldFrom(r.email)));
    const first = who[0];
    if (first) {
      const { dueAt, dated } = followupDue({ kind: "awaiting", sentAt: input.sentAt, due: null, nudgeAfterDays: input.nudgeAfterDays });
      rows.push({ kind: "awaiting", item: AWAITING_ITEM, text: "", quote: null, personName: first.name || null, personEmail: first.email, dueAt, dated });
    }
  }
  // plan 210 (round 14's faults, the second morning): a promise said again is the older one's, never a row beside it. One
  // answering a request this reply does is kept with it by the store (the second morning, Diego's adjustments; its code
  // review: only once that verdict passes the request's revision), so it's renewed by nothing here either
  const done = new Set(verdicts.flatMap((v) => (v.verdict === "fulfilled" ? [v.request.id] : [])));
  const keptIds = new Set([...kept.map((k) => k.id), ...[...input.open.values()].flatMap((p) => (p.answers != null && done.has(p.answers) ? [p.id] : []))]);
  for (const r of rows) {
    const renews = renewedPromise(r, input.open.values(), { kept: keptIds, sentAt: input.sentAt });
    if (renews) r.renews = renews;
  }
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

  /** plan 211: the check of what you sent, the backend's, one account at a time */
  private readonly checks: AccountChecks;

  constructor(private readonly host: FollowupHost) {
    this.checks = new AccountChecks({
      store: host.store,
      key: FOLLOWUPS_CHECKED_KEY,
      now: () => host.now(),
      active: async () => this.isActive && (await host.allowed(await host.settings())),
      allowed: (accountId) => host.inFeed(accountId),
      wanted: (accountId) => host.accountWanted(accountId),
      check: (accountId, since) => this.checkAccount(accountId, since),
      log: (level, message, extra) => host.log(level, message, extra),
    });
  }

  get isActive(): boolean {
    return this.active && !this.stopped;
  }
  /** the moment it went on: what was sent before it isn't marked (revision of §2); on by default, the check's window (plan 211) */
  get since(): number {
    return liveSince(this.enabledAt, this.host.now());
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

  /** `checks: false`: the upgrade of the offers' answers failed (Codex code review 3): nothing is checked until a start where it worked. */
  async start(o: { checks?: boolean } = {}): Promise<void> {
    const { enabled, enabledAt, nudgeAfterDays } = (await this.host.settings()).followups;
    this.active = enabled;
    this.enabledAt = enabledAt;
    this.nudgeDays = nudgeAfterDays;
    if (this.stopped) return;
    await this.look();
    if (this.active) this.wake();
    // plan 211: accounts synced and never checked (or owed a gap), in the background, while it's on
    if (o.checks !== false) void this.checks.start();
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
    // plan 211: what it sends from now on is owed a check when it's back
    void this.checks.withdrawn(accountId);
  }

  /** Plan 211 (revision 9): an account's sync pass ended with it synced: checked once, a lookup after. */
  synced(accountId: number): Promise<void> {
    return this.isActive ? this.checks.synced(accountId) : Promise.resolve();
  }

  /** Plan 211: an account's switches (or its own) came back on: what it's owed (never checked: the window; checked: since one went off). */
  checkAccounts(accountIds: readonly number[]): Promise<void> {
    return this.isActive ? this.checks.reconcile(accountIds) : Promise.resolve();
  }

  /** Plan 211: an account removed is forgotten (its id may come back). */
  accountRemoved(accountId: number): Promise<void> {
    return this.checks.forget(accountId);
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
    // plan 211: turned on, or AI available: accounts not checked yet are
    if (on) void this.checks.reconcile();
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
        // a wake while a provider was failing waits its minute like any other (plan 211: the dated reader, on by default, wakes
        // this one each time it catches up)
      } while (this.again && this.isActive && !this.paused && !this.limited && this.host.now() >= this.heldUntil);
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
    // what was sent before it went on is the check's: its own marks are; on by default, its window (plan 211)
    if (mark.source === "live" && src.date < liveSince(settings.followups.enabledAt, this.host.now())) return drop();
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
      // plan 210 (iteration 3): what the conversation asked of you before this, open (a promise may already answer one); round
      // 16: a bill from someone it writes to too (`replyAnswers`)
      const writesTo = replyRecipients(src);
      const requested = settings.dated?.enabled ? (await store.dated.ofThread(src.threadId)).filter((r) => replyAnswers(r, writesTo) && r.arrivedAt < src.date).sort((a, b) => b.arrivedAt - a.arrivedAt).slice(0, FOLLOWUP_REQUESTS_MAX) : [];
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
    const promised = due.filter((r) => r.kind === "promise" && !r.fromScan && r.inboxState === "onTop" && followupWakeAt(r) > now - NOTIFY_WINDOW_MS);
    if (!promised.length) return;
    const threads = new Map((await this.host.summaries(promised.map((r) => r.threadId))).map((t) => [t.id, t]));
    // plan 211: a promise of an account with AI or What matters off isn't shown, so it isn't said either (nor claimed: back
    // on, a promise still due is said then)
    const fresh = promised.filter((r) => {
      const t = threads.get(r.threadId);
      return !t || this.host.inFeed(t.accountId);
    });
    if (!fresh.length) return;
    const claimed = new Set(await this.host.store.followups.claimNotice(fresh.map((r) => r.id), now));
    const rows = fresh.filter((r) => claimed.has(r.id));
    if (!rows.length) return;
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

  // ─── §8: the check of what you sent (plan 211: the backend's, one account at a time) ─────

  /**
   * Plan 211: one account's check, queued: its last 30 days, at most `SCAN_MESSAGES_MAX`; from `since` when it's a gap's (a
   * switch off, then on again: revisions 7 and 8), still within the 30 days. `queueScan` ignores what's marked.
   */
  private async checkAccount(accountId: number, since: number | null): Promise<boolean> {
    // asked again here, and once the candidates are read (Codex code review 2): off meanwhile, it isn't checked, nor recorded
    const allowed = async () => this.isActive && (await this.host.accountWanted(accountId));
    if (!(await allowed())) return false;
    const now = this.host.now();
    const from = Math.max(now - SCAN_DAYS * 86_400_000, since ?? -Infinity);
    const ids = await this.host.store.followups.scanCandidates(from, SCAN_MESSAGES_MAX, accountId);
    if (!(await allowed())) return false;
    if (await this.host.store.followups.marks.queueScan(ids, now)) this.wake();
    return true;
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


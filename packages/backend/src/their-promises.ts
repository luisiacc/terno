import type { TheirMailResult } from "@terno/ai";
import { hasCommitmentCue, normalizeText, theirDue, THEIRS_ITEM, validFollowupDate, type FollowupRow } from "@terno/core";
import type { OwedRef, OwedWrite } from "@terno/store";
import { namingWords, talksToTheApp } from "./dated-evidence";

/**
 * Plan 280's local checks, before anything's stored: a promise's quote is the sender's own words, a closing's or a move's
 * evidence is too (or, for a delivery only, the name of a file it carries that names the thing), a date must make sense, a
 * label must be one it was given, and a relay only ever hints. Pure, so each can be tested on its own. Only the debtor's
 * own mail can keep, move or withdraw what they owe: the store holds that rule, in the commit.
 */

/** Normalized, as a person retyping it would: a quote must really be in what they wrote. */
const norm = (text: string) => normalizeText(text).replace(/\s+/g, " ").trim().toLowerCase();
const inText = (words: string, text: string) => {
  const w = norm(words);
  return w.length > 0 && norm(text).includes(w);
};

/** Revision 6: words that say it hasn't happened ("the contract wasn't sent", "todavía no"): never a delivery */
const NOT_YET = /\b(?:not|no|never|yet to|still|wasn't|isn't|hasn't|haven't|didn't|won't|can't|cannot|couldn't|todavia|aun no|aun sin|sin|nunca|falta|pendiente)\b|n't\b/u;
// (the Astra review: a typographic apostrophe is the plain one, so "can’t" reads as "can't")
export const saysNotYet = (evidence: string): boolean => NOT_YET.test(normalizeText(evidence).toLowerCase().replace(/[’‘ʼ]/gu, "'").normalize("NFD").replace(/\p{M}/gu, ""));

/**
 * The code review: evidence is judged with the whole of the sentences it's in, never its words cut out of one ("send the
 * contract" from "I can't send the contract until Friday" keeps nothing).
 */
export function deliveredIn(evidence: string, text: string): boolean {
  const e = norm(evidence);
  if (!e) return false;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u).map((x) => x.trim()).filter(Boolean);
  const around = sentences.filter((x) => norm(x).includes(e) || e.includes(norm(x)));
  return !saysNotYet(evidence) && !around.some(saysNotYet);
}

/** The words a file's name and a promise's text share ("Contract_signed.pdf" and "send you the contract"). */
const fileWords = (name: string) => namingWords(name.replace(/\.[a-z0-9]{1,5}$/iu, "").replace(/[_\-.]+/gu, " ").toLowerCase(), { names: false });
export const fileNames = (name: string, text: string): boolean => {
  const promised = namingWords(text, { names: false });
  return [...fileWords(name)].some((w) => promised.has(w));
};

/** A greeting, a name and a sign-off at most ("Hi Nora,", "Here you go", "Best, Alex"): nothing said of its own. */
const GREETING = /^(?:hi|hello|hey|dear|hola|buenas|buenos dias|here you go|here you are|aqui tienes|aqui va|aqui esta|thanks|thank you|gracias|best|regards|saludos|cheers|un saludo)\b/u;
export function bare(text: string): boolean {
  const lines = text.split(/\n+/u).map((l) => norm(l)).filter(Boolean);
  return lines.every((l) => l.split(" ").length <= 4 && (GREETING.test(l.normalize("NFD").replace(/\p{M}/gu, "")) || l.split(" ").length <= 2));
}

/** Whether the mail claims a file as the delivery: only then are all the debtor's promises read for the file's uniqueness. */
export const claimsFile = (result: TheirMailResult, attachments: readonly string[]): boolean => result.kept.some((k) => attachments.some((f) => norm(f) === norm(k.evidence)));

/**
 * The QA panel: whether some words talk to the app rather than say something, for this reader's own labels (t1, t2…) and
 * verbs ("mark … as received"). The dated reader's own patterns name its labels (o1, p1) and "open items", which ordinary
 * mail says ("Two open items flagged in yellow"): those are left to it.
 */
const TO_THIS_APP = /\bt\d{1,2}\b|\bopen promises?\b|\b(?:mark|set|treat|close|consider|count)\b (?:\S+ ){0,6}?as (?:kept|received|delivered|arrived|sent)\b/u;
const talks = (words: string): boolean => TO_THIS_APP.test(norm(words)) || talksToTheApp(words.replace(/\b(?:[op]\d{1,2}|open (?:items?|tasks?))\b/giu, " "));
export const plainOwed = (evidence: string, context: string): boolean => norm(evidence).split(" ").filter(Boolean).length >= 2 && !talks(context) && !talks(evidence);

/**
 * The QA panel: a promise's quote as the model gave it, or its leading sentences when only the last was reworded ("want the
 * budget math in it?" for "…in it too?"): kept when what's left is the sender's words whole, four words or more, and still
 * says what they'll do. Null: not theirs.
 */
export function quoteIn(quote: string, text: string): string | null {
  if (inText(quote, text)) return quote;
  const pieces = quote.split(/(?<=[.!?])\s+/u).filter(Boolean);
  for (let n = pieces.length - 1; n >= 1; n--) {
    const lead = pieces.slice(0, n).join(" ");
    if (norm(lead).split(" ").length >= 4 && inText(lead, text) && hasCommitmentCue(lead)) return lead;
  }
  return null;
}

/**
 * The QA panel: a file alone (nothing said beside it) that names exactly one open promise of its sender's, of all of
 * them, is that delivery, whatever the model made of it: a file is plain evidence, and the model passes it over.
 */
export function fileDelivers(text: string, attachments: readonly string[], debts: readonly FollowupRow[]): FollowupRow | null {
  if (!attachments.length || !bare(text)) return null;
  const named = debts.filter((d) => attachments.some((f) => fileNames(f, d.text)));
  return named.length === 1 ? named[0]! : null;
}

/**
 * The QA panel: a promise's words are said to the reader about the sender, so the sender's "my" is their name's (prompt v4's
 * rule, which a model still breaks: "send you my section of the draft"); Spanish "mi"/"mis" become "su"/"sus".
 */
export function theirWords(text: string, name: string): string {
  const first = name.trim().split(/\s+/u)[0] ?? "";
  return text
    .replace(/(?<![\p{L}\p{N}'’])my(?=\s+\p{L})/giu, first ? `${first}'s` : "their")
    .replace(/(?<![\p{L}\p{N}'’])(?<!\d\s)(mi|mis)(?=\s+\p{L})/giu, (w) => (w.toLowerCase() === "mis" ? "sus" : "su"));
}

export interface TheirChecks {
  rows: OwedWrite[];
  kept: OwedRef[];
  moved: (OwedRef & { dueAt: number; dueDay: string })[];
  withdrawn: OwedRef[];
  hints: OwedRef[];
}

export function checkTheirPromises(
  result: TheirMailResult,
  input: {
    text: string;
    attachments: readonly string[];
    /** the labels it was shown (t1, t2…) */
    owed: ReadonlyMap<string, FollowupRow>;
    /** the sender, who owes what this mail promises */
    from: { name: string; email: string };
    /** where the reader is among its recipients, and their name: a Cc'd reader only by name */
    reader: { name: string; addressed: "to" | "cc" | "none" };
    /** a service's notice: what it says may have arrived, never closes it (revision 5) */
    relay: { block: string } | null;
    /** the code review: all this person's open promises to you, shown or not, so a file names one only when no other could be it */
    debts?: readonly FollowupRow[];
    madeAt: number;
    nudgeAfterDays: number;
  },
): TheirChecks {
  const out: TheirChecks = { rows: [], kept: [], moved: [], withdrawn: [], hints: [] };
  const first = norm(input.reader.name).split(" ")[0] ?? "";
  // a relay makes no promises; a list's mail, or a blind copy, none of the reader's; a copy only one naming them
  if (!input.relay && input.reader.addressed !== "none") {
    result.promises.forEach((p, i) => {
      const quote = quoteIn(p.quote, input.text);
      if (!quote) return;
      p = { ...p, quote };
      if (input.reader.addressed === "cc" && !(first.length >= 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(norm(p.quote)))) return;
      const due = validFollowupDate(p.due, input.madeAt);
      const when = theirDue({ madeAt: input.madeAt, due, nudgeAfterDays: input.nudgeAfterDays });
      out.rows.push({ item: THEIRS_ITEM + i, text: theirWords(p.text, input.from.name), quote: p.quote, personName: input.from.name || null, personEmail: input.from.email, dueAt: when.dueAt, dated: when.dated, dueDay: when.dueDay, firm: p.firm, ...(p.partOfDay ? { partOfDay: p.partOfDay } : {}) });
    });
  }
  const ref = (label: string): OwedRef | null => {
    const r = input.owed.get(label);
    return r ? { id: r.id, revision: r.revision } : null;
  };
  const own = (evidence: string) => inText(evidence, input.text) && plainOwed(evidence, input.text);
  const done = new Set<number>();
  for (const k of result.kept) {
    const r = ref(k.label);
    if (!r) continue;
    if (input.relay) {
      // revision 5: a relay naming the thing may have delivered it: a hint, from its own words
      // (the QA panel: the model may quote it with the service's name the prompt puts before it, "SignNest: …")
      const words = inText(k.evidence, input.relay.block) ? k.evidence : k.evidence.replace(/^[^:\n]{1,60}:\s*/u, "");
      if (inText(words, input.relay.block) && deliveredIn(words, input.relay.block)) out.hints.push(r);
      continue;
    }
    // a file by its exact name, naming the promised thing, and no other open promise of this person's, shown or not; only
    // when the mail says nothing else (the Astra review: words of its own, "the final one isn't ready", are what count)
    const row = input.owed.get(k.label)!;
    const file = input.attachments.find((f) => norm(f) === norm(k.evidence));
    const debtor = row.personKey;
    const others = [...input.owed.values(), ...(input.debts ?? [])].filter((o) => o.id !== row.id && (!debtor || o.personKey === debtor));
    // (the QA panel: words around the file count too, unless any of them says it isn't ready: "plan + budget math")
    // (the QA panel: only a sentence about the thing itself: "Dime si falta algo" says nothing of the texts)
    const thing = namingWords(row.text, { names: false });
    const denies = input.text.split(/(?<=[.!?])\s+|\n+/u).some((x) => x.trim() && saysNotYet(x) && [...namingWords(x, { names: false })].some((w) => thing.has(w)));
    // the file names the thing, or (the QA panel: "Harbour_Pine_NDA_signed.pdf" for "enviarte el NDA firmado", words in two
    // languages) the model says it is, and the person owes nothing else the file could be
    const byFile = file !== undefined && (bare(input.text) || !denies) && (fileNames(file, row.text) ? !others.some((o) => fileNames(file, o.text)) : !others.length);
    if (!byFile && !(own(k.evidence) && deliveredIn(k.evidence, input.text))) continue;
    out.kept.push(r);
    done.add(r.id);
  }
  if (input.relay) return out;
  // a file alone that names one open promise of theirs closes it, said or not by the model (all of theirs, shown or not)
  const fileKept = fileDelivers(input.text, input.attachments, [...new Map([...input.owed.values(), ...(input.debts ?? [])].map((d) => [d.id, d])).values()]);
  if (fileKept && !done.has(fileKept.id)) {
    out.kept.push({ id: fileKept.id, revision: fileKept.revision });
    done.add(fileKept.id);
  }
  for (const m of result.moved) {
    const r = ref(m.label);
    const due = validFollowupDate(m.due, input.madeAt);
    if (!r || done.has(r.id) || !due || !own(m.evidence)) continue;
    const when = theirDue({ madeAt: input.madeAt, due, nudgeAfterDays: input.nudgeAfterDays });
    out.moved.push({ ...r, dueAt: when.dueAt, dueDay: due });
    done.add(r.id);
  }
  for (const w of result.withdrawn) {
    const r = ref(w.label);
    if (!r || done.has(r.id) || !own(w.evidence)) continue;
    out.withdrawn.push(r);
    done.add(r.id);
  }
  return out;
}

/**
 * Revision 5: a service's mail that names the address of someone who owes the reader something: the rows it names, and
 * its sentences that name them (at most `RELAY_CHARS`), as material. Never a close: only a hint.
 */
const RELAY_CHARS = 1200;
/** The Astra review: a whole address, never part of another ("alex@x.test" isn't in "malex@x.test") */
const names = (text: string, email: string) => new RegExp(`(?<![\\w.+-])${email.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-]|\\.\\w)`, "iu").test(text);
export function relayOf(text: string, owed: readonly FollowupRow[]): { rows: FollowupRow[]; block: string } | null {
  const rows = owed.filter((r) => r.personEmail && names(text, r.personEmail));
  if (!rows.length) return null;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
  const named = sentences.filter((s) => rows.some((r) => names(s, r.personEmail!)));
  let block = "";
  for (const s of named) {
    if (block.length + s.length + 1 > RELAY_CHARS) break;
    block += (block ? " " : "") + s;
  }
  return block ? { rows, block } : null;
}

/**
 * §2: whether a person's received message is worth asking about: a promise of theirs open on its conversation or from its
 * sender, a wait of yours on its conversation, a reply to a send of yours, or a commitment cue in their words. A cost
 * filter, not a judgment.
 */
export function owedWorth(o: { text: string; owed: number; waiting: boolean; answers?: boolean }): boolean {
  // the code review: a reply to a send of yours is read even with no cue ("Friday."), since the wait it answered may be gone
  return o.owed > 0 || o.waiting || o.answers === true || hasCommitmentCue(o.text);
}

import type { TheirMailResult } from "@terno/ai";
import { hasCommitmentCue, normalizeText, theirDue, THEIRS_ITEM, validFollowupDate, type FollowupRow } from "@terno/core";
import type { OwedRef, OwedWrite } from "@terno/store";
import { namingWords, plainEvidence } from "./dated-evidence";

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
export const saysNotYet = (evidence: string): boolean => NOT_YET.test(normalizeText(evidence).toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""));

/** The words a file's name and a promise's text share ("Contract_signed.pdf" and "send you the contract"). */
const fileWords = (name: string) => namingWords(name.replace(/\.[a-z0-9]{1,5}$/iu, "").replace(/[_\-.]+/gu, " ").toLowerCase(), { names: false });
export const fileNames = (name: string, text: string): boolean => {
  const promised = namingWords(text, { names: false });
  return [...fileWords(name)].some((w) => promised.has(w));
};

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
    madeAt: number;
    nudgeAfterDays: number;
  },
): TheirChecks {
  const out: TheirChecks = { rows: [], kept: [], moved: [], withdrawn: [], hints: [] };
  const first = norm(input.reader.name).split(" ")[0] ?? "";
  // a relay makes no promises; a list's mail, or a blind copy, none of the reader's; a copy only one naming them
  if (!input.relay && input.reader.addressed !== "none") {
    result.promises.forEach((p, i) => {
      if (!inText(p.quote, input.text)) return;
      if (input.reader.addressed === "cc" && !(first.length >= 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(norm(p.quote)))) return;
      const due = validFollowupDate(p.due, input.madeAt);
      const when = theirDue({ madeAt: input.madeAt, due, nudgeAfterDays: input.nudgeAfterDays });
      out.rows.push({ item: THEIRS_ITEM + i, text: p.text, quote: p.quote, personName: input.from.name || null, personEmail: input.from.email, dueAt: when.dueAt, dated: when.dated, dueDay: when.dueDay, firm: p.firm, ...(p.partOfDay ? { partOfDay: p.partOfDay } : {}) });
    });
  }
  const ref = (label: string): OwedRef | null => {
    const r = input.owed.get(label);
    return r ? { id: r.id, revision: r.revision } : null;
  };
  const own = (evidence: string) => inText(evidence, input.text) && plainEvidence(evidence, input.text);
  const done = new Set<number>();
  for (const k of result.kept) {
    const r = ref(k.label);
    if (!r || saysNotYet(k.evidence)) continue;
    if (input.relay) {
      // revision 5: a relay naming the thing may have delivered it: a hint, from its own words
      if (inText(k.evidence, input.relay.block)) out.hints.push(r);
      continue;
    }
    // a file by its exact name, naming the promised thing, and no other open promise of this person's
    const row = input.owed.get(k.label)!;
    const file = input.attachments.find((f) => norm(f) === norm(k.evidence));
    const byFile = file !== undefined && fileNames(file, row.text) && ![...input.owed.values()].some((o) => o.id !== row.id && fileNames(file, o.text));
    if (!byFile && !own(k.evidence)) continue;
    out.kept.push(r);
    done.add(r.id);
  }
  if (input.relay) return out;
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
export function relayOf(text: string, owed: readonly FollowupRow[]): { rows: FollowupRow[]; block: string } | null {
  const lower = text.toLowerCase();
  const rows = owed.filter((r) => r.personEmail && lower.includes(r.personEmail.toLowerCase()));
  if (!rows.length) return null;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
  const named = sentences.filter((s) => rows.some((r) => s.toLowerCase().includes(r.personEmail!.toLowerCase())));
  let block = "";
  for (const s of named) {
    if (block.length + s.length + 1 > RELAY_CHARS) break;
    block += (block ? " " : "") + s;
  }
  return block ? { rows, block } : null;
}

/**
 * §2: whether a person's received message is worth asking about: a promise of theirs open on its conversation or from its
 * sender, a wait of yours on its conversation, or a commitment cue in their words. A cost filter, not a judgment.
 */
export function owedWorth(o: { text: string; owed: number; waiting: boolean }): boolean {
  return o.owed > 0 || o.waiting || hasCommitmentCue(o.text);
}

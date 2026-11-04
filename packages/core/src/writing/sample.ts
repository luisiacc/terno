import { estimateTokens, type VoiceScope, type WrittenMail } from "./types";

/** Plan 133 §2: what the model gets to read for a judgment. Deterministic: the same corpus gives the same sample. */

export interface SampleLimits {
  maxMessages: number;
  maxTokens: number;
  perRecipient: number;
}

export const SAMPLE_LIMITS: Readonly<Record<VoiceScope, SampleLimits>> = {
  you: { maxMessages: 40, maxTokens: 6000, perRecipient: 3 },
  account: { maxMessages: 40, maxTokens: 6000, perRecipient: 3 },
  domain: { maxMessages: 15, maxTokens: 3000, perRecipient: 3 },
  // the recipient is the scope, so the cap per recipient would stop it at 3
  person: { maxMessages: 15, maxTokens: 3000, perRecipient: 15 },
};

/** A template, or any exact repeat, says one thing once. */
const fingerprint = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const lengthBand = (words: number) => (words < 15 ? "short" : words < 60 ? "medium" : "long");

const stratum = (m: WrittenMail) => [lengthBand(m.words), m.language, m.isReply ? "reply" : "new", m.to.length + m.cc.length === 1 ? "one" : "group"].join("|");

const newestFirst = (a: WrittenMail, b: WrittenMail) => b.at - a.at || (String(a.id) < String(b.id) ? -1 : 1);

/** Forwards with no own text, bulk mail, the model's own unchanged text, exact duplicates: out of the sample only. */
export function sampleable(mails: readonly WrittenMail[]): WrittenMail[] {
  const seen = new Set<string>();
  const out: WrittenMail[] = [];
  for (const m of [...mails].sort(newestFirst)) {
    if (m.bulk || m.fromModel || m.words === 0) continue;
    const f = fingerprint(m.text);
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(m);
  }
  return out;
}

/**
 * §6.2: the messages to this person that go into a draft: same kind first (reply vs new, one-to-one vs group), the same
 * language preferred, newest first, exact duplicates out, whole.
 */
export function chooseExamples(mails: readonly WrittenMail[], want: { isReply: boolean; oneToOne: boolean; language: string }, limit = 4): WrittenMail[] {
  const oneToOne = (m: WrittenMail) => m.to.length + m.cc.length === 1;
  const score = (m: WrittenMail) => (m.isReply === want.isReply ? 2 : 0) + (oneToOne(m) === want.oneToOne ? 2 : 0) + (!want.language || !m.language || m.language === want.language ? 5 : 0);
  return sampleable(mails)
    .filter((m) => m.words > 0)
    .sort((a, b) => score(b) - score(a) || newestFirst(a, b))
    .slice(0, limit);
}

/** Largest remainders, so every stratum with a claim gets its share and the total is exact. */
function quotas(sizes: readonly number[], room: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  const exact = sizes.map((s) => (total === 0 ? 0 : (s * room) / total));
  const out = exact.map(Math.floor);
  let left = Math.min(room, total) - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, rest: e - Math.floor(e) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (out[i]! < sizes[i]!) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

export function chooseSample(mails: readonly WrittenMail[], limits: SampleLimits): WrittenMail[] {
  const pool = sampleable(mails);
  const strata = new Map<string, WrittenMail[]>();
  for (const m of pool) {
    const key = stratum(m);
    const list = strata.get(key);
    if (list) list.push(m);
    else strata.set(key, [m]);
  }
  const keys = [...strata.keys()].sort();
  const room = quotas(keys.map((k) => strata.get(k)!.length), limits.maxMessages);
  const chosen = new Set<WrittenMail>();
  const perRecipient = new Map<string, number>();
  let tokens = 0;
  const take = (m: WrittenMail) => {
    if (chosen.has(m) || chosen.size >= limits.maxMessages) return false;
    const cost = estimateTokens(m.text);
    if (tokens + cost > limits.maxTokens) return false;
    if (m.to.some((r) => (perRecipient.get(r) ?? 0) >= limits.perRecipient)) return false;
    chosen.add(m);
    tokens += cost;
    for (const r of m.to) perRecipient.set(r, (perRecipient.get(r) ?? 0) + 1);
    return true;
  };
  keys.forEach((key, i) => {
    let left = room[i]!;
    for (const m of strata.get(key)!) {
      if (left <= 0) break;
      if (take(m)) left--;
    }
  });
  // a recipient cap may leave quota unused: the newest of whatever is left fills it
  for (const m of pool) if (chosen.size < limits.maxMessages) take(m);
  return [...chosen].sort(newestFirst);
}

import type { Habits, Share, VoiceJudgment, VoiceProfile, VoiceScope } from "./types";

/**
 * Plan 133 §1: each level renders only what differs from the level above, worked out here from structured values, so
 * refreshing or editing a parent never invalidates a child and there's nothing stale to maintain.
 */

export interface RenderParts {
  habits: boolean;
  phrases: boolean;
  traits: boolean;
  notes: boolean;
}

/** What a draft sends by default: the eval found traits and notes added nothing to these (plan 133, what the experiment found). */
export const LOCAL_PARTS: RenderParts = { habits: true, phrases: true, traits: false, notes: false };
export const ALL_PARTS: RenderParts = { habits: true, phrases: true, traits: true, notes: true };

export interface RenderedVoice {
  scope: VoiceScope;
  text: string;
  fromOtherAccount: boolean;
}

/** a rate has to move this much before it's worth a line */
const RATE_DELTA = 0.15;
const SHARE_DELTA = 0.2;
const LENGTH_DELTA = 0.3;
/** so the difference between 3 words and 5 isn't called a change of voice */
const LENGTH_MIN_WORDS = 4;

const pct = (share: number) => `${Math.round(share * 100)}%`;

const moved = (a: number, b: number) => Math.abs(a - b) >= Math.max(LENGTH_MIN_WORDS, LENGTH_DELTA * Math.max(a, b));

function usage(shares: readonly Share[], none: number): string {
  // a single "x" reads badly: a share that's almost none is noise
  const shown = shares.filter((s) => s.share >= 0.1).map((s) => `"${s.text.replace(/\n/g, " / ")}" ${pct(s.share)}`);
  if (none >= 0.1) shown.push(`nothing ${pct(none)}`);
  return shown.join(", ");
}

const topOf = (shares: readonly Share[]) => (shares[0] && shares[0].share >= 0.1 ? shares[0].text : null);

/** The usual choice changed, or the same one became much more or less usual: "Hola" at 27% of all mail, 80% here. */
const usageChanged = (a: readonly Share[], aNone: number, b: readonly Share[], bNone: number) =>
  topOf(a) !== topOf(b) || Math.abs(aNone - bNone) >= SHARE_DELTA || Math.abs((a[0]?.share ?? 0) - (b[0]?.share ?? 0)) >= SHARE_DELTA;

const greetingChanged = (h: Habits, p: Habits) => usageChanged(h.greetings, h.noGreeting, p.greetings, p.noGreeting);
const signOffChanged = (h: Habits, p: Habits) => usageChanged(h.signOffs, h.noSignOff, p.signOffs, p.noSignOff);

function renderRate(label: string, share: number, none: string): string {
  return share < 0.05 ? none : `${label} in ${pct(share)} of messages`;
}

/** What this level says about the counts, against its parent. */
export function renderHabits(h: Habits, parent: Habits | null): string[] {
  const lines: string[] = [];
  if (!parent || moved(h.words.median, parent.words.median) || moved(h.words.p80, parent.words.p80)) {
    lines.push(`length: usually ${h.words.median} words, ${h.words.p80} at the long end`);
  }
  if (!parent || moved(h.sentenceWords, parent.sentenceWords)) {
    if (h.sentenceWords > 0) lines.push(`sentences: about ${h.sentenceWords} words`);
  }
  if (!parent || greetingChanged(h, parent)) {
    const text = usage(h.greetings, h.noGreeting);
    if (text) lines.push(`opens with: ${text}`);
  }
  if (!parent || signOffChanged(h, parent)) {
    const text = usage(h.signOffs, h.noSignOff);
    if (text) lines.push(`closes with: ${text}`);
  }
  const rate = (key: "exclamation" | "emoji" | "bullets" | "lowercase") => !parent || Math.abs(h[key] - parent[key]) >= RATE_DELTA;
  if (rate("exclamation")) lines.push(`exclamation marks: ${renderRate("present", h.exclamation, "almost never")}`);
  if (rate("emoji")) lines.push(`emoji: ${renderRate("present", h.emoji, "none")}`);
  if (rate("bullets") && (parent || h.bullets >= 0.05)) lines.push(`lists: ${renderRate("present", h.bullets, "none")}`);
  if (rate("lowercase") && (parent || h.lowercase >= 0.05)) lines.push(`capitals: ${h.lowercase >= 0.5 ? `starts sentences in lowercase (${pct(h.lowercase)} of messages)` : `normal capitalization, lowercase in ${pct(h.lowercase)} of messages`}`);
  const language = topOf(h.languages);
  if (language && (!parent || language !== topOf(parent.languages))) lines.push(`language: ${h.languages.map((l) => `${l.text} ${pct(l.share)}`).join(", ")}`);
  return lines;
}

const TRAIT_NAMES: Record<keyof VoiceJudgment["traits"], string> = { formality: "formality", warmth: "warmth", directness: "directness", detail: "detail", humor: "humor" };
const TRAIT_MAX: Record<keyof VoiceJudgment["traits"], number> = { formality: 5, warmth: 5, directness: 5, detail: 5, humor: 2 };

function renderTraits(t: VoiceJudgment["traits"], parent: VoiceJudgment["traits"] | null): string[] {
  const keys = Object.keys(TRAIT_NAMES) as (keyof VoiceJudgment["traits"])[];
  const shown = keys.filter((k) => !parent || t[k] !== parent[k]).map((k) => `${TRAIT_NAMES[k]} ${t[k]}/${TRAIT_MAX[k]}`);
  return shown.length ? [`manner: ${shown.join(", ")}`] : [];
}

/** One level as text, or "" when it adds nothing to its parent. */
export function renderLevel(profile: VoiceProfile, parent: VoiceProfile | null, parts: RenderParts = LOCAL_PARTS): string {
  const lines: string[] = [];
  if (parts.habits) lines.push(...renderHabits(profile.habits, parent?.habits ?? null));
  if (parts.phrases) {
    const known = new Set((parent?.phrases ?? []).map((p) => p.toLowerCase()));
    const fresh = profile.phrases.filter((p) => !known.has(p.toLowerCase()));
    if (fresh.length) lines.push(`phrases they reuse: ${fresh.map((p) => `"${p}"`).join(", ")}`);
  }
  const judgment = profile.judgment;
  if (judgment) {
    if (parts.traits) lines.push(...renderTraits(judgment.traits, parent?.judgment?.traits ?? null));
    if (parts.notes) {
      const known = new Set(parent?.judgment?.notes ?? []);
      lines.push(...judgment.notes.filter((n) => !known.has(n)).map((n) => `note: ${n}`));
    }
  }
  return lines.join("\n");
}

/**
 * Every level that exists, general to specific. A person's profile from another account is absolute, so it stands on
 * its own, labelled, rather than as a difference from this account.
 */
export function renderVoices(chain: readonly VoiceProfile[], parts: RenderParts = LOCAL_PARTS): RenderedVoice[] {
  const out: RenderedVoice[] = [];
  let parent: VoiceProfile | null = null;
  for (const profile of chain) {
    const fromOtherAccount = profile.fromOtherAccount ?? false;
    const text = renderLevel(profile, fromOtherAccount ? null : parent, parts);
    if (text) out.push({ scope: profile.scope, text, fromOtherAccount });
    if (!fromOtherAccount) parent = profile;
  }
  return out;
}

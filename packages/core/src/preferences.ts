import { fnv1a } from "./categorize/features";
import { DATED_KINDS } from "./dated";
import { addressKey } from "./people";
import { normalizeText } from "./text";

/**
 * Plan 248: What matters, in the user's own words. The box's text is compiled once, on Save, into rules (`compilePreferences`
 * in `@terno/ai`), checked here, then applied around the reading, never inside it: a hide or a first acts on the projection,
 * a show brings in what a second reader finds. An empty box is no rules, and no rules is the code path that ran before
 * (§9): every caller returns early on `activeRules(...)` being empty.
 */

/** the text, at most (the field's limit; a longer text is refused, never cut) */
export const PREFERENCES_TEXT_MAX = 2000;
export const PREFERENCE_RULES_MAX = 20;
export const PREFERENCE_NOTES_MAX = 10;
export const PREFERENCE_CUES_MAX = 24;
export const PREFERENCE_CUE_CHARS = 40;
export const PREFERENCE_CRITERION_CHARS = 240;
export const PREFERENCE_UNDERSTOOD_CHARS = 200;
export const PREFERENCE_SENDERS_MAX = 10;

/** What a rule may name: an item's kind, your promises, or a conversation waiting on you. */
export const PREFERENCE_KINDS = [...DATED_KINDS, "promise", "waiting"] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];
const KINDS: ReadonlySet<string> = new Set(PREFERENCE_KINDS);
export const isPreferenceKind = (k: string): k is PreferenceKind => KINDS.has(k);

export type PreferenceEffect = "show" | "hide" | "first";
export const PREFERENCE_EFFECTS: readonly PreferenceEffect[] = ["show", "hide", "first"];

export interface PreferenceRule {
  /** r1, r2…: this compile's label */
  id: string;
  /** what it means, stable across saves (`ruleKey`): items it brought and verdicts against it survive an edit that keeps it */
  key: string;
  /** the user's own words it came from */
  said: string;
  effect: PreferenceEffect;
  /** only these rows; absent: any */
  kinds?: PreferenceKind[];
  /** exact `addressKey`s, or "@domain" (the domain and its subdomains); absent: anyone */
  senders?: string[];
  /** English, for a classifier: what the rows it's about are; absent: the exact parts alone decide */
  about?: string | null;
  /** English, for a classifier: when it doesn't apply */
  unless?: string | null;
  /** a show's local filter: distinctive words that may signal it (en, es and the user's own) */
  cues?: string[];
  /** the app's language: the rule said back */
  understood: string;
}

export type PreferenceNoteKind = "unsupported" | "conflict" | "unclear" | "safety";
export interface PreferenceNote {
  said: string;
  kind: PreferenceNoteKind;
  /** the app's language */
  text: string;
}

/** The record (`whatMatters:preferences`, the store's small values), written only through `whatMatters.save` (revision-checked). */
export interface WhatMattersPreferences {
  /** bumps on every Save and Clear; a save is compare-and-swap on it */
  revision: number;
  /** the saved words ("": the empty box) */
  text: string;
  rules: PreferenceRule[];
  notes: PreferenceNote[];
  compiledWith: { version: number; provider: string; model: string } | null;
  savedAt: number | null;
  /** the language the understood lines and notes are in */
  language: string;
}

export const NO_PREFERENCES: WhatMattersPreferences = { revision: 0, text: "", rules: [], notes: [], compiledWith: null, savedAt: null, language: "en" };

/** Words typed and not saved (`whatMatters:preferencesDraft`): never lost, never the saved words; an older `seq` is ignored. */
export interface PreferencesDraft {
  /** null: no draft (the saved words are what's shown) */
  text: string | null;
  seq: number;
}

/** The rules in force: none for the empty box, whatever else the record holds (§9). */
export const activeRules = (p: WhatMattersPreferences | null | undefined): readonly PreferenceRule[] => (p && p.text.trim() ? p.rules : []);

/** A rule needs a model's judgment (a criterion or an exception), or its exact parts decide. */
export const isSemantic = (r: Pick<PreferenceRule, "about" | "unless">): boolean => !!r.about?.trim() || !!r.unless?.trim();

const squash = (s: string) => normalizeText(s).replace(/\s+/g, " ").trim();

/** What a rule means, as a key: its effect, kinds, senders and criteria, normalized; its words and labels don't count. */
export function ruleKey(r: Pick<PreferenceRule, "effect" | "kinds" | "senders" | "about" | "unless">): string {
  const parts = [r.effect, [...(r.kinds ?? [])].sort().join(","), [...(r.senders ?? [])].sort().join(","), squash(r.about ?? ""), squash(r.unless ?? "")];
  return `${r.effect[0]}${fnv1a(parts.join("\u0001")).toString(36)}`;
}

/**
 * What a row said when it was judged (the Codex review's revision 8): its kind, words, quote and day. A verdict counts only
 * for the same print, so a row a later mail rewrote or moved is judged again, while Done, Later or a merge (which change its
 * revision, not its words) keep it: the history reads the same verdict as the open part.
 */
export const rowPrint = (...parts: readonly (string | number | null | undefined)[]): string => fnv1a(parts.map((p) => String(p ?? "")).join("\u0001")).toString(36);

/** The semantic rules a verdict was judged against, as one key: a verdict counts only while it's the current one. */
export function verdictBasis(rules: readonly PreferenceRule[]): string {
  const keys = rules.filter((r) => r.effect !== "show" && isSemantic(r)).map((r) => r.key).sort();
  return keys.length ? fnv1a(keys.join(",")).toString(36) : "";
}

// ─── sender matching ───────────────────────────────────────────────────────

/** A sender as a rule holds it: an exact address (its `addressKey`) or "@domain"; null for anything else. */
export function senderSelector(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^mailto:/u, "").replace(/[<>,;]+/gu, "");
  if (/^@?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(s) && !s.includes("@", 1)) return `@${s.replace(/^@/u, "")}`;
  if (/^[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(s)) return addressKey(s);
  return null;
}

export function senderMatches(selector: string, senderKey: string): boolean {
  if (!selector.startsWith("@")) return selector === senderKey;
  const domain = senderKey.slice(senderKey.lastIndexOf("@") + 1);
  const want = selector.slice(1);
  return domain === want || domain.endsWith(`.${want}`);
}

// ─── the rows a rule may reach ─────────────────────────────────────────────

/** A row as the rules see it: a dated item (`d`), your promise (`p`) or a conversation waiting on you (`w`). */
export interface PreferenceTarget {
  kind: PreferenceKind;
  /** the item's sender, the promise's person, the waiting message's sender: an `addressKey`, "" when none */
  senderKey: string;
}

/** Whether a rule's exact parts let it reach this row (all of a rule that has no criterion; the pre-filter of one that has). */
export function exactlyReaches(r: Pick<PreferenceRule, "kinds" | "senders">, t: PreferenceTarget): boolean {
  if (r.kinds?.length && !r.kinds.includes(t.kind)) return false;
  if (r.senders?.length && !r.senders.some((s) => senderMatches(s, t.senderKey))) return false;
  return true;
}

/** A verdict as stored: which semantic rules apply to a row, by key, against the current `verdictBasis`. */
export interface PreferenceVerdict {
  target: string;
  basis: string;
  /** the semantic rules (keys) that apply */
  rules: string[];
  at: number;
}

export type PreferenceDecision = { hide: boolean; first: boolean; pending: boolean };
const SHOWN: PreferenceDecision = { hide: false, first: false, pending: false };

/**
 * Where a row stands under the rules: hidden, first, or `pending` (a semantic hide could reach it and it has no current
 * verdict yet). A hide wins over a first. `verdict` absent or of another basis: no semantic rule is known to apply.
 */
export function preferenceDecision(rules: readonly PreferenceRule[], t: PreferenceTarget, verdict: Pick<PreferenceVerdict, "rules" | "basis"> | undefined, basis: string): PreferenceDecision {
  if (!rules.length) return SHOWN;
  const judged = verdict && verdict.basis === basis ? new Set(verdict.rules) : null;
  let hide = false;
  let first = false;
  let pending = false;
  for (const r of rules) {
    if (r.effect === "show" || !exactlyReaches(r, t)) continue;
    let applies: boolean;
    if (!isSemantic(r)) applies = true;
    else if (judged) applies = judged.has(r.key);
    else {
      if (r.effect === "hide") pending = true;
      continue;
    }
    if (!applies) continue;
    if (r.effect === "hide") hide = true;
    else first = true;
  }
  return hide ? { hide, first: false, pending: false } : { hide, first, pending: pending && !hide };
}

/** The semantic rules (hide or first) whose exact parts reach a row: what a verdict for it is asked about. */
export const semanticReaching = (rules: readonly PreferenceRule[], t: PreferenceTarget): PreferenceRule[] =>
  rules.filter((r) => r.effect !== "show" && isSemantic(r) && exactlyReaches(r, t));

// ─── show: admission ───────────────────────────────────────────────────────

const words = (s: string) => ` ${squash(s).replace(/[^\p{L}\p{N}@.]+/gu, " ").replace(/\s+/g, " ").trim()} `;

/** A cue as a phrase of whole words, so "art" never matches "party" (an empty cue matches nothing). */
export function cueIn(cue: string, said: string): boolean {
  const c = words(cue).trim();
  return c.length >= 2 && said.includes(` ${c} `);
}

/**
 * Plan 248 §5: the show rules that may want a message (its sender by a rule's senders, or one of its cues in its subject or
 * text). A local filter, not a judgment: the second reader decides. The hard gates (Spam, mutes, the account's switches…)
 * are the caller's, before this.
 */
export function wantedBy(rules: readonly PreferenceRule[], m: { senderKey: string; subject: string; text?: string | null; fromName?: string }): PreferenceRule[] {
  const shows = rules.filter((r) => r.effect === "show");
  if (!shows.length) return [];
  let said: string | null = null;
  const out: PreferenceRule[] = [];
  for (const r of shows) {
    if (r.senders?.length) {
      if (r.senders.some((s) => senderMatches(s, m.senderKey))) out.push(r);
      continue;
    }
    said ??= words(`${m.fromName ?? ""}\n${m.subject}\n${m.text ?? ""}`);
    if (r.cues?.some((c) => cueIn(c, said!))) out.push(r);
  }
  return out;
}

// ─── the compile's local checks ────────────────────────────────────────────

export interface CompiledPreferences {
  rules: readonly { effect: string; kinds?: readonly string[] | null; senders?: readonly string[] | null; about?: string | null; unless?: string | null; cues?: readonly string[] | null; said: string; understood: string }[];
  notes: readonly { said: string; kind: string; text: string }[];
}

const trimTo = (s: string | null | undefined, max: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const NOTE_KINDS: ReadonlySet<string> = new Set(["unsupported", "conflict", "unclear", "safety"]);

/**
 * Plan 248 §2: only what holds against the user's own text is kept. A rule's words must be in the text; an address or a
 * domain only when the text writes it (a model can't invent one); kinds and effect from the closed sets; at least one
 * selector; cues only on a show. A rule that fails becomes an "unclear" note with its words, in `unclear`'s language.
 */
export function checkPreferences(compiled: CompiledPreferences, text: string, unclear: (said: string) => string): { rules: PreferenceRule[]; notes: PreferenceNote[] } {
  const flat = squash(text);
  const inText = (s: string) => {
    const w = squash(s).replace(/^["'“”«»]+|["'“”«».,;:!?]+$/gu, "");
    return w.length > 0 && flat.includes(w);
  };
  const rules: PreferenceRule[] = [];
  const notes: PreferenceNote[] = [];
  const seen = new Set<string>();
  const note = (n: PreferenceNote) => {
    if (notes.length < PREFERENCE_NOTES_MAX && !notes.some((o) => o.kind === n.kind && o.said === n.said)) notes.push(n);
  };
  for (const r of compiled.rules) {
    const said = trimTo(r.said, PREFERENCES_TEXT_MAX);
    const effect = r.effect.trim().toLowerCase();
    const fail = () => said && inText(said) && note({ said, kind: "unclear", text: unclear(said) });
    if (!said || !inText(said) || !PREFERENCE_EFFECTS.includes(effect as PreferenceEffect)) {
      fail();
      continue;
    }
    const kinds = [...new Set((r.kinds ?? []).map((k) => k.trim().toLowerCase()))];
    if (kinds.some((k) => !isPreferenceKind(k))) {
      fail();
      continue;
    }
    const senders: string[] = [];
    let invented = false;
    for (const raw of r.senders ?? []) {
      const s = senderSelector(raw);
      // the text must write it: its address, or its domain (with or without the @)
      if (!s || !flat.includes(s.startsWith("@") ? s.slice(1) : s)) invented = true;
      else if (!senders.includes(s)) senders.push(s);
    }
    if (invented || senders.length > PREFERENCE_SENDERS_MAX) {
      fail();
      continue;
    }
    const about = trimTo(r.about, PREFERENCE_CRITERION_CHARS) || null;
    const unless = trimTo(r.unless, PREFERENCE_CRITERION_CHARS) || null;
    if (!about && !kinds.length && !senders.length) {
      fail();
      continue;
    }
    const cues = effect === "show" ? [...new Set((r.cues ?? []).map((c) => trimTo(c, PREFERENCE_CUE_CHARS)).filter((c) => words(c).trim().length >= 2))].slice(0, PREFERENCE_CUES_MAX) : [];
    const rule: PreferenceRule = {
      id: `r${rules.length + 1}`,
      key: "",
      said,
      effect: effect as PreferenceEffect,
      ...(kinds.length ? { kinds: kinds as PreferenceKind[] } : {}),
      ...(senders.length ? { senders } : {}),
      ...(about ? { about } : {}),
      ...(unless ? { unless } : {}),
      ...(cues.length ? { cues } : {}),
      understood: trimTo(r.understood, PREFERENCE_UNDERSTOOD_CHARS) || said.slice(0, PREFERENCE_UNDERSTOOD_CHARS),
    };
    rule.key = ruleKey(rule);
    if (seen.has(rule.key)) continue;
    seen.add(rule.key);
    if (rules.length < PREFERENCE_RULES_MAX) rules.push(rule);
    else note({ said, kind: "unclear", text: unclear(said) });
  }
  for (const n of compiled.notes) {
    const kind = n.kind.trim().toLowerCase();
    const said = trimTo(n.said, PREFERENCES_TEXT_MAX);
    const words = trimTo(n.text, PREFERENCE_UNDERSTOOD_CHARS);
    if (NOTE_KINDS.has(kind) && words) note({ said: said && inText(said) ? said : "", kind: kind as PreferenceNoteKind, text: words });
  }
  return { rules, notes };
}

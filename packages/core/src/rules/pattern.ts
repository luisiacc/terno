/**
 * Plan 89: the `matches` op (a regular expression over a field's normalized
 * text) and the subject keys that let "Tu pedido 43790" and "Tu pedido 3052"
 * be one subject. Patterns run on a linear-time matcher (./regex), so no
 * pattern can stall the backend; one that doesn't parse is refused on save
 * and matches nothing.
 */
import { compileRegex, RegexError, type Regex, type RegexIssue } from "./regex";

/** A pattern holds at most this many characters (a rule value's cap). */
export const PATTERN_MAX = 500;

export type PatternIssue = RegexIssue | "length";

const MARKS = /[̀-ͯ]/g;
/** A pattern's accents fold like the text's; its case never does (`\D` stays `\D`): the matcher ignores case. */
export const foldPattern = (pattern: string) => pattern.normalize("NFKD").replace(MARKS, "");

/** Why a pattern can't be saved, or null. */
export function checkPattern(pattern: string): PatternIssue | null {
  if (pattern.length === 0 || pattern.length > PATTERN_MAX) return "length";
  try {
    compileRegex(foldPattern(pattern));
    return null;
  } catch (error) {
    if (error instanceof RegexError) return error.issue;
    throw error;
  }
}

const compiled = new Map<string, Regex | null>();
const CACHE_MAX = 64;

/** The compiled pattern (null when it fails the check), cached by source: an LRU of a few dozen. */
function compile(pattern: string): Regex | null {
  const hit = compiled.get(pattern);
  if (hit !== undefined) {
    compiled.delete(pattern);
    compiled.set(pattern, hit);
    return hit;
  }
  const re = checkPattern(pattern) === null ? compileRegex(foldPattern(pattern)) : null;
  compiled.set(pattern, re);
  if (compiled.size > CACHE_MAX) compiled.delete(compiled.keys().next().value as string);
  return re;
}

/** Does normalized `text` match `pattern`? A pattern that fails the check matches nothing. */
export function patternMatches(pattern: string, text: string): boolean {
  return compile(pattern)?.test(text) ?? false;
}

/** Runs of ASCII digits: what a subject key and pattern generalize. */
const DIGITS = /[0-9]+/g;
const NUMBER_PATTERN = "[0-9]+";

export const hasNumber = (text: string) => /[0-9]/.test(text);

/** The pattern that matches exactly the subjects with this one's key (`normalized` is normalizeText's output). */
export function subjectPattern(normalized: string): string {
  return `^${normalized.split(DIGITS).map(escape).join(NUMBER_PATTERN)}$`;
}

/** A subject with numbers whose pattern is a valid rule value: its scope generalizes them; any other stays exact. */
// through the compiled-pattern cache: a sweep asks once per message (Codex review)
export const subjectGeneralizes = (normalized: string): boolean => hasNumber(normalized) && compile(subjectPattern(normalized)) !== null;

/**
 * A normalized subject as a sweep compares it: with its numbers generalized
 * (when it generalizes), every number as `#` and a literal `#` or `\` escaped,
 * so two keys are equal exactly when the subjects match each other's pattern.
 */
export function subjectKey(normalized: string): string {
  return normalized.replace(/[\\#]/g, "\\$&").replace(DIGITS, "#");
}

/**
 * A GLOB every subject with this one's key matches (a superset: `[0-9]*` is a
 * digit, then anything): SQLite's cheap first test before the exact one.
 */
export function subjectGlob(normalized: string): string {
  return normalized.split(DIGITS).map((part) => part.replace(/[*?[]/g, "[$&]")).join("[0-9]*");
}

/** What a subject with this key must start and end with (the text around its numbers): JS's cheap first test. */
export function subjectEnds(normalized: string): { head: string; tail: string } {
  const parts = normalized.split(DIGITS);
  return { head: parts[0]!, tail: parts.length > 1 ? parts[parts.length - 1]! : "" };
}

// the syntax characters only: under the u flag any other escape (\-) is an error
const escape = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** What a subject reads as with its numbers generalized: "Tu pedido # está en camino". */
export function subjectTemplate(subject: string): string {
  return subject.replace(DIGITS, "#");
}

/** A pattern subjectPattern made, back as its template (null for a pattern someone wrote). */
export function patternTemplate(pattern: string): string | null {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return null;
  const parts = pattern.slice(1, -1).split(NUMBER_PATTERN);
  if (parts.length < 2) return null;
  const literal: string[] = [];
  for (const part of parts) {
    // only escapes of what escape() escapes, nothing else special
    if (/[\\^$.*+?()[\]{}|]/.test(part.replace(/\\[\\^$.*+?()[\]{}|/]/g, ""))) return null;
    literal.push(part.replace(/\\([\\^$.*+?()[\]{}|/])/g, "$1"));
  }
  return literal.join("#");
}

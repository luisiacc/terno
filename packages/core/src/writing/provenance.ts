import { countWords, normalizeGreeting, normalizeSignOff } from "./extract";

/**
 * Plan 133 §8: what was generated against what was sent. A content hash can't do this (signature and quotes get added,
 * HTML gets re-serialized), so both sides are compared here, as the words the author typed or kept, before any of that.
 */

/** The form both sides are stored and compared in: line endings, trailing space and blank runs don't count as editing. */
export function canonicalAuthored(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type CorrectionKind = "dropped-greeting" | "changed-greeting" | "dropped-sign-off" | "changed-sign-off" | "removed-exclamation" | "shorter" | "longer";

export interface Correction {
  kind: CorrectionKind;
  /** what it became, when that's part of the change */
  value?: string;
}

const LENGTH_CHANGE = 0.3;
const LENGTH_MIN_WORDS = 8;

/** What changed between a generated draft and what was sent, in the terms a voice can use. Never the mail's content. */
export function classifyEdit(generated: string, final: string): Correction[] {
  const out: Correction[] = [];
  const before = { greeting: normalizeGreeting(generated), signOff: normalizeSignOff(generated) };
  const after = { greeting: normalizeGreeting(final), signOff: normalizeSignOff(final) };
  if (before.greeting && !after.greeting) out.push({ kind: "dropped-greeting" });
  else if (after.greeting && before.greeting !== after.greeting) out.push({ kind: "changed-greeting", value: after.greeting });
  if (before.signOff && !after.signOff) out.push({ kind: "dropped-sign-off" });
  else if (after.signOff && before.signOff !== after.signOff) out.push({ kind: "changed-sign-off", value: after.signOff });
  if (/[!¡]/.test(generated) && !/[!¡]/.test(final)) out.push({ kind: "removed-exclamation" });
  const was = countWords(generated);
  const now = countWords(final);
  if (was >= LENGTH_MIN_WORDS) {
    if (now <= was * (1 - LENGTH_CHANGE)) out.push({ kind: "shorter" });
    else if (now >= was * (1 + LENGTH_CHANGE)) out.push({ kind: "longer" });
  }
  return out;
}

/** The same change, at least this often: one removed greeting means little (§8). */
export const CORRECTION_MIN = 3;
/** ...and at least once among the newest few, so guidance backs off when it stops recurring. */
const CORRECTION_RECENT = 6;

const correctionKey = (c: Correction) => `${c.kind}|${c.value ?? ""}`;

function correctionLine(c: Correction): string {
  switch (c.kind) {
    case "dropped-greeting":
      return "they remove the greeting";
    case "changed-greeting":
      return `they change the greeting to "${c.value}"`;
    case "dropped-sign-off":
      return "they remove the sign-off";
    case "changed-sign-off":
      return `they change the sign-off to "${c.value}"`;
    case "removed-exclamation":
      return "they remove exclamation marks";
    case "shorter":
      return "they cut it down by a third or more";
    case "longer":
      return "they add a third or more";
  }
}

/** Newest first. The changes that repeat, as lines for a voice block. */
export function repeatedCorrections(pairs: readonly { generated: string; final: string }[]): string[] {
  const seen = new Map<string, { correction: Correction; count: number; newest: number }>();
  pairs.forEach((pair, i) => {
    for (const correction of classifyEdit(pair.generated, pair.final)) {
      const key = correctionKey(correction);
      const entry = seen.get(key);
      if (entry) entry.count++;
      else seen.set(key, { correction, count: 1, newest: i });
    }
  });
  return [...seen.values()]
    .filter((e) => e.count >= CORRECTION_MIN && e.newest < CORRECTION_RECENT)
    .sort((a, b) => b.count - a.count || (correctionKey(a.correction) < correctionKey(b.correction) ? -1 : 1))
    .map((e) => `when editing drafts ${correctionLine(e.correction)} (${e.count} times)`);
}

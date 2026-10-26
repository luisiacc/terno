import { isValidEmail, parseAddressList, type Address } from "@terno/core";

/**
 * Recipient fields (plans 18 and 26): the address being typed at the caret,
 * pasted lists, and what a suggestion highlights. Pure (no DOM, no backend);
 * the chips themselves are recipient-field.ts.
 */

export interface TypedToken {
  /** [start, end) of the token in the field's text */
  start: number;
  end: number;
  /** what to look up: the token trimmed; empty when there's nothing to complete */
  query: string;
}

/** The token around the caret, between unquoted, unbracketed separators (as parseAddressList splits). */
export function tokenAt(text: string, caret: number): TypedToken {
  let start = 0;
  let end = text.length;
  let inQuotes = false;
  let inAngle = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && inQuotes) {
      i++;
      continue;
    }
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    else if ((ch === "," || ch === ";" || ch === "\n") && !inQuotes && !inAngle) {
      if (i < caret) start = i + 1;
      else {
        end = i;
        break;
      }
    }
  }
  const raw = text.slice(start, end);
  // a chosen recipient ("Ana <ana@x.io>") or nothing: nothing to complete
  const query = /[<>]/.test(raw) ? "" : raw.trim().slice(0, 320);
  return { start, end, query };
}

/** The addresses already in a field, lowercased. */
export function emailsIn(text: string): string[] {
  return parseAddressList(text)
    .map((a) => a.email.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/**
 * A pasted text that is a list of addresses (a separator, `mailto:`, more
 * than one address, or one written `Name <addr>`), parsed; null for anything
 * else (an ordinary paste). Entries that aren't addresses are kept (plan 32,
 * Codex review 8): "ana@x.com; bob@" is two recipients, Bob's to fix.
 */
export function pastedAddresses(pasted: string): Address[] | null {
  const text = pasted.replace(/mailto:/gi, "").trim();
  if (!text) return null;
  const many = /[,;\n]/.test(text) || (text.match(/@/g)?.length ?? 0) > 1 || /mailto:/i.test(pasted) || /<[^<>]+@[^<>]+>/.test(text);
  if (!many) return null;
  const list = parseAddressList(text);
  return list.some((a) => isValidEmail(a.email)) ? list : null;
}

/**
 * `text` split into runs, `match` on the runs where a word starts with one of
 * the query's words (case and diacritics ignored): the part of a suggestion
 * that answers what was typed.
 */
export function highlight(text: string, query: string, fold: (s: string) => string): { text: string; match: boolean }[] {
  const terms = fold(query)
    .split(/[\s,;<>"()'.+_@-]+/)
    .filter(Boolean);
  if (!terms.length || !text) return [{ text, match: false }];
  // folded text with, for each folded char, the original char it came from
  let folded = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]!);
    folded += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
  }
  const marked = new Uint8Array(text.length);
  for (let i = 0; i < folded.length; i++) {
    // word starts only: the beginning, or after anything that isn't a letter or digit
    if (i > 0 && /[\p{L}\p{N}]/u.test(folded[i - 1]!)) continue;
    for (const t of terms) {
      if (!folded.startsWith(t, i)) continue;
      const from = origin[i]!;
      const to = origin[Math.min(folded.length - 1, i + t.length - 1)]!;
      for (let k = from; k <= to; k++) marked[k] = 1;
    }
  }
  const runs: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const m = marked[i] === 1;
    const last = runs[runs.length - 1];
    if (last && last.match === m) last.text += text[i];
    else runs.push({ text: text[i]!, match: m });
  }
  return runs;
}

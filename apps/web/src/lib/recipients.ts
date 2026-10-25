import { formatAddress, formatAddressList, isValidEmail, parseAddressList, type Address } from "@terno/core";

/**
 * Recipient fields (plan 18): the address being typed at the caret, putting
 * a chosen suggestion in its place, and pasted lists. Pure (no DOM, no
 * backend), the field's text stays the draft's model.
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

/** The field with `a` in place of the token, a separator after it, and where the caret goes. */
export function acceptAt(text: string, token: TypedToken, a: Address): { text: string; caret: number } {
  let before = text.slice(0, token.start);
  if (before && !/\s$/.test(before)) before += " ";
  const after = text.slice(token.end).replace(/^\s*[,;]?\s*/, "");
  const inserted = `${formatAddress(a)}, `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** The addresses already in a field, lowercased. */
export function emailsIn(text: string): string[] {
  return parseAddressList(text)
    .map((a) => a.email.trim().toLowerCase())
    .filter((e) => e.includes("@"));
}

/**
 * A pasted text that is a list of addresses (a separator, `mailto:`, or more
 * than one address), parsed; null for anything else (an ordinary paste).
 */
export function pastedAddresses(pasted: string): Address[] | null {
  const text = pasted.replace(/mailto:/gi, "").trim();
  if (!text) return null;
  const many = /[,;\n]/.test(text) || (text.match(/@/g)?.length ?? 0) > 1 || /mailto:/i.test(pasted);
  if (!many) return null;
  const list = parseAddressList(text).filter((a) => isValidEmail(a.email));
  return list.length ? list : null;
}

/** The field with a pasted list in place of the selection, without addresses already in the draft. */
export function insertPasted(text: string, selStart: number, selEnd: number, list: readonly Address[], existing: Iterable<string>): { text: string; caret: number } {
  const seen = new Set([...existing].map((e) => e.toLowerCase()));
  const fresh: Address[] = [];
  for (const a of list) {
    const key = a.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(a);
  }
  let before = text.slice(0, selStart).replace(/\s+$/, "");
  if (before && !/[,;]$/.test(before)) before += ",";
  if (before) before += " ";
  const after = text.slice(selEnd).replace(/^\s*[,;]?\s*/, "");
  const inserted = fresh.length ? `${formatAddressList(fresh)}, ` : "";
  return { text: before + inserted + after, caret: before.length + inserted.length };
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

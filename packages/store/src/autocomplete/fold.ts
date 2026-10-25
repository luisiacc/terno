/**
 * Case- and diacritic-insensitive keys for autocomplete (plan 18): what is
 * typed and what is indexed go through the same function, so "jose" finds
 * "José" and "JOSÉ" finds "jose". CJK and Hangul are kept (NFC again after the
 * marks go), so a name typed in its own script matches.
 */
const ASCII = /^[ -~]*$/;
const MARKS = /\p{M}/gu;
const SPECIAL = /[ßæøœłđıþð]/g;
const SPECIAL_TO: Record<string, string> = { ß: "ss", æ: "ae", ø: "o", œ: "oe", ł: "l", đ: "d", ı: "i", þ: "th", ð: "d" };

export function fold(s: string): string {
  if (ASCII.test(s)) return s.toLowerCase();
  return s.normalize("NFKD").replace(MARKS, "").normalize("NFC").toLowerCase().replace(SPECIAL, (c) => SPECIAL_TO[c]!);
}

/** Han, kana and Hangul: names written without spaces, matched by their suffixes too. */
export const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

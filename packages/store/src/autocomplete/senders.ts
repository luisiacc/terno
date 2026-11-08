import { domainLabel, type ContactHit } from "./contacts";
import { fold } from "./fold";

const WORD = /[^\p{L}\p{N}&]+/u;
const words = (s: string): string[] => fold(s).split(WORD).filter(Boolean);
const ARTICLE = new Set(["the", "el", "la", "los", "las"]);

/**
 * Plan 161: how many of a phrase's words (from a sentence, after "from" or "de") name this sender. Their name and the
 * phrase agree word for word until one of them ends ("Uber" and "Uber Receipts", "Morning Brew team" and "Morning
 * Brew"; never "John Smith" and "John Doe"), or the phrase's first word is their domain's own label ("uber" of uber.com,
 * "netflix" of account.netflix.com; never a subdomain or the top level). 0: it doesn't. A word inside a name ("Brew" in
 * "Morning Brew") isn't one.
 */
export function namesSender(phrase: string, hit: ContactHit): number {
  const said = words(phrase);
  if (!said.length) return 0;
  // "The Browser" is named "Browser" too
  const name = words(hit.name).filter((w, i) => i > 0 || !ARTICLE.has(w));
  let n = 0;
  while (n < said.length && n < name.length && said[n] === name[n]) n++;
  if (n > 0 && (n === said.length || n === name.length)) return n;
  return said[0] === domainLabel(hit.email) ? 1 : 0;
}

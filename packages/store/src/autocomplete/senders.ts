import type { ContactHit } from "./contacts";
import { fold } from "./fold";

const WORD = /[^\p{L}\p{N}&]+/u;
const words = (s: string): string[] => fold(s).split(WORD).filter(Boolean);
const ARTICLE = new Set(["the", "el", "la", "los", "las"]);
/** a second level that's the registry's, not the sender's (mercadolibre.com.mx, bbc.co.uk) */
const REGISTRY = new Set(["co", "com", "net", "org", "gob", "gov", "edu", "ac"]);

/** The domain's own label: netflix of account.netflix.com, mercadolibre of mercadolibre.com.mx; never a subdomain's. */
function brand(email: string): string {
  const labels = fold(email.slice(email.lastIndexOf("@") + 1)).split(".").filter(Boolean);
  labels.pop();
  if (labels.length > 1 && REGISTRY.has(labels.at(-1)!)) labels.pop();
  return labels.at(-1) ?? "";
}

/**
 * Plan 161: how many of a phrase's words (from a sentence, after "from" or "de") name this sender: the start of their
 * name word for word ("Uber" in "Uber Receipts", "Mercado Libre"), or one word that's their domain's own label ("uber" of
 * uber.com, "netflix" of account.netflix.com; never a subdomain or the top level). 0: it doesn't. A word inside a name
 * ("Brew" in "Morning Brew") isn't one.
 */
export function namesSender(phrase: string, hit: ContactHit): number {
  const said = words(phrase);
  if (!said.length) return 0;
  // "The Browser" is named "Browser" too
  const name = words(hit.name).filter((w, i) => i > 0 || !ARTICLE.has(w));
  let n = 0;
  while (n < said.length && n < name.length && said[n] === name[n]) n++;
  if (n > 0) return n;
  return said[0] === brand(hit.email) ? 1 : 0;
}

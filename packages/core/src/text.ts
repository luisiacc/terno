/**
 * Canonical text normalization shared by the JS rule evaluator, the SQL rule
 * compiler (which stores pre-normalized columns) and the search parser.
 * NFKD + strip combining marks + lowercase, so "Canción" == "cancion".
 */
const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalizeText(value: string | null | undefined): string {
  if (!value) return "";
  return value.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Strip reply/forward prefixes (es/en/de/fr variants) for display and threading hints. */
const SUBJECT_PREFIX = /^\s*((re|fw|fwd|rv|reenv|aw|wg|tr|sv)(\[\d+\])?\s*:\s*)+/i;

export function baseSubject(subject: string): string {
  return subject.replace(SUBJECT_PREFIX, "").trim();
}

/** a line that introduces a quote: only a quote if `>` lines follow it */
export const ATTRIBUTION = /^(on\b.{0,300}\bwrote:?|el\b.{0,300}\bescribi[oó]:?|le\b.{0,300}\ba [ée]crit\s?:?|am\b.{0,300}\bschrieb.{0,100}:)$/i;
/** everything after one of these is someone else's mail, quoted without `>` */
export const QUOTED_BLOCK = /^(-{2,}\s*(original message|mensaje original|forwarded message|mensaje reenviado|message d'origine)\s*-{2,}|_{8,})$/i;
export const OUTLOOK_FROM = /^(from|de|von|da):\s.*(@|\[mailto).*$/i;
export const OUTLOOK_NEXT = /^(sent|enviado|date|fecha|to|para|subject|asunto):\s/i;

/**
 * The reader's own words: what they quote from earlier is in those earlier messages. An answer written between quoted
 * lines is theirs (plan 151): an attribution ends the mail only when no `>` follows it, as in an unmarked quote.
 */
export function withoutQuotes(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith(">")) continue;
    if (ATTRIBUTION.test(l)) {
      let next = i + 1;
      while (next < lines.length && lines[next]!.trim() === "") next++;
      if (next >= lines.length || !lines[next]!.trim().startsWith(">")) break;
      continue;
    }
    if (QUOTED_BLOCK.test(l) || (OUTLOOK_FROM.test(l) && OUTLOOK_NEXT.test(lines[i + 1]?.trim() ?? ""))) break;
    kept.push(lines[i]!);
  }
  return kept.join("\n").trim();
}

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

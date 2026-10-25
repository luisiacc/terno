/**
 * The second line of defence: every free-form string that is kept at all
 * (a local log line, an error message in the user's own export) goes through
 * here. Remote reports carry no free text in the first place (report.ts).
 * Subjects and names have no signature a regex can find, which is why they
 * are kept out by construction and this only catches what has a shape.
 */

const opaque = (m: string) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "<blob>" : m);

const RULES: [RegExp, string | ((m: string) => string)][] = [
  // PEM blocks and JWTs before anything that could cut them up
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "<key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "<jwt>"],
  // credentials in headers, IMAP/SMTP commands and key=value pairs
  [/\b(authorization|proxy-authorization)\s*[:=]\s*\S+(?:\s+\S+)?/gi, "$1: <token>"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 <token>"],
  [/\b(LOGIN)\s+("[^"]*"|\S+)\s+("[^"]*"|\S+)/gi, "$1 <user> <secret>"],
  [/\b(AUTHENTICATE\s+\S+)\s+\S+/gi, "$1 <secret>"],
  [/\b(AUTH\s+(?:PLAIN|LOGIN|XOAUTH2))\s+\S+/gi, "$1 <secret>"],
  [/\b(access_token|refresh_token|id_token|client_secret|api[_-]?key|apikey|password|passwd|pwd|secret|token|code|key)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, "$1$2<redacted>"],
  // provider key shapes
  [/\b(sk-ant-|sk-proj-|sk-|xai-|gsk_|AIza|ya29\.|1\/\/)[A-Za-z0-9._-]{8,}/g, "<key>"],
  // URLs: keep scheme and host, drop user info, path tail and query
  [/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+@)?([^\s/?#:]+)(?::\d+)?[^\s"'<>)]*/gi, "$1$2/…"],
  // file paths name files and the account: a quoted absolute path goes whole, a home path to the line's end
  [/(["'`])(?:[A-Za-z]:)?[/\\][^"'`\n]*\1/g, "$1<path>$1"],
  [/(\/Users\/|\/home\/|\/Volumes\/|[A-Za-z]:\\Users\\)[^"'`\n]*/g, "$1<path>"],
  // a display name before an address ("Ana López <ana@…>"), then Message-IDs, then addresses
  [/(?:"[^"\n]{0,80}"|[\p{L}][\p{L}\p{M}.' -]{0,60}?)\s*<[^<>\s@]+@[^<>\s]+>/gu, "<name> <email>"],
  [/<[^<>\s]{6,}@[^<>\s]+>/g, "<msgid>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "<email>"],
  // long opaque runs: base64, hex digests, message ids
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, opaque],
];

/** At most this many characters survive (the rest is cut, marked with its length). */
export const SCRUB_MAX = 500;

export function scrubText(input: unknown, max = SCRUB_MAX): string {
  let s = typeof input === "string" ? input : input instanceof Error ? input.message : String(input);
  for (const [re, to] of RULES) s = s.replace(re, to as string);
  // controls (incl. newlines that could forge a JSONL line) become spaces
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what must go
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max})` : s;
}

/** A deep copy in which every string went through scrubText (keys are kept: they are code). */
export function scrubDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubText(value, 2000) as T;
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, depth + 1);
  return out as T;
}

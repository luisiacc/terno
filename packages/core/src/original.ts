import { decodeEncodedWords } from "./encoded-words";

/**
 * Plan 272: what Show original says of a message's source as its server holds it. Read from a bounded prefix only, so a
 * 75 MB message costs what a small one does; the whole source is downloaded, never shown.
 */

/** The header block shown, at most (cut there if the blank line after it hasn't come) */
export const ORIGINAL_HEADERS_MAX = 256 * 1024;
/** The source shown, at most (cut at the last line break before it) */
export const ORIGINAL_SOURCE_MAX = 1024 * 1024;
/** One summary value, at most */
export const ORIGINAL_VALUE_MAX = 2000;
/** One piece of a download */
export const ORIGINAL_PIECE = 512 * 1024;
/** The HTML shown, at most (UTF-16 code units) */
export const ORIGINAL_HTML_MAX = 2_000_000;

/** A verdict as a report states it: never checked here, only shown with who reported it */
export interface AuthVerdict {
  /** the method's result as written, lower case (pass, fail, softfail, none …) */
  result: string;
  /** what it was about: the domain or address the report names (smtp.mailfrom, header.d/header.i, header.from) */
  about?: string;
}

export interface OriginalSummary {
  messageId?: string;
  date?: { text: string; time: number | null };
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  deliveredTo?: string;
  /** the topmost Authentication-Results: the last server to add one, named by its authserv-id */
  auth?: { reporter: string; spf?: AuthVerdict; dkim?: AuthVerdict; dmarc?: AuthVerdict };
}

export interface OriginalView {
  /** the source's size in bytes */
  size: number;
  /** the header block as written */
  headers: string;
  /** the header block is longer than shown */
  headersCut: boolean;
  /** the source's start as text */
  source: string;
  /** the source is longer than shown */
  sourceCut: boolean;
  summary: OriginalSummary;
}

const decoder = () => new TextDecoder("utf-8", { fatal: false });

/** Where the header block ends (the blank line's start), within `max` bytes; -1 if it doesn't */
function headerEnd(bytes: Uint8Array, max: number): number {
  const end = Math.min(bytes.length, max);
  for (let i = 0; i < end; i++) {
    if (bytes[i] !== 0x0a) continue;
    if (bytes[i + 1] === 0x0a) return i + 1;
    if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) return i + 1;
  }
  // a message that is nothing but headers ends without the blank line
  return bytes.length <= max ? bytes.length : -1;
}

/** The headers' fields, unfolded, in order (names lower case) */
export function originalFields(headers: string): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  for (const line of headers.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      const last = fields.at(-1);
      if (last) last.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return fields;
}

/** A header value without its (nested) comments */
function uncommented(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\" && (quoted || depth)) { if (!depth) out += c + (value[i + 1] ?? ""); i++; continue; }
    if (c === "\"" && !depth) quoted = !quoted;
    if (!quoted && c === "(") { depth++; continue; }
    if (!quoted && c === ")" && depth) { depth--; continue; }
    if (!depth) out += c;
  }
  return out;
}

const METHODS = ["spf", "dkim", "dmarc"] as const;
const ABOUT: Record<(typeof METHODS)[number], readonly string[]> = { spf: ["smtp.mailfrom", "smtp.helo"], dkim: ["header.d", "header.i"], dmarc: ["header.from"] };

/** RFC 8601: `authserv-id; method=result prop=value …; …`. Of several results for one method, a pass, else the first. */
export function authenticationResults(value: string): OriginalSummary["auth"] | undefined {
  const [head, ...results] = uncommented(value).split(";").map((s) => s.trim());
  const reporter = head?.split(/\s+/)[0];
  if (!reporter || reporter.includes("=")) return undefined;
  const auth: NonNullable<OriginalSummary["auth"]> = { reporter: cap(reporter) };
  for (const result of results) {
    const tokens = result.split(/\s+/).filter(Boolean);
    const [method, verdict] = (tokens[0] ?? "").split("=").map((s) => s.trim().toLowerCase());
    if (!verdict || !(METHODS as readonly string[]).includes(method!)) continue;
    const m = method as (typeof METHODS)[number];
    const props = new Map(tokens.slice(1).map((t) => t.split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => [k!.toLowerCase(), v.join("=").replace(/^"|"$/g, "")]));
    const about = ABOUT[m].map((k) => props.get(k)).find(Boolean);
    const found: AuthVerdict = { result: verdict.slice(0, 40), ...(about && { about: cap(about.replace(/^@/, "")) }) };
    if (!auth[m] || (auth[m].result !== "pass" && found.result === "pass")) auth[m] = found;
  }
  return auth;
}

const cap = (s: string) => (s.length > ORIGINAL_VALUE_MAX ? `${s.slice(0, ORIGINAL_VALUE_MAX)}…` : s);

/** The summary Gmail shows over a message's original, from its header block */
export function originalSummary(headers: string): OriginalSummary {
  const fields = originalFields(headers);
  const first = (name: string) => fields.find((f) => f.name === name)?.value;
  const text = (name: string) => {
    const value = first(name);
    return value === undefined || !value.trim() ? undefined : cap(decodeEncodedWords(value).trim());
  };
  const summary: OriginalSummary = {};
  const id = first("message-id")?.trim();
  if (id) summary.messageId = cap(id.replace(/^<|>$/g, ""));
  const date = first("date")?.trim();
  if (date) {
    const time = Date.parse(date);
    summary.date = { text: cap(date), time: Number.isNaN(time) ? null : time };
  }
  for (const [key, name] of [["from", "from"], ["to", "to"], ["cc", "cc"], ["subject", "subject"], ["deliveredTo", "delivered-to"]] as const) {
    const value = text(name);
    if (value !== undefined) summary[key] = value;
  }
  const auth = first("authentication-results");
  const read = auth === undefined ? undefined : authenticationResults(auth);
  if (read && (read.spf || read.dkim || read.dmarc)) summary.auth = read;
  return summary;
}

/** What Show original shows of these bytes: their header block, their start as text and the summary. */
export function describeOriginal(bytes: Uint8Array): OriginalView {
  const end = headerEnd(bytes, ORIGINAL_HEADERS_MAX);
  const headersCut = end < 0;
  const headers = decoder().decode(bytes.subarray(0, headersCut ? ORIGINAL_HEADERS_MAX : end)).replace(/\r?\n$/, "");
  const sourceCut = bytes.length > ORIGINAL_SOURCE_MAX;
  let cut = bytes.length;
  if (sourceCut) {
    cut = bytes.lastIndexOf(0x0a, ORIGINAL_SOURCE_MAX - 1) + 1;
    if (cut <= 0) cut = ORIGINAL_SOURCE_MAX;
  }
  // a header block cut short may end inside a folded field: that field's start still reads
  const summary = originalSummary(headersCut ? headers.slice(0, headers.lastIndexOf("\n") + 1 || undefined) : headers);
  return { size: bytes.length, headers, headersCut, source: decoder().decode(bytes.subarray(0, cut)), sourceCut, summary };
}

/** Why a message's original isn't shown when nothing went wrong: there's no source to read */
export type OriginalUnavailable = "local" | "gone" | "signin" | "unsupported";
/** `reader.original`'s answer: the view and how many pieces its download is, or why there's none */
export type OriginalResult = (OriginalView & { pieces: number }) | { unavailable: OriginalUnavailable };

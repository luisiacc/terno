import { tokenize, type TextOp } from "@terno/core";

/** A storage/transfer unit, never a limit on a message's complete content. */
export const BODY_PART_UNITS = 32768;

export interface BodyPartSource {
  read(after: number): Promise<{ ordinal: number; value: Uint8Array } | null>;
  close?(): void;
}

/** UTF-16LE preserves code units, including a surrogate split between parts. */
export function encodeBodyPart(text: string): Uint8Array {
  if (text.length > BODY_PART_UNITS) throw new RangeError("Body part exceeds its storage unit");
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes[i * 2] = c & 255; bytes[i * 2 + 1] = c >>> 8; }
  return bytes;
}

export function decodeBodyPart(bytes: Uint8Array): string {
  if (bytes.byteLength % 2 || bytes.byteLength > BODY_PART_UNITS * 2) throw new Error("Invalid body part");
  const units = new Uint16Array(bytes.byteLength / 2);
  for (let i = 0; i < units.length; i++) units[i] = bytes[i * 2]! | bytes[i * 2 + 1]! << 8;
  return String.fromCharCode(...units);
}

/** Caller controls physical reads/yields; no read collects the remaining parts. */
export async function* bodyPartText(source: BodyPartSource): AsyncGenerator<string> {
  let ordinal = -1;
  try {
    for (;;) {
      let next = await source.read(ordinal);
      if (!next) return;
      if (next.ordinal !== ordinal + 1) throw new Error("Incomplete body parts");
      ordinal = next.ordinal;
      const text = decodeBodyPart(next.value);
      next = null;
      yield text;
    }
  } finally { source.close?.(); }
}

/** Exact code-unit assembly for legacy string consumers; no whole-string join/normalization. */
export async function assembleBody(source: BodyPartSource): Promise<string> {
  const levels: (string | undefined)[] = [];
  for await (let text of bodyPartText(source)) {
    let level = 0;
    while (levels[level] !== undefined) { text = levels[level]! + text; levels[level] = undefined; level++; }
    levels[level] = text;
  }
  let text = "";
  for (let level = levels.length - 1; level >= 0; level--) if (levels[level] !== undefined) text += levels[level];
  return text;
}

/**
 * Prepared token parts contain NUL-delimited normalized tokens. Matching is
 * incremental even when a single token spans every part in the message.
 */
export async function matchBodyParts(source: BodyPartSource, op: TextOp, value: string, prefix = false): Promise<boolean> {
  if (op === "matches") return false;
  const tokens = tokenize(value);
  if (!tokens.length) return false;
  const pattern = `\0${tokens.join("\0")}${prefix ? "" : "\0"}`;
  const failure = new Uint32Array(pattern.length);
  for (let i = 1, j = 0; i < pattern.length; i++) {
    while (j && pattern[i] !== pattern[j]) j = failure[j - 1]!;
    if (pattern[i] === pattern[j]) j++;
    failure[i] = j;
  }
  let matched = 0, at = 0, found = false, matchStart = -1, matchEnd = -1;
  for await (const part of bodyPartText(source)) {
    for (let i = 0; i < part.length; i++, at++) {
      while (matched && part[i] !== pattern[matched]) matched = failure[matched - 1]!;
      if (part[i] === pattern[matched]) matched++;
      if (matched === pattern.length) {
        matchStart = at + 1 - pattern.length; matchEnd = at + 1;
        if (op === "contains" || (op === "startsWith" && matchStart === 0)) return true;
        found ||= matchStart === 0;
        matched = failure[matched - 1]!;
      }
    }
  }
  return op === "equals" ? found && matchStart === 0 && matchEnd === at : op === "endsWith" && matchEnd === at;
}

/** Produces one exact persistence unit at a time, also for a token longer than a unit. */
export async function* bodyPartWrites(text: string | null, html: string | null, tokens: Iterable<string> | readonly Uint16Array[] | AsyncIterable<Uint16Array>, parts?: import("@terno/core").ExactBodyParts): AsyncGenerator<{ field: number; ordinal: number; value: Uint8Array }> {
  for (const [field, content] of [text, html].entries()) {
    const exact = field === 0 ? parts?.text : parts?.html;
    if (exact) { for (const [ordinal, part] of exact.entries()) yield { field, ordinal, value: encodeBodyPart(part) }; continue; }
    if (content === null) continue;
    for (let start = 0, ordinal = 0; start < content.length; start += BODY_PART_UNITS, ordinal++) yield { field, ordinal, value: encodeBodyPart(content.slice(start, start + BODY_PART_UNITS)) };
  }
  let ordinal = 0;
  if (Array.isArray(tokens) || Symbol.asyncIterator in tokens) {
    for await (const units of tokens as readonly Uint16Array[] | AsyncIterable<Uint16Array>) yield { field: 2, ordinal: ordinal++, value: encodeBodyPart(String.fromCharCode(...units)) };
  } else {
    let part = "\0";
    for (const token of tokens as Iterable<string>) {
      for (let start = 0; start <= token.length;) {
        const piece = start === token.length ? "\0" : token.slice(start, start + BODY_PART_UNITS - part.length);
        part += piece; start += piece === "\0" ? 1 : piece.length;
        if (part.length === BODY_PART_UNITS) { yield { field: 2, ordinal: ordinal++, value: encodeBodyPart(part) }; part = ""; }
      }
    }
    if (part) yield { field: 2, ordinal, value: encodeBodyPart(part) };
  }
}

export type BodyTest = { op: TextOp; value: string; prefix?: boolean };
export const bodyTestKey = (op: TextOp, value: string, prefix = false): string => JSON.stringify([op, value, prefix]);
export type BodyTestResults = Map<string, Map<string, boolean>>;

/** The existing unquoted 200-unit snippet, scanning even whitespace/quoted runs in bounded turns. */
export async function prepareBodySnippet(text: string | null | undefined, yieldTo: () => Promise<void>, parts?: readonly string[]): Promise<string> {
  if (!text && !parts?.length) return "";
  let result = "", line: "leading" | "quoted" | "text" = "leading", accepted = false, leadingSpace = false;
  const append = (character: string): boolean => {
    if (/\s/.test(character)) { if (result && !result.endsWith(" ")) result += " "; }
    else result += character;
    return result.length > 200;
  };
  const chunks = parts ?? (function* () { for (let start = 0; start < (text?.length ?? 0); start += BODY_PART_UNITS) yield text!.slice(start, start + BODY_PART_UNITS); })();
  for (const chunk of chunks) {
    for (let at = 0; at < chunk.length; at++) {
      const c = chunk[at]!;
      if (c === "\n") {
        if (line === "leading") { if (accepted && append(" ")) return `${result.slice(0, 199)}…`; accepted = true; }
        line = "leading"; leadingSpace = false; continue;
      }
      if (line === "quoted") continue;
      if (line === "leading") {
        if (/\s/.test(c)) { leadingSpace = true; continue; }
        if (c === ">") { line = "quoted"; continue; }
        if ((accepted || leadingSpace) && append(" ")) return `${result.slice(0, 199)}…`;
        accepted = true; line = "text";
      }
      if (append(c)) return `${result.slice(0, 199)}…`;
    }
    await yieldTo();
  }
  if (line === "leading" && accepted && append(" ")) return `${result.slice(0, 199)}…`;
  return result.trim();
}

/** Existing bounded sent-text projection; SQL counts code points, IDB code units. */
export async function bodyPrefix(source: BodyPartSource, limit: number, codePoints = false): Promise<string> {
  let result = "", count = 0, high = "";
  for await (let part of bodyPartText(source)) {
    if (!codePoints) { result += part.slice(0, limit - result.length); if (result.length >= limit) return result; continue; }
    part = high + part; high = "";
    if (part.length && /[\uD800-\uDBFF]/.test(part[part.length - 1]!)) { high = part.slice(-1); part = part.slice(0, -1); }
    for (const character of part) { result += character; if (++count === limit) return result; }
  }
  return high && count < limit ? result + high : result;
}

/** Capture references are private acknowledgements, never incoming message input. */
export function validateBodyInput(message: { bodyText: string | null; bodyHtml: string | null; bodyParts?: import("@terno/core").ExactBodyParts; bodyCapture?: unknown; preparedBodyTokens?: readonly Uint16Array[] }): void {
  if (message.bodyCapture !== undefined) throw new Error("Incoming body cannot adopt a stored capture");
  for (const field of ["text", "html"] as const) {
    const parts = message.bodyParts?.[field];
    if (!parts) continue;
    if ((field === "text" ? message.bodyText : message.bodyHtml) !== null || parts.some((part) => typeof part !== "string" || part.length > BODY_PART_UNITS)) throw new Error("Ambiguous or invalid exact body parts");
  }
  for (const part of message.preparedBodyTokens ?? []) if (!(part instanceof Uint16Array) || !(part.buffer instanceof ArrayBuffer) || part.byteOffset || !part.length || part.length > BODY_PART_UNITS || part.byteLength !== part.buffer.byteLength) throw new Error("Invalid prepared body ownership");
}

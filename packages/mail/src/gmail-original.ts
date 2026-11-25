import { MAX_INCOMING_MIME_BYTES } from "@terno/core";
import { IncomingProcessingError } from "./incoming-processing";

/** Bytes either side of the source in Gmail's answer (`{ "id": …, "raw": … }`), at most */
const FRAME_MAX = 4096;
/** Source characters decoded between turns of the event loop */
const SLICE_CHARS = 256 * 1024;
const QUOTE = 0x22;

const isBase64url = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x5f;

/**
 * Plan 272: the message source in Gmail's `format=raw&fields=id,raw` answer, read straight from its bytes a slice at a
 * time (the backend's turn between slices), never as one JSON.parse of a string of up to 100 MB. base64url carries no
 * escapes, so the `raw` value is the bytes between its quotes; the rest of the answer, with that value emptied, must
 * parse as JSON to exactly `{ id: expectedId, raw: "" }`, so a malformed answer is never read as a message.
 */
export async function decodeGmailRaw(chunks: readonly Uint8Array[], expectedId: string, turn: () => Promise<void>, limit = MAX_INCOMING_MIME_BYTES): Promise<Uint8Array> {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(Math.min(Math.floor((total * 3) / 4) + 3, limit + 3));
  let written = 0;
  let state: "before" | "value" | "after" = "before";
  const before: number[] = [];
  const after: number[] = [];
  /** base64url characters not yet decoded (fewer than 4 between slices) */
  let pending = "";
  let padding = 0;
  let sinceTurn = 0;
  const flush = (final: boolean) => {
    const usable = final ? pending.length : pending.length - (pending.length % 4);
    if (!usable) return;
    if (final && usable % 4 === 1) throw new IncomingProcessingError("malformed-base64");
    const text = pending.slice(0, usable);
    pending = pending.slice(usable);
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
    // the message's own bound, not only the answer's (its JSON allowance is larger: Codex code review #12)
    if (written + binary.length > limit) throw new IncomingProcessingError("input-limit");
    for (let i = 0; i < binary.length; i++) out[written++] = binary.charCodeAt(i);
  };
  for (const chunk of chunks) {
    let i = 0;
    while (i < chunk.byteLength) {
      if (state === "before") {
        const b = chunk[i++]!;
        before.push(b);
        if (before.length > FRAME_MAX) throw new IncomingProcessingError("malformed-resource");
        if (b === QUOTE && /"raw"\s*:\s*"$/.test(String.fromCharCode(...before.slice(-16)))) state = "value";
        continue;
      }
      if (state === "after") {
        after.push(chunk[i++]!);
        if (after.length > FRAME_MAX) throw new IncomingProcessingError("malformed-resource");
        continue;
      }
      // the value: base64url up to its closing quote (`=` padding only at its end)
      let end = i;
      while (end < chunk.byteLength && isBase64url(chunk[end]!) && !padding) end++;
      if (end > i) {
        pending += String.fromCharCode(...chunk.subarray(i, Math.min(end, i + 8192)));
        const taken = Math.min(end, i + 8192) - i;
        i += taken;
        sinceTurn += taken;
        if (pending.length >= 65536) flush(false);
        if (sinceTurn >= SLICE_CHARS) { sinceTurn = 0; await turn(); }
        continue;
      }
      const b = chunk[i++]!;
      if (b === 0x3d && padding < 2) { padding++; continue; }
      if (b !== QUOTE) throw new IncomingProcessingError("malformed-base64");
      if (padding && (pending.length + padding) % 4) throw new IncomingProcessingError("malformed-base64");
      flush(true);
      state = "after";
      after.push(QUOTE);
    }
  }
  if (state !== "after" || !written) throw new IncomingProcessingError("malformed-resource");
  let frame: unknown;
  try { frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([...before, ...after]))); }
  catch { throw new IncomingProcessingError("malformed-json"); }
  const keys = frame && typeof frame === "object" && !Array.isArray(frame) ? Object.keys(frame) : [];
  if (keys.length !== 2 || (frame as { id?: unknown }).id !== expectedId || (frame as { raw?: unknown }).raw !== "") throw new IncomingProcessingError("malformed-resource");
  return out.subarray(0, written);
}

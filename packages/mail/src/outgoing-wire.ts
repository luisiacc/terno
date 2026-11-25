import { checkMimeSize, yieldPreparation } from "./attachment-payload";

/** Reusable BodyInit: Blob parts preserve bounded encoding work without streaming-upload requirements. */
export async function gmailSendBody(raw: Uint8Array, threadId: string | null): Promise<string | Blob> {
  checkMimeSize(raw.byteLength);
  const suffix = threadId == null ? '"}' : `",${JSON.stringify({ threadId }).slice(1)}`;
  const encode = (bytes: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  if (raw.length <= 24576) return '{"raw":"' + encode(raw) + suffix;
  const parts: Blob[] = [new Blob(['{"raw":"'])];
  // Divisible by three: only the final chunk has padding to remove.
  for (let i = 0; i < raw.length; i += 24576) {
    parts.push(new Blob([encode(raw.subarray(i, i + 24576))]));
    await yieldPreparation();
  }
  parts.push(new Blob([suffix]));
  return new Blob(parts, { type: "application/json" });
}

/**
 * Plan 259: a MIME message as Graph takes one (sendMail, a draft): the bytes in base64 as a `text/plain` body
 * (learn.microsoft.com/graph/api/user-sendmail). Encoded a piece at a time, yielding between.
 */
export async function graphMimeBody(raw: Uint8Array): Promise<Blob> {
  checkMimeSize(raw.byteLength);
  const parts: string[] = [];
  // divisible by three: only the last piece is padded
  for (let i = 0; i < raw.length; i += 24576) {
    const bytes = raw.subarray(i, i + 24576);
    let binary = "";
    for (let j = 0; j < bytes.length; j += 8192) binary += String.fromCharCode(...bytes.subarray(j, j + 8192));
    parts.push(btoa(binary));
    if (i + 24576 < raw.length) await yieldPreparation();
  }
  return new Blob(parts, { type: "text/plain" });
}

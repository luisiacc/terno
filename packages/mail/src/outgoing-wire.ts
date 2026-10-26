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

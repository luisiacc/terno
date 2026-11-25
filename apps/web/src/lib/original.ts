import { ORIGINAL_PIECE, type OriginalResult } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { saveBlob } from "./attachments";

/**
 * Plan 272: one reading of a message's original. The backend keeps its bytes for the download under this id until
 * `close` (the view went), so a reading is closed exactly once, whatever it came to.
 */
export function readOriginal(threadId: number, messageId: number): { result: Promise<OriginalResult>; requestId: string; close(): void } {
  const requestId = crypto.randomUUID();
  let closed = false;
  return {
    requestId,
    result: client.call("reader.original", { threadId, messageId, requestId }),
    close() {
      if (closed) return;
      closed = true;
      void client.call("reader.originalClose", { requestId }).catch(() => {});
    },
  };
}

/** A piece's bytes: a plain decode, a few ms for a piece (base64Bytes' canonical check re-encodes it) */
function pieceBytes(dataBase64: string): Uint8Array<ArrayBuffer> {
  if (dataBase64.length > Math.ceil(ORIGINAL_PIECE / 3) * 4) throw new Error(t("reader.original.downloadFailed"));
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The original's bytes, a piece at a time; `expired` when the backend let them go meanwhile */
async function originalBlob(requestId: string, size: number, signal: AbortSignal): Promise<Blob | "expired"> {
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (let index = 0; got < size; index++) {
    signal.throwIfAborted();
    let dataBase64: string;
    try {
      ({ dataBase64 } = await client.call("reader.originalPiece", { requestId, index }));
    } catch (error) {
      if (error instanceof RpcError && error.code === "NOT_FOUND") return "expired";
      throw error;
    }
    const bytes = pieceBytes(dataBase64);
    if (!bytes.length || got + bytes.length > size) throw new Error(t("reader.original.downloadFailed"));
    pieces.push(bytes);
    got += bytes.length;
  }
  return new Blob(pieces, { type: "message/rfc822" });
}

/**
 * Saves the original as `filename`. Kept bytes let go meanwhile (two minutes untouched): the original is read again
 * from the server and saved from the start, never stitched from two readings. `signal`: the view went, so nothing is
 * read again or saved (false).
 */
export async function downloadOriginal(reading: { requestId: string; size: number }, again: () => Promise<{ requestId: string; size: number } | null>, filename: string, signal: AbortSignal): Promise<boolean> {
  let blob = await originalBlob(reading.requestId, reading.size, signal);
  if (blob === "expired" && !signal.aborted) {
    const fresh = await again();
    blob = fresh ? await originalBlob(fresh.requestId, fresh.size, signal) : "expired";
  }
  if (signal.aborted) return false;
  if (blob === "expired") throw new Error(t("errors.original.expired"));
  saveBlob(blob, filename);
  return true;
}

import { ResponseBodyLimitError, untilAborted } from "./http-body";

const CHUNK_BYTES = 65536;
const PREFIX_BYTES = 256 * 1024;
const SOURCE_BYTES = 1024 * 1024;
const MAX_CHUNKS = 4096;

export interface IncomingBody {
  readonly chunks: Uint8Array[];
  readonly bytes: number;
  readonly promoted: boolean;
  promote(): Promise<void>;
  release(): void;
}

/** Own exact buffers before transfer; never keep pulling while waiting for promotion. */
export async function readIncomingBody(response: Response, options: { signal: AbortSignal; limit: number; promote(signal: AbortSignal): Promise<() => void> }): Promise<IncomingBody> {
  const { signal, limit } = options;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Invalid incoming response limit");
  const reader = response.body?.getReader();
  if (!reader) { signal.throwIfAborted(); throw new SyntaxError("Missing response body"); }
  const chunks: Uint8Array[] = [];
  let buffer = new Uint8Array(CHUNK_BYTES);
  let filled = 0, bytes = 0, reads = 0, copied = 0;
  let complete = false, released = false, wasPromoted = false;
  let largeRelease: (() => void) | undefined;
  let promoting: Promise<void> | undefined;
  let promotionAbort: AbortController | undefined;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const canceled = () => new DOMException("Incoming processing canceled", "AbortError");
  const release = () => {
    if (released) return;
    released = true;
    promotionAbort?.abort(canceled());
    chunks.length = 0;
    buffer = new Uint8Array();
    largeRelease?.();
    largeRelease = undefined;
  };
  const promote = (): Promise<void> => {
    if (released) return Promise.reject(canceled());
    if (signal.aborted) return Promise.reject(signal.reason);
    if (promoting) return promoting;
    const abort = new AbortController();
    promotionAbort = abort;
    const stop = () => abort.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    try {
      promoting = untilAborted(options.promote(abort.signal).then((owned) => {
        if (released || signal.aborted) { owned(); throw released ? canceled() : signal.reason; }
        largeRelease = owned;
        wasPromoted = true;
      }), abort.signal).finally(() => signal.removeEventListener("abort", stop));
    } catch (error) { signal.removeEventListener("abort", stop); promoting = Promise.reject(error); }
    return promoting;
  };
  const append = (value: Uint8Array) => {
    if (chunks.length >= MAX_CHUNKS) throw new ResponseBodyLimitError(MAX_CHUNKS * CHUNK_BYTES);
    chunks.push(value);
  };
  const yieldTo = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
    copied = 0;
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      const value = next.value;
      if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) throw new SyntaxError("Invalid incoming response chunk");
      if (value.byteLength > SOURCE_BYTES || value.buffer.byteLength > SOURCE_BYTES) throw new ResponseBodyLimitError(SOURCE_BYTES);
      bytes += value.byteLength;
      if (bytes > limit) throw new ResponseBodyLimitError(limit);
      if (bytes > PREFIX_BYTES) await promote();
      for (let offset = 0; offset < value.byteLength;) {
        const count = Math.min(buffer.length - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        copied += count;
        if (filled === CHUNK_BYTES) { append(buffer); buffer = new Uint8Array(CHUNK_BYTES); filled = 0; }
        if (copied >= PREFIX_BYTES) await yieldTo();
      }
      if (++reads % 128 === 0) await yieldTo();
    }
    if (filled) append(buffer.slice(0, filled));
    buffer = new Uint8Array();
    complete = true;
    return { chunks, bytes, get promoted() { return wasPromoted; }, promote, release };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) { cancel(); release(); }
    reader.releaseLock();
  }
}

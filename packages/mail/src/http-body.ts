export class ResponseBodyLimitError extends Error {
  constructor(readonly limit: number) {
    super("Response exceeds the local byte limit");
    this.name = "ResponseBodyLimitError";
  }
}

export async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      stop = () => reject(signal.reason);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    })]);
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
  }
}

export function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Small control/error bodies only; large mail processing needs separate admission. */
export async function readResponseText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    signal.throwIfAborted();
    throw new SyntaxError("Missing response body");
  }
  // Native reader cancellation settles a pending read before awaiting the source's cancel promise.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  let overflow: ResponseBodyLimitError | undefined;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    const buffer = new Uint8Array(Math.min(limit, 16_384));
    let filled = 0;
    let bytes = 0, chunks = 0;
    const decode = (value?: Uint8Array, stream = false) => {
      try { return decoder.decode(value, { stream }); }
      catch { throw new SyntaxError("Invalid UTF-8 response"); }
    };
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { overflow = new ResponseBodyLimitError(limit); throw overflow; }
      for (let offset = 0; offset < chunk.value.byteLength;) {
        const count = Math.min(buffer.length - filled, chunk.value.byteLength - offset);
        buffer.set(chunk.value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === buffer.length) { parts.push(decode(buffer, true)); filled = 0; }
      }
      if (++chunks % 128 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
      }
    }
    if (filled) parts.push(decode(buffer.subarray(0, filled), true));
    parts.push(decode());
    complete = true;
    signal.throwIfAborted();
    return parts.join("");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) { void reader.cancel(overflow).catch(() => {}); }
    reader.releaseLock();
  }
}

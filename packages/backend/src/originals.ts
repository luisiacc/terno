import { bytesBase64, describeOriginal, ORIGINAL_PIECE, type OriginalResult, type OriginalUnavailable } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { ProviderAuthError, ProviderError } from "@terno/mail/portable";

export type OriginalRead = { accountId: number; bytes: Uint8Array } | { unavailable: OriginalUnavailable };

/** Originals kept for their downloads, at most (the oldest let go) */
export const ORIGINALS_KEPT = 2;
/** reads in flight, at most */
export const ORIGINAL_READS = 2;
/** a kept original untouched this long goes */
export const ORIGINAL_IDLE_MS = 120_000;

interface Entry {
  clientId: string;
  abort: AbortController;
  accountId?: number;
  bytes?: Uint8Array;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Plan 272: Show original's reads, and the bytes they read kept for a download, each by the renderer client that
 * opened it and the request id it chose. Closing (the view went) cancels a read still in flight and lets the bytes go;
 * so do two minutes untouched, a third original, and the account's removal. Nothing is written anywhere.
 */
export class Originals {
  /** by client and request id, oldest first */
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly read: (threadId: number, messageId: number, signal: AbortSignal) => Promise<OriginalRead>, private readonly idleMs = ORIGINAL_IDLE_MS) {}

  async open(p: { threadId: number; messageId: number; requestId: string }, clientId: string): Promise<OriginalResult> {
    const key = `${clientId}\n${p.requestId}`;
    this.drop(key);
    if ([...this.entries.values()].filter((e) => !e.bytes).length >= ORIGINAL_READS) throw new RpcError("UNAVAILABLE", L("attachments.busy"));
    const entry: Entry = { clientId, abort: new AbortController() };
    this.entries.set(key, entry);
    let read: OriginalRead;
    try {
      read = await this.read(p.threadId, p.messageId, entry.abort.signal);
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      // i18n-ignore: a closed view's own read; nobody is shown it
      if (entry.abort.signal.aborted) throw new RpcError("CANCELLED", "Show original closed");
      throw readFailed(error);
    }
    // i18n-ignore: a closed view's own read; nobody is shown it
    if (this.entries.get(key) !== entry) throw new RpcError("CANCELLED", "Show original closed");
    if ("unavailable" in read) {
      this.entries.delete(key);
      return { unavailable: read.unavailable };
    }
    entry.bytes = read.bytes;
    entry.accountId = read.accountId;
    this.touch(key, entry);
    // the oldest kept ones go first
    const kept = [...this.entries].filter(([, e]) => e.bytes);
    for (const [k] of kept.slice(0, Math.max(0, kept.length - ORIGINALS_KEPT))) this.drop(k);
    return { ...describeOriginal(read.bytes), pieces: Math.ceil(read.bytes.length / ORIGINAL_PIECE) };
  }

  /** One piece of a kept original, base64. NOT_FOUND: it went (the renderer reads the original again). */
  piece(requestId: string, index: number, clientId: string): { dataBase64: string } {
    const key = `${clientId}\n${requestId}`;
    const entry = this.entries.get(key);
    if (!entry?.bytes) throw new RpcError("NOT_FOUND", L("errors.original.expired"));
    // i18n-ignore: a renderer's own mistake, never shown
    if (index * ORIGINAL_PIECE >= entry.bytes.length) throw new RpcError("BAD_REQUEST", "No such piece");
    this.touch(key, entry);
    return { dataBase64: bytesBase64(entry.bytes.subarray(index * ORIGINAL_PIECE, (index + 1) * ORIGINAL_PIECE)) };
  }

  close(requestId: string, clientId: string): void {
    this.drop(`${clientId}\n${requestId}`);
  }

  /** the account went: so do its originals */
  dropAccount(accountId: number): void {
    for (const [key, entry] of this.entries) if (entry.accountId === accountId) this.drop(key);
  }

  /** how many are kept or reading (tests) */
  get size(): number {
    return this.entries.size;
  }

  private touch(key: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { if (this.entries.get(key) === entry) this.drop(key); }, this.idleMs);
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    entry.abort.abort();
    entry.bytes = undefined;
  }
}

/** What a failed read says: the server's own refusal as it put it; anything about reaching it, plainly */
function readFailed(error: unknown): unknown {
  if (error instanceof RpcError || !(error instanceof ProviderError)) return error;
  if (error instanceof ProviderAuthError) return new RpcError("UNAVAILABLE", L("errors.original.signin"), undefined, { expected: true, cause: error });
  if (error.network || error.retryable) return new RpcError("UNAVAILABLE", error.i18n?.key === "errors.original.settling" ? L("errors.original.settling") : L("errors.original.unreachable"), undefined, { expected: true, cause: error });
  return new RpcError("UNAVAILABLE", error.message, undefined, { expected: true, i18n: error.i18n, cause: error });
}

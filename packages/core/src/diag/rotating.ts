/**
 * A size-capped JSONL file with N rotated siblings (name.jsonl, name.jsonl.1 …
 * .N-1): lines are queued and appended in order by one writer at a time,
 * off the caller's turn; `flushSync` writes whatever is queued right now, for
 * a process that is about to die. A failure (a full disk, a removed folder)
 * drops the batch and never throws. The file system is injected, so this runs
 * on Node (main, MCP) and in tests on a fake.
 */
export interface RotatingFs {
  appendFile(path: string, data: string): Promise<void>;
  appendFileSync(path: string, data: string): void;
  size(path: string): Promise<number>;
  sizeSync(path: string): number;
  rename(from: string, to: string): Promise<void>;
  renameSync(from: string, to: string): void;
  remove(path: string): Promise<void>;
  removeSync(path: string): void;
}

export interface RotatingOptions {
  maxBytes?: number;
  maxFiles?: number;
  /** a batch is written this long after its first line, at the latest */
  delayMs?: number;
  /** lines beyond this many queued are dropped (counted) */
  maxQueued?: number;
  onError?(error: unknown): void;
}

export class RotatingLog {
  private queue: string[] = [];
  private queuedBytes = 0;
  private writing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private size = -1;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly delayMs: number;
  private readonly maxQueued: number;
  /** lines lost to a full queue or a failed write */
  dropped = 0;

  constructor(
    readonly path: string,
    private readonly fs: RotatingFs,
    private readonly o: RotatingOptions = {},
  ) {
    this.maxBytes = o.maxBytes ?? 2 * 1024 * 1024;
    this.maxFiles = o.maxFiles ?? 5;
    this.delayMs = o.delayMs ?? 250;
    this.maxQueued = o.maxQueued ?? 5000;
  }

  write(line: string): void {
    if (this.queue.length >= this.maxQueued) {
      this.dropped++;
      return;
    }
    const l = line.endsWith("\n") ? line : `${line}\n`;
    this.queue.push(l);
    this.queuedBytes += l.length;
    if (!this.timer && !this.writing) this.timer = setTimeout(() => void this.drain(), this.delayMs);
  }

  /** Resolves once everything queued so far is on disk (or dropped). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.writing) await new Promise((r) => setTimeout(r, 5));
    await this.drain();
  }

  /** Synchronous: for a process that is about to die. */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const data = this.take();
    if (!data) return;
    try {
      if (this.size < 0) this.size = this.fs.sizeSync(this.path);
      if (this.size > 0 && this.size + data.length > this.maxBytes) this.rotateSync();
      this.fs.appendFileSync(this.path, data);
      this.size += data.length;
    } catch (error) {
      this.fail(error, data);
    }
  }

  private take(): string {
    if (!this.queue.length) return "";
    const data = this.queue.join("");
    this.queue = [];
    this.queuedBytes = 0;
    return data;
  }

  private async drain(): Promise<void> {
    this.timer = null;
    if (this.writing) return;
    this.writing = true;
    try {
      for (let data = this.take(); data; data = this.take()) {
        try {
          if (this.size < 0) this.size = await this.fs.size(this.path);
          if (this.size > 0 && this.size + data.length > this.maxBytes) await this.rotate();
          await this.fs.appendFile(this.path, data);
          this.size += data.length;
        } catch (error) {
          this.fail(error, data);
        }
      }
    } finally {
      this.writing = false;
    }
  }

  private fail(error: unknown, data: string): void {
    this.dropped += data.split("\n").length - 1;
    this.size = -1;
    try {
      this.o.onError?.(error);
    } catch {
      // a logging failure never throws
    }
  }

  private suffix(i: number): string {
    return i === 0 ? this.path : `${this.path}.${i}`;
  }

  private async rotate(): Promise<void> {
    await this.fs.remove(this.suffix(this.maxFiles - 1)).catch(() => {});
    for (let i = this.maxFiles - 2; i >= 0; i--) await this.fs.rename(this.suffix(i), this.suffix(i + 1)).catch(() => {});
    this.size = 0;
  }

  private rotateSync(): void {
    try {
      this.fs.removeSync(this.suffix(this.maxFiles - 1));
    } catch {
      // not there yet
    }
    for (let i = this.maxFiles - 2; i >= 0; i--) {
      try {
        this.fs.renameSync(this.suffix(i), this.suffix(i + 1));
      } catch {
        // a gap in the series
      }
    }
    this.size = 0;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }
}

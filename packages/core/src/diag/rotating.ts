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
  /** a line longer than this (UTF-8 bytes) is dropped, counted: no single entry can blow the cap */
  maxLineBytes?: number;
  /** a batch is written this long after its first line, at the latest */
  delayMs?: number;
  /** lines beyond this many queued are dropped (counted) */
  maxQueued?: number;
  onError?(error: unknown): void;
}

/** UTF-8 length without TextEncoder (core runs everywhere). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

type Op = "rotate" | { data: string; bytes: number; lines: number };

export class RotatingLog {
  private queue: { line: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private writing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private size = -1;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxLineBytes: number;
  private readonly delayMs: number;
  private readonly maxQueued: number;
  /** lines lost to a full queue, an oversize line or a failed write */
  dropped = 0;

  constructor(
    readonly path: string,
    private readonly fs: RotatingFs,
    private readonly o: RotatingOptions = {},
  ) {
    this.maxBytes = o.maxBytes ?? 2 * 1024 * 1024;
    this.maxFiles = o.maxFiles ?? 5;
    this.maxLineBytes = Math.min(o.maxLineBytes ?? 64 * 1024, this.maxBytes);
    this.delayMs = o.delayMs ?? 250;
    this.maxQueued = o.maxQueued ?? 5000;
  }

  write(line: string): void {
    const l = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = utf8Bytes(l);
    if (this.queue.length >= this.maxQueued || bytes > this.maxLineBytes) {
      this.dropped++;
      return;
    }
    this.queue.push({ line: l, bytes });
    this.queuedBytes += bytes;
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
    const items = this.take();
    if (!items.length) return;
    try {
      if (this.size < 0) this.size = this.fs.sizeSync(this.path);
    } catch {
      this.size = 0;
    }
    for (const op of this.plan(items)) {
      if (op === "rotate") this.rotateSync();
      else {
        try {
          this.fs.appendFileSync(this.path, op.data);
          this.size += op.bytes;
        } catch (error) {
          this.fail(error, op.lines);
        }
      }
    }
  }

  private take(): { line: string; bytes: number }[] {
    const items = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    return items;
  }

  /**
   * The batch as appends that each fit what is left of the current file, a
   * rotation before any line that wouldn't: no file ever passes maxBytes.
   */
  private plan(items: { line: string; bytes: number }[]): Op[] {
    const ops: Op[] = [];
    let size = Math.max(0, this.size);
    let data = "";
    let bytes = 0;
    let lines = 0;
    for (const it of items) {
      if (size + bytes + it.bytes > this.maxBytes) {
        if (lines) ops.push({ data, bytes, lines });
        size += bytes;
        data = "";
        bytes = 0;
        lines = 0;
        if (size > 0) {
          ops.push("rotate");
          size = 0;
        }
      }
      data += it.line;
      bytes += it.bytes;
      lines++;
    }
    if (lines) ops.push({ data, bytes, lines });
    return ops;
  }

  private async drain(): Promise<void> {
    this.timer = null;
    if (this.writing) return;
    this.writing = true;
    try {
      for (let items = this.take(); items.length; items = this.take()) {
        if (this.size < 0) this.size = await this.fs.size(this.path).catch(() => 0);
        for (const op of this.plan(items)) {
          if (op === "rotate") await this.rotate();
          else {
            try {
              await this.fs.appendFile(this.path, op.data);
              this.size += op.bytes;
            } catch (error) {
              this.fail(error, op.lines);
            }
          }
        }
      }
    } finally {
      this.writing = false;
    }
  }

  private fail(error: unknown, lines: number): void {
    this.dropped += lines;
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

/**
 * Plan 107: the file an .mbox export writes, kept apart from Electron so it's unit-tested in Node. A private,
 * exclusive temp file beside the target (same volume, so the rename is atomic) takes each piece as it comes, and
 * is renamed into place at the end; cancel, a failure or the window going deletes it. One per window: a new one
 * ends the last.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { safeFileName, tempSibling } from "./print-policy";

/** what one write may carry (characters): the backend's ~1 MB a call, with room */
export const MBOX_WRITE_MAX = 4 * 1024 * 1024;

interface Pending {
  id: string;
  owner: number;
  path: string;
  tmp: string;
  file: FileHandle;
  /** writes in order, each after the last */
  queue: Promise<void>;
  failed: boolean;
}

/** `<name>.mbox`, or the fallback's when nothing of the name is left */
export function mboxFileName(name: string, fallback: string): string {
  return `${safeFileName(name) || safeFileName(fallback) || "Mailbox"}.mbox`;
}

export class MboxFiles {
  private readonly pending = new Map<string, Pending>();

  /** how many are open (tests) */
  get size(): number {
    return this.pending.size;
  }

  async begin(owner: number, path: string): Promise<string> {
    await this.abortAll(owner);
    const tmp = tempSibling(dirname(path), randomBytes(8).toString("hex"));
    const file = await open(tmp, "wx", 0o600);
    const id = randomUUID();
    this.pending.set(id, { id, owner, path, tmp, file, queue: Promise.resolve(), failed: false });
    return id;
  }

  /** false: it isn't open (any more), or writing failed (it's gone then) */
  async write(owner: number, id: string, chunk: string): Promise<boolean> {
    const p = this.own(owner, id);
    if (!p || chunk.length > MBOX_WRITE_MAX) return false;
    p.queue = p.queue.then(async () => {
      if (!p.failed) await p.file.appendFile(chunk, "utf8");
    });
    try {
      await p.queue;
      return true;
    } catch {
      p.failed = true;
      await this.drop(p);
      return false;
    }
  }

  /** synced and renamed into place: its file name; null: it isn't open, or it couldn't be */
  async end(owner: number, id: string): Promise<string | null> {
    const p = this.own(owner, id);
    if (!p) return null;
    this.pending.delete(id);
    try {
      await p.queue;
      await p.file.sync();
      await p.file.close();
      await rename(p.tmp, p.path);
      return basename(p.path);
    } catch {
      await p.file.close().catch(() => {});
      return null;
    } finally {
      await rm(p.tmp, { force: true });
    }
  }

  async abort(owner: number, id: string): Promise<void> {
    const p = this.own(owner, id);
    if (p) await this.drop(p);
  }

  /** the window went (or began another) */
  async abortAll(owner: number): Promise<void> {
    for (const p of this.pending.values()) if (p.owner === owner) await this.drop(p);
  }

  private own(owner: number, id: string): Pending | undefined {
    const p = this.pending.get(id);
    return p && p.owner === owner ? p : undefined;
  }

  private async drop(p: Pending): Promise<void> {
    this.pending.delete(p.id);
    await p.queue.catch(() => {});
    await p.file.close().catch(() => {});
    await rm(p.tmp, { force: true });
  }
}

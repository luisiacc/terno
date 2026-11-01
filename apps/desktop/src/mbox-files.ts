/**
 * Plan 107: the file an .mbox export writes, kept apart from Electron so it's unit-tested in Node. A private,
 * exclusive temp file beside the target (same volume, so the rename is atomic) takes each piece as it comes, and
 * is renamed into place at the end; cancel, a failure or the window going deletes it. One per window: a new one
 * ends the last.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
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
  /** being synced and renamed: no more writes */
  ending: boolean;
  /** cancelled or gone: never renamed into place */
  aborted: boolean;
}

/** `<name>.mbox`, or the fallback's when nothing of the name is left */
export function mboxFileName(name: string, fallback: string): string {
  return `${safeFileName(name) || safeFileName(fallback) || "Mailbox"}.mbox`;
}

/**
 * A window's exports end with its page (Codex code review #10: only `destroyed` was heard, so a reload kept a
 * half-written temp file open): a main-frame navigation (a reload too), the renderer gone, or the window gone.
 * `contents` is the window's WebContents.
 */
export function abortWithPage(files: MboxFiles, owner: number, contents: EventEmitter): void {
  const end = () => void files.endPage(owner);
  contents.on("did-start-navigation", (_event: unknown, _url: string, inPlace: boolean, main: boolean) => { if (main && !inPlace) end(); });
  contents.on("render-process-gone", end);
  contents.once("destroyed", end);
}

export class MboxFiles {
  private readonly pending = new Map<string, Pending>();
  /** each window's page generation: one more each time its page ends */
  private readonly pages = new Map<number, number>();

  /** how many are open (tests) */
  get size(): number {
    return this.pending.size;
  }

  /** the window's page now: an export begun under it is ended with it */
  page(owner: number): number {
    return this.pages.get(owner) ?? 0;
  }

  /** the window's page went (a reload, a crash, the window gone): its exports end, and any still beginning */
  async endPage(owner: number): Promise<void> {
    this.pages.set(owner, this.page(owner) + 1);
    await this.abortAll(owner);
  }

  /** `page`: the window's page when the export was asked for (before the save panel) */
  async begin(owner: number, path: string, page = this.page(owner)): Promise<string> {
    await this.abortAll(owner);
    const tmp = tempSibling(dirname(path), randomBytes(8).toString("hex"));
    const file = await open(tmp, "wx", 0o600);
    // the page ended while this opened: its cleanup ran before the file was here (Codex code review round 5 #5)
    if (this.page(owner) !== page) {
      await file.close().catch(() => {});
      await rm(tmp, { force: true });
      throw new Error("the page that asked for this export is gone");
    }
    const id = randomUUID();
    this.pending.set(id, { id, owner, path, tmp, file, queue: Promise.resolve(), failed: false, ending: false, aborted: false });
    return id;
  }

  /** false: it isn't open (any more), or writing failed (it's gone then) */
  async write(owner: number, id: string, chunk: string): Promise<boolean> {
    const p = this.own(owner, id);
    if (!p || p.ending || chunk.length > MBOX_WRITE_MAX) return false;
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
    if (!p || p.ending) return null;
    // still pending while it syncs, so a cancel then is heard (Codex code review round 2 #8: it found nothing to abort
    // and the file went into place anyway)
    p.ending = true;
    try {
      await p.queue;
      await p.file.sync();
      await p.file.close();
      if (p.aborted) return null;
      await rename(p.tmp, p.path);
      return basename(p.path);
    } catch {
      await p.file.close().catch(() => {});
      return null;
    } finally {
      this.pending.delete(id);
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
    p.aborted = true;
    // one ending closes and deletes its own file, checking `aborted` before the rename
    if (p.ending) return;
    this.pending.delete(p.id);
    await p.queue.catch(() => {});
    await p.file.close().catch(() => {});
    await rm(p.tmp, { force: true });
  }
}

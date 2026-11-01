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
  /**
   * being renamed into place: a cancel no longer applies, and the end says it was saved (Codex code review round 20
   * #1: a cancel during the rename said cancelled while the file replaced the destination)
   */
  committing: boolean;
  /** its rename, once committing: a begin of the window waits for it (Codex code review round 27 #2) */
  committed?: Promise<void>;
}

/** how an export's end went: saved under `name`, cancelled before it was renamed into place, or failed */
export type MboxEndResult = { status: "saved"; name: string } | { status: "cancelled" | "failed" };

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
  /** each window's newest export asked for: an older one whose panel answers late begins nothing (Codex code review round 8 #4) */
  private readonly asks = new Map<number, number>();
  /**
   * each destination's last rename: the next one to it goes after it, so an older export whose rename stalls never
   * replaces a newer one's file (Codex code review round 27 #2)
   */
  private readonly commits = new Map<string, Promise<void>>();

  /** how many are open (tests) */
  get size(): number {
    return this.pending.size;
  }

  /** the window's page now: an export begun under it is ended with it */
  page(owner: number): number {
    return this.pages.get(owner) ?? 0;
  }

  /** an export asked for (before its save panel): it supersedes any the window asked for before */
  ask(owner: number): number {
    const n = (this.asks.get(owner) ?? 0) + 1;
    this.asks.set(owner, n);
    return n;
  }

  /** whether `ask` is still the window's newest export */
  current(owner: number, ask: number): boolean {
    return this.asks.get(owner) === ask;
  }

  /** the window's page went (a reload, a crash, the window gone): its exports end, and any still beginning */
  async endPage(owner: number): Promise<void> {
    this.pages.set(owner, this.page(owner) + 1);
    await this.abortAll(owner);
  }

  /**
   * `page`: the window's page when the export was asked for (before the save panel); `ask`: its `ask()`. One a newer
   * ask superseded aborts nothing and keeps nothing: a stale panel answering late never ends its replacement (Codex
   * code review round 8 #4).
   */
  async begin(owner: number, path: string, page = this.page(owner), ask = this.ask(owner)): Promise<string> {
    if (!this.current(owner, ask)) throw new Error("a newer export replaced this one");
    await this.abortAll(owner);
    // one already going into place isn't aborted: its replacement begins once it's there (round 27 #2)
    for (const p of this.pending.values()) if (p.owner === owner && p.committing) await p.committed?.catch(() => {});
    if (!this.current(owner, ask)) throw new Error("a newer export replaced this one");
    const tmp = tempSibling(dirname(path), randomBytes(8).toString("hex"));
    const file = await open(tmp, "wx", 0o600);
    // the page ended while this opened: its cleanup ran before the file was here (Codex code review round 5 #5); or a
    // newer export was asked for meanwhile
    if (this.page(owner) !== page || !this.current(owner, ask)) {
      await file.close().catch(() => {});
      await rm(tmp, { force: true });
      throw new Error("the page that asked for this export is gone");
    }
    const id = randomUUID();
    this.pending.set(id, { id, owner, path, tmp, file, queue: Promise.resolve(), failed: false, ending: false, aborted: false, committing: false });
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

  /** synced and renamed into place; cancelled: aborted before the rename began; failed: it isn't open, or couldn't be */
  async end(owner: number, id: string): Promise<MboxEndResult> {
    const p = this.own(owner, id);
    if (!p || p.ending) return { status: "failed" };
    // still pending while it syncs, so a cancel then is heard (Codex code review round 2 #8: it found nothing to abort
    // and the file went into place anyway)
    p.ending = true;
    try {
      await p.queue;
      await p.file.sync();
      await p.file.close();
      if (p.aborted) return { status: "cancelled" };
      // from here the rename decides: a cancel during it changes nothing, so the answer is what happened
      p.committing = true;
      p.committed = this.commit(p.tmp, p.path);
      await p.committed;
      return { status: "saved", name: basename(p.path) };
    } catch {
      await p.file.close().catch(() => {});
      return { status: p.aborted && !p.committing ? "cancelled" : "failed" };
    } finally {
      this.pending.delete(id);
      await rm(p.tmp, { force: true });
    }
  }

  /** false: it was already being renamed into place (its end says saved or failed), or it isn't open */
  async abort(owner: number, id: string): Promise<boolean> {
    const p = this.own(owner, id);
    return p ? this.drop(p) : false;
  }

  /** the window went (or began another) */
  async abortAll(owner: number): Promise<void> {
    for (const p of this.pending.values()) if (p.owner === owner) await this.drop(p);
  }

  /** renamed into place after the destination's last rename, whichever way that went */
  private commit(tmp: string, path: string): Promise<void> {
    const done = (this.commits.get(path) ?? Promise.resolve()).then(() => rename(tmp, path));
    const settled = done.catch(() => {});
    this.commits.set(path, settled);
    void settled.then(() => { if (this.commits.get(path) === settled) this.commits.delete(path); });
    return done;
  }

  private own(owner: number, id: string): Pending | undefined {
    const p = this.pending.get(id);
    return p && p.owner === owner ? p : undefined;
  }

  private async drop(p: Pending): Promise<boolean> {
    if (p.committing) return false;
    p.aborted = true;
    // one ending closes and deletes its own file, checking `aborted` before the rename
    if (p.ending) return true;
    this.pending.delete(p.id);
    await p.queue.catch(() => {});
    await p.file.close().catch(() => {});
    await rm(p.tmp, { force: true });
    return true;
  }
}

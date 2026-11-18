/**
 * Plan 212: the private copy an attachment is opened from, kept apart from Electron so it's unit-tested in Node. Each
 * open gets its own exclusive directory under one private root, a read-only file in it, the quarantine mark downloads
 * carry, and only then is handed to the OS. Disk stays bounded: at most `KEEP` copies, none older than a day, cleared
 * on the next open (nothing runs at launch or while idle). A copy whose write, mark or open fails goes at once.
 */
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES, attachmentFilename } from "@terno/core";
import { opensInPlace } from "@terno/core/attachment-open";

/** copies kept: a few files being looked at, never a growing pile */
export const KEEP = 8;
/** a copy older than this is gone on the next open */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** a name longer than this is refused before it's cleaned */
export const MAX_NAME = 1000;
/** each open's directory starts with this, so cleanup removes only what it made */
const PREFIX = "open-";

export type OpenResult = { status: "opened" | "busy" | "failed" };

export interface OpenerDeps {
  /** the private root (`<userData>/Opened Attachments`) */
  root: string;
  /** marks a file as from the internet; rejects when it can't (the open then fails) */
  quarantine(path: string): Promise<void>;
  /** hands the file to the OS; "" when it opened, else what went wrong (Electron's `shell.openPath`) */
  openPath(path: string): Promise<string>;
  now(): number;
}

/** exactly the bytes a typed view covers, or null when it's neither a buffer nor a view of one, or too big */
export function attachmentBytes(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return value.byteLength <= MAX_ATTACHMENT_BYTES ? Buffer.from(value.slice(0)) : null;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value.byteLength <= MAX_ATTACHMENT_BYTES ? Buffer.from(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) : null;
  return null;
}

export class AttachmentOpener {
  private running = false;
  constructor(private readonly deps: OpenerDeps) {}

  /** One at a time: a second while one runs is `busy`, before anything is written. */
  async open(name: unknown, bytes: unknown): Promise<OpenResult> {
    if (this.running) return { status: "busy" };
    if (typeof name !== "string" || name.length > MAX_NAME) return { status: "failed" };
    const filename = attachmentFilename(name);
    const data = attachmentBytes(bytes);
    // checked here as well as in the page: a page that skips its check still can't hand the OS an app
    if (!opensInPlace(filename) || !data) return { status: "failed" };
    this.running = true;
    let dir: string | null = null;
    try {
      await this.privateRoot();
      await this.prune();
      dir = await mkdtemp(join(this.deps.root, PREFIX));
      const path = join(dir, filename);
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(data); } finally { await file.close(); }
      // the mark first: a read-only file can't take one
      await this.deps.quarantine(path);
      // read-only: an edit in the viewer asks to duplicate rather than saving into a copy that's cleared a day later
      await chmod(path, 0o400);
      if (await this.deps.openPath(path)) throw new Error("not opened");
      dir = null;
      return { status: "opened" };
    } catch {
      return { status: "failed" };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      this.running = false;
    }
  }

  /** the root, 0700, and a real directory: never a link somewhere else */
  private async privateRoot(): Promise<void> {
    await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.deps.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("root is not a directory");
    await chmod(this.deps.root, 0o700);
  }

  /** copies older than a day, then the oldest until there's room for one more; only directories this made */
  private async prune(): Promise<void> {
    const entries = (await readdir(this.deps.root, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.startsWith(PREFIX));
    const aged: { path: string; at: number }[] = [];
    for (const e of entries) {
      const path = join(this.deps.root, e.name);
      const stat = await lstat(path).catch(() => null);
      if (stat?.isDirectory()) aged.push({ path, at: stat.mtimeMs });
    }
    aged.sort((a, b) => b.at - a.at);
    const now = this.deps.now();
    const gone = aged.filter((c, i) => i >= KEEP - 1 || now - c.at > MAX_AGE_MS);
    for (const c of gone) await rm(c.path, { recursive: true, force: true }).catch(() => {});
  }
}

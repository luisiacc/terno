import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ATTACHMENT_CHUNK, attachmentFilename, base64Bytes, MAX_ATTACHMENT_BYTES, type AttachmentRef } from "@terno/core";
import type { MailStore } from "@terno/store";

/** Plan 185: copies of files handed to agents, bounded by count, bytes and age (checked when writing: no timers). */
export const AGENT_FILE_LIMITS = { entries: 64, bytes: 256 * 1024 * 1024, ageMs: 24 * 60 * 60_000 };

/** Next to the agent token, in the profile: the folder exists only while agents are on. */
export const agentFilesDir = (tokenPath: string) => join(dirname(tokenPath), "agent-files");

const ASSET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgentFileCancelled extends Error {}

/**
 * A copy of a kept attachment, written for an agent to read with its own tools (Claude Code reads PDFs and images;
 * MCP clients document no embedded blobs). One folder per asset keeps the real filename and extension. Owned by the
 * agent endpoint: cleared when it starts, when the token changes and when it closes, so turning agents off leaves none.
 */
export class AgentFiles {
  private generation = 0;
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    readonly dir: string,
    private readonly limits = AGENT_FILE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The copy's path. Two calls for one asset share one write. */
  write(store: MailStore, accountId: number, ref: AttachmentRef, yieldTo: () => Promise<void>): Promise<string> {
    const running = this.inFlight.get(ref.assetId);
    if (running) return running;
    const job = this.writeOnce(store, accountId, ref, yieldTo).finally(() => this.inFlight.delete(ref.assetId));
    this.inFlight.set(ref.assetId, job);
    return job;
  }

  /** Every copy gone; a write in flight doesn't put its file back. */
  async clear(): Promise<void> {
    this.generation++;
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Waits for writes in flight (they see the new generation and remove their own), then clears. */
  async close(): Promise<void> {
    this.generation++;
    await Promise.allSettled(this.inFlight.values());
    await this.clear();
  }

  private async writeOnce(store: MailStore, accountId: number, ref: AttachmentRef, yieldTo: () => Promise<void>): Promise<string> {
    if (!ASSET.test(ref.assetId)) throw new Error("Invalid attachment id");
    if (ref.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachment too large");
    const generation = this.generation;
    await this.ensureRoot();
    await this.prune(ref.assetId, ref.size);
    const folder = join(this.dir, ref.assetId.toLowerCase());
    // a fresh copy each time: never a file someone else put there
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { mode: 0o700 });
    const target = join(folder, attachmentFilename(ref.filename));
    const temp = join(folder, `.${randomUUID()}.part`);
    const file = await open(temp, "wx", 0o600);
    try {
      let size = 0;
      try {
        for (let i = 0; i < Math.ceil(ref.size / ATTACHMENT_CHUNK); i++) {
          const data = await store.attachments.read(accountId, ref.assetId, i);
          if (data === null) throw new Error("Attachment chunk missing");
          const bytes = base64Bytes(data);
          await file.write(bytes);
          size += bytes.byteLength;
          if (generation !== this.generation) throw new AgentFileCancelled("Agents were cut off");
          await yieldTo();
        }
      } finally {
        await file.close();
      }
      if (size !== ref.size) throw new Error("Attachment bytes missing");
      if (generation !== this.generation) throw new AgentFileCancelled("Agents were cut off");
      await rename(temp, target);
      return target;
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }

  /** The root is a real folder of ours (never a symlink), private to the user. */
  private async ensureRoot(): Promise<void> {
    await mkdir(this.dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(this.dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("The agent files folder isn't a folder");
    await chmod(this.dir, 0o700);
  }

  /** Old copies go, then the oldest until the new one fits the count and the bytes. Lists one folder of at most ~65 entries. */
  private async prune(assetId: string, incoming: number): Promise<void> {
    const entries: { path: string; at: number; bytes: number }[] = [];
    for (const name of await readdir(this.dir)) {
      const path = join(this.dir, name);
      const stat = await lstat(path).catch(() => null);
      if (!stat) continue;
      // what isn't one of our asset folders, or is the one being rewritten, goes
      if (stat.isSymbolicLink() || !stat.isDirectory() || !ASSET.test(name) || name === assetId.toLowerCase()) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      let bytes = 0;
      for (const leaf of await readdir(path).catch(() => [] as string[])) bytes += (await lstat(join(path, leaf)).catch(() => null))?.size ?? 0;
      entries.push({ path, at: stat.mtimeMs, bytes });
    }
    entries.sort((a, b) => a.at - b.at);
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    let count = entries.length;
    for (const e of entries) {
      if (this.now() - e.at <= this.limits.ageMs && count < this.limits.entries && total + incoming <= this.limits.bytes) break;
      await rm(e.path, { recursive: true, force: true });
      total -= e.bytes;
      count--;
    }
  }
}

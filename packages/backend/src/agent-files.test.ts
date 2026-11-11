import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_CHUNK, bytesBase64, type AttachmentRef } from "@terno/core";
import type { MailStore } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { AgentFileCancelled, AgentFiles } from "./agent-files";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tagentfiles-"));
  dirs.push(root);
  return { root, dir: join(root, "agent-files") };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A store holding these assets, in 48 KB chunks, as the real one does. */
function storeOf(assets: Record<string, Uint8Array>, o: { onRead?: () => Promise<void> } = {}): MailStore {
  return {
    attachments: {
      read: async (_account: number, assetId: string, index: number) => {
        await o.onRead?.();
        const bytes = assets[assetId];
        if (!bytes || index * ATTACHMENT_CHUNK >= bytes.length) return null;
        return bytesBase64(bytes.subarray(index * ATTACHMENT_CHUNK, (index + 1) * ATTACHMENT_CHUNK));
      },
    },
  } as unknown as MailStore;
}

const ref = (n: number, size: number, filename = "file.bin"): AttachmentRef => ({ assetId: uuid(n), filename, mime: "application/octet-stream", size });
const yieldTo = () => Promise.resolve();

describe("plan 185: copies of files for agents", () => {
  it("writes a private copy, whole, under its real name; a name can't leave its folder", async () => {
    const { dir } = fixture();
    const bytes = Uint8Array.from({ length: ATTACHMENT_CHUNK * 2 + 17 }, (_, i) => i % 251);
    const files = new AgentFiles(dir);
    const path = await files.write(storeOf({ [uuid(1)]: bytes }), 1, ref(1, bytes.length, "../../Report Q3.pdf"), yieldTo, 0);
    expect(path).toBe(join(dir, uuid(1), "Report Q3.pdf"));
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, uuid(1))).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // no temp file left
    expect(readdirSync(join(dir, uuid(1)))).toEqual(["Report Q3.pdf"]);
  });

  it("never follows a symlink: not as the folder, not as a copy's folder; a loose folder is made private again", async () => {
    const { root, dir } = fixture();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, dir);
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(new AgentFiles(dir).write(storeOf({ [uuid(1)]: bytes }), 1, ref(1, 3), yieldTo, 0)).rejects.toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(dir);
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    symlinkSync(elsewhere, join(dir, uuid(1)));
    const path = await new AgentFiles(dir).write(storeOf({ [uuid(1)]: bytes }), 1, ref(1, 3), yieldTo, 0);
    expect(lstatSync(join(dir, uuid(1))).isSymbolicLink()).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("is bounded by count, bytes and age, oldest first, and takes what isn't its own", async () => {
    const { dir } = fixture();
    let now = 1_000_000_000_000;
    const files = new AgentFiles(dir, { entries: 3, bytes: 10, ageMs: 60_000 }, () => now);
    const assets = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [uuid(n), new Uint8Array(3).fill(n)]));
    const store = storeOf(assets);
    const at = (n: number, ms: number) => utimesSync(join(dir, uuid(n)), ms / 1000, ms / 1000);
    await files.write(store, 1, ref(1, 3), yieldTo, 0);
    at(1, now - 3000);
    await files.write(store, 1, ref(2, 3), yieldTo, 0);
    at(2, now - 2000);
    await files.write(store, 1, ref(3, 3), yieldTo, 0);
    at(3, now - 1000);
    writeFileSync(join(dir, "stray.txt"), "x");
    // a fourth: the count (3) and the bytes (10) both make the oldest go
    await files.write(store, 1, ref(4, 3), yieldTo, 0);
    expect(readdirSync(dir).sort()).toEqual([uuid(2), uuid(3), uuid(4)].sort());
    at(4, now - 500);
    // a day later every copy is old
    now += 61_000;
    await files.write(store, 1, ref(5, 3), yieldTo, 0);
    expect(readdirSync(dir)).toEqual([uuid(5)]);
  });

  it("cut off mid-write (the token changed, agents turned off): no copy comes back", async () => {
    const { dir } = fixture();
    const files = new AgentFiles(dir);
    let reads = 0;
    const bytes = new Uint8Array(ATTACHMENT_CHUNK * 3);
    const store = storeOf({ [uuid(1)]: bytes }, { onRead: async () => { if (++reads === 2) await files.clear(); } });
    await expect(files.write(store, 1, ref(1, bytes.length), yieldTo, 0)).rejects.toBeInstanceOf(AgentFileCancelled);
    expect(existsSync(join(dir, uuid(1)))).toBe(false);
    // close waits for a write in flight, then empties the folder
    const writing = new AgentFiles(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = writing.write(storeOf({ [uuid(2)]: bytes }, { onRead: () => gate }), 1, ref(2, bytes.length), yieldTo, 0);
    const closed = writing.close();
    release();
    await expect(pending).rejects.toBeInstanceOf(AgentFileCancelled);
    await closed;
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses an id that isn't an asset's, and bytes that don't add up", async () => {
    const { dir } = fixture();
    const files = new AgentFiles(dir);
    await expect(files.write(storeOf({}), 1, { ...ref(1, 3), assetId: "../../etc" }, yieldTo, 0)).rejects.toThrow(/Invalid/);
    await expect(files.write(storeOf({ [uuid(1)]: new Uint8Array(2) }), 1, ref(1, 3), yieldTo, 0)).rejects.toThrow();
    expect(existsSync(join(dir, uuid(1)))).toBe(false);
  });

  it("a request that started before agents were cut off gets no copy, and a closed folder takes none (Codex review #1)", async () => {
    const { dir } = fixture();
    const files = new AgentFiles(dir);
    const store = storeOf({ [uuid(1)]: new Uint8Array([1, 2, 3]) });
    const ticket = files.ticket();
    // the token changed while the request located its file
    await files.clear();
    await expect(files.write(store, 1, ref(1, 3), yieldTo, ticket)).rejects.toBeInstanceOf(AgentFileCancelled);
    await files.close();
    await expect(files.write(store, 1, ref(1, 3), yieldTo, files.ticket())).rejects.toBeInstanceOf(AgentFileCancelled);
    expect(existsSync(dir)).toBe(false);
  });

  it("writes one copy at a time, so two at once still keep the bounds (Codex review #4)", async () => {
    const { dir } = fixture();
    const files = new AgentFiles(dir, { entries: 2, bytes: 1000, ageMs: 60_000 });
    const store = storeOf(Object.fromEntries([1, 2, 3, 4].map((n) => [uuid(n), new Uint8Array(3)])));
    await files.write(store, 1, ref(1, 3), yieldTo, 0);
    await Promise.all([files.write(store, 1, ref(2, 3), yieldTo, 0), files.write(store, 1, ref(3, 3), yieldTo, 0)]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("a write that takes fewer bytes than given is finished, not published short (Codex review #6)", async () => {
    const { dir } = fixture();
    const short: typeof open = async (...args) => {
      const handle = await open(...args);
      const write = handle.write.bind(handle) as (b: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
      // at most 1,000 bytes a call
      (handle as unknown as { write: typeof write }).write = (b, offset, length) => write(b, offset, Math.min(length, 1000));
      return handle;
    };
    const bytes = Uint8Array.from({ length: ATTACHMENT_CHUNK + 5 }, (_, i) => i % 7);
    const path = await new AgentFiles(dir, undefined, undefined, short).write(storeOf({ [uuid(1)]: bytes }), 1, ref(1, bytes.length), yieldTo, 0);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  });
});

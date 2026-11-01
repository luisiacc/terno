import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

/** the next rename waits for the test (null: Node's own) */
const renaming = vi.hoisted(() => ({ hold: null as null | Promise<void>, started: false }));
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      renaming.started = true;
      const hold = renaming.hold;
      renaming.hold = null;
      if (hold) await hold;
      return fs.rename(from, to);
    },
  };
});

import { MBOX_WRITE_MAX, MboxFiles, mboxFileName } from "./mbox-files";

const dirs: string[] = [];
afterEach(() => {
  renaming.hold = null;
  renaming.started = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "terno-mbox-"));
  dirs.push(d);
  return d;
};

describe("mbox export file (plan 107)", () => {
  it("appends to a private temp file beside the target and renames it into place", async () => {
    const d = dir();
    const target = join(d, "Clients.mbox");
    writeFileSync(target, "old");
    const files = new MboxFiles();
    const id = await files.begin(1, target);
    const temp = readdirSync(d).find((f) => f.startsWith(".terno-export-"))!;
    expect(statSync(join(d, temp)).mode & 0o777).toBe(0o600);
    expect(await files.write(1, id, "From - a\n")).toBe(true);
    expect(await files.write(1, id, "ñ\n")).toBe(true);
    // the old file stays whole until the end
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(await files.end(1, id)).toEqual({ status: "saved", name: "Clients.mbox" });
    expect(readFileSync(target, "utf8")).toBe("From - a\nñ\n");
    expect(readdirSync(d)).toEqual(["Clients.mbox"]);
    expect(files.size).toBe(0);
  });

  it("abort, a new begin, or another window's ids leave nothing behind and touch nothing", async () => {
    const d = dir();
    const files = new MboxFiles();
    const id = await files.begin(1, join(d, "a.mbox"));
    expect(await files.write(2, id, "x")).toBe(false);
    expect(await files.end(2, id)).toEqual({ status: "failed" });
    expect(await files.write(1, id, "y".repeat(MBOX_WRITE_MAX + 1))).toBe(false);
    await files.abort(1, id);
    expect(readdirSync(d)).toEqual([]);
    expect(await files.write(1, id, "x")).toBe(false);
    const first = await files.begin(1, join(d, "b.mbox"));
    const second = await files.begin(1, join(d, "c.mbox"));
    expect(await files.write(1, first, "x")).toBe(false);
    expect(readdirSync(d)).toHaveLength(1);
    await files.abortAll(1);
    expect(readdirSync(d)).toEqual([]);
    expect(await files.end(1, second)).toEqual({ status: "failed" });
  });

  it("a cancel while the file syncs keeps it out of place, and the old file whole (Codex code review round 2 #8)", async () => {
    const d = dir();
    const target = join(d, "Clients.mbox");
    writeFileSync(target, "old");
    const files = new MboxFiles();
    const id = await files.begin(1, target);
    expect(await files.write(1, id, "From - a\n")).toBe(true);
    // a slow disk: the sync waits until the cancel has come
    const handle = await open(join(d, "probe"), "w");
    const proto = Object.getPrototypeOf(handle) as { sync(): Promise<void> };
    await handle.close();
    rmSync(join(d, "probe"));
    const real = proto.sync;
    let release!: () => void;
    const synced = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(proto, "sync").mockImplementation(async function (this: unknown) {
      await synced;
      return real.call(this);
    });
    try {
      const ending = files.end(1, id);
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      expect(await files.write(1, id, "late")).toBe(false);
      expect(await files.abort(1, id)).toBe(true);
      release();
      expect(await ending).toEqual({ status: "cancelled" });
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(d)).toEqual(["Clients.mbox"]);
    expect(files.size).toBe(0);
  });

  it("a cancel once the rename began changes nothing, and the end says it was saved (Codex code review round 20 #1)", async () => {
    const d = dir();
    const target = join(d, "Clients.mbox");
    writeFileSync(target, "old");
    const files = new MboxFiles();
    const id = await files.begin(1, target);
    expect(await files.write(1, id, "From - a\n")).toBe(true);
    let release!: () => void;
    renaming.hold = new Promise<void>((r) => (release = r));
    const ending = files.end(1, id);
    await vi.waitFor(() => expect(renaming.started).toBe(true));
    // too late: the file is going into place
    expect(await files.abort(1, id)).toBe(false);
    await files.abortAll(1);
    release();
    expect(await ending).toEqual({ status: "saved", name: "Clients.mbox" });
    expect(readFileSync(target, "utf8")).toBe("From - a\n");
    expect(readdirSync(d)).toEqual(["Clients.mbox"]);
    expect(files.size).toBe(0);
  });

  it("a stalled rename never overwrites the export that replaced it, in its window or another (Codex code review round 27 #2)", async () => {
    const d = dir();
    const target = join(d, "Clients.mbox");
    const files = new MboxFiles();
    for (const owner of [1, 2]) {
      writeFileSync(target, "old");
      const first = await files.begin(1, target);
      expect(await files.write(1, first, "older\n")).toBe(true);
      let release!: () => void;
      renaming.hold = new Promise<void>((r) => (release = r));
      renaming.started = false;
      const ending = files.end(1, first);
      await vi.waitFor(() => expect(renaming.started).toBe(true));
      // the window's next export waits for the one committing; another window's commits after it
      let begun = false;
      const next = files.begin(owner, target).then((id) => ((begun = true), id));
      await new Promise((r) => setTimeout(r, 20));
      if (owner === 1) expect(begun).toBe(false);
      const ended = owner === 1 ? null : (async () => {
        const id = await next;
        expect(await files.write(owner, id, "newer\n")).toBe(true);
        return files.end(owner, id);
      })();
      await new Promise((r) => setTimeout(r, 20));
      release();
      expect(await ending).toEqual({ status: "saved", name: "Clients.mbox" });
      const result = ended ? await ended : await (async () => {
        const id = await next;
        expect(await files.write(owner, id, "newer\n")).toBe(true);
        return files.end(owner, id);
      })();
      expect(result).toEqual({ status: "saved", name: "Clients.mbox" });
      expect(readFileSync(target, "utf8")).toBe("newer\n");
      expect(readdirSync(d)).toEqual(["Clients.mbox"]);
      expect(files.size).toBe(0);
    }
  });

  it("a begin a newer ask superseded aborts nothing, before or after its file opens (Codex code review round 8 #4)", async () => {
    const d = dir();
    const files = new MboxFiles();
    const a = files.ask(1);
    const b = files.ask(1);
    const id = await files.begin(1, join(d, "b.mbox"), files.page(1), b);
    await expect(files.begin(1, join(d, "a.mbox"), files.page(1), a)).rejects.toThrow();
    expect(await files.write(1, id, "x")).toBe(true);
    // superseded while its file opens: its file goes
    const c = files.ask(1);
    const late = files.begin(1, join(d, "c.mbox"), files.page(1), c);
    files.ask(1);
    await expect(late).rejects.toThrow();
    expect(readdirSync(d).filter((f) => f.startsWith(".terno-export-"))).toHaveLength(0);
  });

  it("names the file from the folder, never a path", () => {
    expect(mboxFileName("Clients", "Mailbox")).toBe("Clients.mbox");
    expect(mboxFileName("../a/b:c", "Mailbox")).toBe("a b c.mbox");
    expect(mboxFileName("..", "Buzón")).toBe("Buzón.mbox");
  });
});

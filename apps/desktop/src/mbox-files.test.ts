import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MBOX_WRITE_MAX, MboxFiles, mboxFileName } from "./mbox-files";

const dirs: string[] = [];
afterEach(() => {
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
    expect(await files.end(1, id)).toBe("Clients.mbox");
    expect(readFileSync(target, "utf8")).toBe("From - a\nñ\n");
    expect(readdirSync(d)).toEqual(["Clients.mbox"]);
    expect(files.size).toBe(0);
  });

  it("abort, a new begin, or another window's ids leave nothing behind and touch nothing", async () => {
    const d = dir();
    const files = new MboxFiles();
    const id = await files.begin(1, join(d, "a.mbox"));
    expect(await files.write(2, id, "x")).toBe(false);
    expect(await files.end(2, id)).toBeNull();
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
    expect(await files.end(1, second)).toBeNull();
  });

  it("names the file from the folder, never a path", () => {
    expect(mboxFileName("Clients", "Mailbox")).toBe("Clients.mbox");
    expect(mboxFileName("../a/b:c", "Mailbox")).toBe("a b c.mbox");
    expect(mboxFileName("..", "Buzón")).toBe("Buzón.mbox");
  });
});

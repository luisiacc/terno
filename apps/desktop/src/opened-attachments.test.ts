import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@terno/core";
import { AttachmentOpener, KEEP, MAX_AGE_MS, MAX_DISK_NAME_BYTES, attachmentBytes, diskName, type OpenerDeps } from "./opened-attachments";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(over: Partial<OpenerDeps> = {}) {
  const base = mkdtempSync(join(tmpdir(), "terno-open-"));
  dirs.push(base);
  const root = join(base, "Opened Attachments");
  const opened: string[] = [];
  const marked: string[] = [];
  const deps: OpenerDeps = {
    root,
    quarantine: vi.fn(async (path: string) => { marked.push(path); }),
    openPath: vi.fn(async (path: string) => { opened.push(path); return ""; }),
    now: () => Date.now(),
    ...over,
  };
  return { base, root, opened, marked, deps, opener: new AttachmentOpener(deps) };
}

const copies = (root: string) => (existsSync(root) ? readdirSync(root) : []);
const bytes = (...b: number[]) => new Uint8Array(b).buffer;

describe("AttachmentOpener (plan 212)", () => {
  it("writes a private, read-only copy in its own directory, marks it, then opens it", async () => {
    const { root, opened, marked, opener } = setup();
    expect(await opener.open("../report.pdf", bytes(1, 2, 3))).toEqual({ status: "opened" });
    expect(opened).toHaveLength(1);
    const path = opened[0]!;
    // the leaf name only, inside the root, in a directory of its own
    expect(path.startsWith(root + "/open-")).toBe(true);
    expect(path.endsWith("/report.pdf")).toBe(true);
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    expect(statSync(path).mode & 0o777).toBe(0o400);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(marked).toEqual([path]);
    // two files with one name never meet
    expect(await opener.open("report.pdf", bytes(4))).toEqual({ status: "opened" });
    expect(opened[1]).not.toBe(path);
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
  });

  it("refuses what isn't a document, a bad name or bad bytes, and writes nothing", async () => {
    const { root, opened, opener } = setup();
    const refused: [unknown, unknown][] = [
      ["setup.app", bytes(1)], ["run.command", bytes(1)], ["page.html", bytes(1)], ["invoice.pdf.app", bytes(1)],
      [42, bytes(1)], [`${"a".repeat(1000)}.pdf`, bytes(1)], ["a.pdf", "AQID"], ["a.pdf", null], ["a.pdf", new DataView(bytes(1))],
      ["a.pdf", new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1)],
    ];
    for (const [name, data] of refused) expect(await opener.open(name, data), String(name).slice(0, 20)).toEqual({ status: "failed" });
    expect(opened).toEqual([]);
    expect(copies(root)).toEqual([]);
  });

  it("opens a long name in a script of many bytes: shortened on disk by whole characters, its extension kept", async () => {
    const { opened, opener } = setup();
    const name = `${"報".repeat(90)}.pdf`;
    expect(await opener.open(name, bytes(1))).toEqual({ status: "opened" });
    const leaf = opened[0]!.split("/").pop()!;
    expect(leaf.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(leaf)).toBeLessThanOrEqual(MAX_DISK_NAME_BYTES);
    expect(name.startsWith(leaf.slice(0, -4))).toBe(true);
    // an emoji is never cut in half, and a short name is left alone
    expect(diskName(`${"😀".repeat(60)}.png`)).toMatch(/^(😀)+\.png$/u);
    expect(diskName("report.pdf")).toBe("report.pdf");
  });

  it("copies exactly the bytes a typed view covers", () => {
    const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    expect([...attachmentBytes(view)!]).toEqual([1, 2, 3]);
  });

  it("takes one open at a time: a second while one runs is busy and writes nothing", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { root, opener, opened } = setup({ quarantine: async () => { await held; } });
    const first = opener.open("a.pdf", bytes(1));
    await vi.waitFor(() => expect(copies(root)).toHaveLength(1));
    expect(await opener.open("b.pdf", bytes(2))).toEqual({ status: "busy" });
    expect(copies(root)).toHaveLength(1);
    release();
    expect(await first).toEqual({ status: "opened" });
    expect(opened).toHaveLength(1);
  });

  it("fails closed: a copy that can't be marked or opened is removed and never handed on", async () => {
    const unmarked = setup({ quarantine: async () => { throw new Error("xattr"); } });
    expect(await unmarked.opener.open("a.pdf", bytes(1))).toEqual({ status: "failed" });
    expect(unmarked.opened).toEqual([]);
    expect(copies(unmarked.root)).toEqual([]);
    const unopened = setup({ openPath: async () => "Failed to open path" });
    expect(await unopened.opener.open("a.pdf", bytes(1))).toEqual({ status: "failed" });
    expect(copies(unopened.root)).toEqual([]);
    const rejected = setup({ openPath: async () => { throw new Error("launch"); } });
    expect(await rejected.opener.open("a.pdf", bytes(1))).toEqual({ status: "failed" });
    expect(copies(rejected.root)).toEqual([]);
  });

  it("keeps at most KEEP copies and none older than a day, and removes only its own", async () => {
    let now = Date.now();
    const { root, opener } = setup({ now: () => now });
    for (let i = 0; i < KEEP + 3; i++) expect(await opener.open(`f${i}.pdf`, bytes(i))).toEqual({ status: "opened" });
    expect(copies(root)).toHaveLength(KEEP);
    mkdirSync(join(root, "not-ours"));
    // a day on: every earlier copy goes on the next open, whatever their number
    for (const name of copies(root)) if (name.startsWith("open-")) utimesSync(join(root, name), new Date(now - MAX_AGE_MS - 1000), new Date(now - MAX_AGE_MS - 1000));
    now += 1;
    expect(await opener.open("new.pdf", bytes(1))).toEqual({ status: "opened" });
    expect(copies(root).filter((n) => n.startsWith("open-"))).toHaveLength(1);
    expect(copies(root)).toContain("not-ours");
  });

  it("refuses a root that is a link somewhere else", async () => {
    const { base, root, opener, opened } = setup();
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root);
    expect(await opener.open("a.pdf", bytes(1))).toEqual({ status: "failed" });
    expect(opened).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

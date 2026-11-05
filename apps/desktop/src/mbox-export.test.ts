import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  showSaveDialog: null as null | ((options: unknown) => Promise<{ canceled: boolean; filePath?: string }>),
}));
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: (options: unknown) => electron.showSaveDialog!(options) },
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, fn) },
}));

/** a rename that waits for the test (null: Node's own) */
const renaming = vi.hoisted(() => ({ hold: null as null | Promise<void>, started: false }));
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      renaming.started = true;
      if (renaming.hold) await renaming.hold;
      return fs.rename(from, to);
    },
  };
});

const { registerMboxExport } = await import("./mbox-export");

const dirs: string[] = [];
afterEach(() => {
  renaming.hold = null;
  renaming.started = false;
  electron.handlers.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** the main process's handlers with the smoke's export directory, and a page that begins an export */
async function begun() {
  const dir = mkdtempSync(join(tmpdir(), "terno-mbox-export-"));
  dirs.push(dir);
  registerMboxExport({ trusted: () => true, testDir: dir });
  const sender = Object.assign(new EventEmitter(), { id: 7 });
  const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!({ sender }, ...args);
  const r = (await call("terno:export-begin", "Clients")) as { status: string; id: string };
  expect(r.status).toBe("ready");
  expect(await call("terno:export-write", r.id, "From - a\n")).toBe(true);
  const temps = () => readdirSync(dir).filter((f) => f.startsWith(".terno-export-"));
  expect(temps()).toHaveLength(1);
  /** the abort runs after the event, as it would in main */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { sender, call, id: r.id, temps, settled };
}

describe("mbox export in main (plan 107)", () => {
  it("a reload or another page in the window ends its export: no temp file is left open (Codex code review #10)", async () => {
    const t = await begun();
    // in-page and subframe navigations leave it be
    t.sender.emit("did-start-navigation", {}, "app://terno/#x", true, true);
    t.sender.emit("did-start-navigation", {}, "app://terno/frame", false, false);
    await t.settled();
    expect(await t.call("terno:export-write", t.id, "b\n")).toBe(true);
    t.sender.emit("did-start-navigation", {}, "app://terno/", false, true);
    await vi.waitFor(() => expect(t.temps()).toEqual([]));
    expect(await t.call("terno:export-write", t.id, "c\n")).toBe(false);
  });

  it("a renderer that crashes ends its export (Codex code review #10)", async () => {
    const t = await begun();
    t.sender.emit("render-process-gone", {}, { reason: "crashed" });
    await vi.waitFor(() => expect(t.temps()).toEqual([]));
    expect(await t.call("terno:export-end", t.id)).toEqual({ status: "failed" });
  });

  it("the window going ends its export", async () => {
    const t = await begun();
    t.sender.emit("destroyed");
    await vi.waitFor(() => expect(t.temps()).toEqual([]));
  });

  it("a page that ends while the file opens leaves no temp file (Codex code review round 5 #5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-mbox-export-"));
    dirs.push(dir);
    registerMboxExport({ trusted: () => true, testDir: dir });
    const sender = Object.assign(new EventEmitter(), { id: 8 });
    const begin = electron.handlers.get("terno:export-begin")!({ sender }, "Clients") as Promise<{ status: string }>;
    // the reload lands while the temp file is being opened
    sender.emit("did-start-navigation", {}, "app://terno/", false, true);
    expect((await begin).status).toBe("failed");
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual([]));
  });

  it("a page that ends while the save panel is open begins nothing (Codex code review round 5 #5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-mbox-export-"));
    dirs.push(dir);
    let choose!: (r: { canceled: boolean; filePath?: string }) => void;
    electron.showSaveDialog = () => new Promise((resolve) => (choose = resolve));
    registerMboxExport({ trusted: () => true, testDir: null });
    const sender = Object.assign(new EventEmitter(), { id: 9 });
    const begin = electron.handlers.get("terno:export-begin")!({ sender }, "Clients") as Promise<{ status: string }>;
    sender.emit("render-process-gone", {}, { reason: "crashed" });
    choose({ canceled: false, filePath: join(dir, "Clients.mbox") });
    expect((await begin).status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a superseded export whose save panel answers late leaves its replacement be (Codex code review round 8 #4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-mbox-export-"));
    dirs.push(dir);
    const panels: ((r: { canceled: boolean; filePath?: string }) => void)[] = [];
    electron.showSaveDialog = () => new Promise((resolve) => panels.push(resolve));
    registerMboxExport({ trusted: () => true, testDir: null });
    const sender = Object.assign(new EventEmitter(), { id: 10 });
    const call = (channel: string, ...args: unknown[]) => electron.handlers.get(channel)!({ sender }, ...args);
    const a = call("terno:export-begin", "A") as Promise<{ status: string }>;
    const b = call("terno:export-begin", "B") as Promise<{ status: string; id: string }>;
    panels[1]!({ canceled: false, filePath: join(dir, "B.mbox") });
    const ready = await b;
    expect(ready.status).toBe("ready");
    // A's panel answers after B is ready: A begins nothing and aborts nothing
    panels[0]!({ canceled: false, filePath: join(dir, "A.mbox") });
    expect((await a).status).toBe("cancelled");
    expect(await call("terno:export-write", ready.id, "From - b\n")).toBe(true);
    expect(await call("terno:export-end", ready.id)).toEqual({ status: "saved", name: "B.mbox" });
    expect(readdirSync(dir)).toEqual(["B.mbox"]);
  });

  it("the end says what happened: a cancel before the rename is cancelled, one during it too late (Codex code review round 20 #1)", async () => {
    // cancelled while the last piece is written: never put in place, and the end says cancelled
    const a = await begun();
    const ending = a.call("terno:export-end", a.id);
    expect(await a.call("terno:export-abort", a.id)).toBe(true);
    expect(await ending).toEqual({ status: "cancelled" });
    expect(a.temps()).toEqual([]);
    // cancelled while it's renamed into place: the abort says too late, and the end saved
    const b = await begun();
    let release!: () => void;
    renaming.hold = new Promise<void>((r) => (release = r));
    const saving = b.call("terno:export-end", b.id);
    await vi.waitFor(() => expect(renaming.started).toBe(true));
    expect(await b.call("terno:export-abort", b.id)).toBe(false);
    release();
    expect(await saving).toEqual({ status: "saved", name: "Clients.mbox" });
  });
});

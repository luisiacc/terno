/**
 * Plan 107: exporting a folder from the renderer. The RPC client is mocked; the sink is the desktop bridge, the
 * browser's file picker, or Blob parts. Progress, cancel (the backend's session and the file both end), the
 * Blob cap, and errors in plain words.
 */
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>>, calls: [] as { method: string; params: unknown }[] };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => {
      fake.calls.push({ method, params });
      return fake.handlers[method]?.(params) ?? Promise.resolve({});
    },
    on: () => () => {},
  },
}));

const { BLOB_MAX, exportFolder } = await import("./export-folder");
const { resetSnacks, runAction, useSnack } = await import("./snack");

const target = { accountId: 1, folder: "Label_1", view: null };
const g = globalThis as Record<string, unknown>;

/** a desktop bridge that records what main would write */
function desktop(o: { begin?: "ready" | "cancelled" | "failed"; writeOk?: boolean } = {}) {
  const file = { chunks: [] as string[], ended: false, aborted: false, names: [] as string[] };
  g.ternoDesktop = {
    mboxExport: {
      begin: async (name: string) => (file.names.push(name), o.begin === undefined || o.begin === "ready" ? { status: "ready", id: "f1" } : { status: o.begin }),
      write: async (_id: string, chunk: string) => (file.chunks.push(chunk), o.writeOk ?? true),
      end: async () => ((file.ended = true), { status: "saved", name: "Clients.mbox" }),
      abort: async () => ((file.aborted = true), true),
    },
  };
  return file;
}

/** `pages` nexts, each one message of `text` */
function backend(pages: number, text = "From - x\n\n", extra: { missingAttachments?: number; partialBodies?: number } = {}) {
  let n = 0;
  fake.handlers["folders.exportStart"] = async () => ({ exportId: "e1", total: pages, name: "Clients" });
  fake.handlers["folders.exportNext"] = async () => {
    n++;
    return { text, done: n, total: pages, finished: n === pages, missingAttachments: n === pages ? extra.missingAttachments ?? 0 : 0, partialBodies: n === pages ? extra.partialBodies ?? 0 : 0 };
  };
}

const current = () => useSnack.getState().current;

beforeEach(() => {
  fake.handlers = {};
  fake.calls = [];
  resetSnacks();
  delete g.ternoDesktop;
  delete g.showSaveFilePicker;
});
afterEach(() => setLocale("en", en));

describe("exportFolder (plan 107)", () => {
  it("writes every piece through the desktop bridge, with progress, then says how many and what wasn't here", async () => {
    const file = desktop();
    backend(3, "From - x\n\n", { missingAttachments: 2, partialBodies: 1 });
    const progress: string[] = [];
    const off = useSnack.subscribe((s) => { if (s.current?.tone === "loading") progress.push(s.current.message); });
    await exportFolder(target, "Clients");
    off();
    expect(file.names).toEqual(["Clients"]);
    expect(file.chunks).toHaveLength(3);
    expect(file.ended).toBe(true);
    expect(progress).toContain("Exporting Clients… 0 / 3");
    expect(progress).toContain("Exporting Clients… 2 / 3");
    expect(current()).toMatchObject({ tone: "success", message: "Exported 3 messages", description: "2 attachments weren’t on this computer. 1 message’s full text wasn’t on this computer." });
    expect(fake.calls.find((c) => c.method === "folders.exportStart")?.params).toEqual(target);
  });

  it("speaks the active language", async () => {
    setLocale("es", es);
    desktop();
    backend(1);
    await exportFolder(target, "Clientes");
    expect(current()).toMatchObject({ tone: "success", message: "Se exportó 1 mensaje" });
  });

  it("the snack's Cancel ends the backend's session and deletes the file", async () => {
    const file = desktop();
    backend(10);
    const next = fake.handlers["folders.exportNext"]!;
    fake.handlers["folders.exportNext"] = async (p) => {
      const r = (await next(p)) as { done: number };
      // the user clicks Cancel while the second piece is on its way
      if (r.done === 2) runAction("action");
      return r;
    };
    await exportFolder(target, "Clients");
    expect(fake.calls.filter((c) => c.method === "folders.exportCancel")).toEqual([{ method: "folders.exportCancel", params: { exportId: "e1" } }]);
    expect(file.aborted).toBe(true);
    expect(file.ended).toBe(false);
    expect(file.chunks).toHaveLength(1);
    expect(current()).toMatchObject({ message: "Export cancelled" });
  });

  it("a file opened after its export was superseded is aborted, never left open (Codex code review round 2 #9)", async () => {
    const opened: ((r: { status: "ready"; id: string }) => void)[] = [];
    const aborted: string[] = [];
    g.ternoDesktop = {
      mboxExport: {
        begin: () => new Promise((resolve) => opened.push(resolve)),
        write: async () => true,
        end: async () => ({ status: "saved", name: "x.mbox" }),
        abort: async (id: string) => (aborted.push(id), true),
      },
    };
    backend(1);
    const first = exportFolder(target, "Clients");
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    // a second export while the first one's file is still being made
    const second = exportFolder(target, "Clients");
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    opened[0]!({ status: "ready", id: "f1" });
    await first;
    expect(aborted).toEqual(["f1"]);
    opened[1]!({ status: "ready", id: "f2" });
    await second;
    expect(aborted).toEqual(["f1"]);
    expect(fake.calls.filter((c) => c.method === "folders.exportStart")).toHaveLength(1);
  });

  it("a cancel while the file is being saved never ends in a success (Codex code review round 2 #8)", async () => {
    const file = desktop();
    backend(1);
    const bridge = (g.ternoDesktop as { mboxExport: { end: () => Promise<unknown> } }).mboxExport;
    bridge.end = async () => {
      // the user clicks Cancel while main syncs the file
      runAction("action");
      file.ended = true;
      return { status: "saved", name: "Clients.mbox" };
    };
    await exportFolder(target, "Clients");
    expect(file.aborted).toBe(true);
    expect(current()).toMatchObject({ message: "Export cancelled" });
  });

  it("a cancelled save panel starts nothing", async () => {
    desktop({ begin: "cancelled" });
    backend(1);
    await exportFolder(target, "Clients");
    expect(fake.calls).toEqual([]);
    expect(current()).toBeNull();
  });

  it("a failure says what happened, ends the session and drops the file", async () => {
    const file = desktop();
    backend(3);
    fake.handlers["folders.exportNext"] = async () => {
      throw new Error("The export stopped because it waited too long. Export the folder again.");
    };
    await exportFolder(target, "Clients");
    expect(file.aborted).toBe(true);
    expect(fake.calls.some((c) => c.method === "folders.exportCancel")).toBe(true);
    expect(current()).toMatchObject({ tone: "error", message: "Couldn’t export Clients: The export stopped because it waited too long. Export the folder again." });
  });

  it("a write main refuses says the disk couldn't take it", async () => {
    desktop({ writeOk: false });
    backend(2);
    await exportFolder(target, "Clients");
    expect(current()).toMatchObject({ tone: "error", message: "The file couldn’t be written. Check there’s room on the disk and try again." });
  });

  it("an empty folder says so and keeps no file", async () => {
    const file = desktop();
    fake.handlers["folders.exportStart"] = async () => ({ exportId: "e1", total: 0, name: "Clients" });
    await exportFolder(target, "Clients");
    expect(file.aborted).toBe(true);
    expect(current()).toMatchObject({ message: "There’s nothing in Clients to export on this computer." });
  });

  it("uses the browser's file picker where there is one", async () => {
    const written: string[] = [];
    let closed = false;
    g.showSaveFilePicker = async (o: { suggestedName: string }) => {
      expect(o.suggestedName).toBe("Work: Clients.mbox".replace(":", " "));
      return { createWritable: async () => ({ write: async (s: string) => void written.push(s), close: async () => void (closed = true), abort: async () => {} }) };
    };
    backend(2);
    await exportFolder(target, "Work: Clients");
    expect(written).toHaveLength(2);
    expect(closed).toBe(true);
  });

  it("Blob parts stop at the cap with a clear error, and say the limit up front for a large folder", async () => {
    const big = "x".repeat(1024 * 1024);
    let n = 0;
    fake.handlers["folders.exportStart"] = async () => ({ exportId: "e1", total: 9000, name: "Clients" });
    fake.handlers["folders.exportNext"] = async () => ({ text: big, done: ++n, total: 9000, finished: false, missingAttachments: 0, partialBodies: 0 });
    let warned = "";
    const off = useSnack.subscribe((s) => { if (s.current?.tone === "loading" && s.current.description) warned = s.current.description; });
    await exportFolder(target, "Clients");
    off();
    expect(warned).toBe("This browser saves exports of up to 512.0 MB.");
    expect(n).toBe(BLOB_MAX / big.length + 1);
    expect(current()).toMatchObject({ tone: "error", message: "Clients is larger than this browser can save (512.0 MB). Export it from Chrome, Edge or the Terno app." });
    expect(fake.calls.some((c) => c.method === "folders.exportCancel")).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesBase64 } from "@terno/core";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
vi.mock("./snack", () => ({ snack: Object.assign(vi.fn(), { error: vi.fn() }) }));
const { canOpenAttachment, openAttachment } = await import("./attachments");

/** what the store holds: a file whose declared type is the message's, not to be trusted */
function stored(filename: string, mime: string, data = new Uint8Array([1, 2, 3])) {
  const ref = { assetId: "00000000-0000-4000-8000-000000000001", filename, mime, size: data.length, contentId: null };
  call.mockImplementation(async (method: string) => {
    if (method === "attachments.info") return ref;
    if (method === "attachments.read") return { dataBase64: bytesBase64(data) };
    throw new Error(method);
  });
  return ref;
}

/** a tab as `window.open` gives one */
function tab() {
  return { opener: {} as unknown, closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }), location: { replace: vi.fn() } };
}

const created: Blob[] = [];
const revoked: string[] = [];
let opened: ReturnType<typeof tab>[];
let anchors: { download: string }[];
/** unique across tests: the module keeps its last few URLs from one test to the next */
let urls = 0;

beforeEach(() => {
  opened = [];
  anchors = [];
  created.length = 0;
  revoked.length = 0;
  vi.stubGlobal("window", { open: vi.fn(() => { const t = tab(); opened.push(t); return t; }) });
  vi.stubGlobal("document", { createElement: () => { const a = { href: "", download: "", click: vi.fn() }; anchors.push(a); return a; } });
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { created.push(blob as Blob); return `blob:test/${urls++}`; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => { revoked.push(url); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); call.mockReset(); });

describe("openAttachment on the web (plan 212)", () => {
  it("opens a PDF or an image in a tab, reserved before anything is awaited, with its opener cleared", async () => {
    const ref = stored("scan.PDF", "application/pdf");
    const work = openAttachment(1, ref);
    // synchronously, inside the click
    expect(opened).toHaveLength(1);
    expect(opened[0]!.opener).toBeNull();
    expect(await work).toBe("opened");
    expect(opened[0]!.location.replace).toHaveBeenCalledWith(expect.stringMatching(/^blob:test\//));
    expect(created[0]!.type).toBe("application/pdf");
    expect([...new Uint8Array(await created[0]!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("gives the blob the extension's type, never the message's", async () => {
    const ref = stored("photo.png", "text/html");
    await openAttachment(1, ref);
    expect(created[0]!.type).toBe("image/png");
  });

  it("downloads instead when the tab is blocked", async () => {
    window.open = vi.fn(() => null);
    const ref = stored("scan.pdf", "application/pdf");
    expect(await openAttachment(1, ref)).toBe("downloaded");
    expect(anchors.map((a) => a.download)).toEqual(["scan.pdf"]);
  });

  it("does nothing more when the tab was closed before the bytes came", async () => {
    const ref = stored("scan.pdf", "application/pdf");
    const work = openAttachment(1, ref);
    opened[0]!.closed = true;
    expect(await work).toBe("opened");
    expect(opened[0]!.location.replace).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("closes the tab and says what to do when the bytes can't be read", async () => {
    const ref = stored("scan.pdf", "application/pdf");
    call.mockImplementation(async (method: string) => (method === "attachments.info" ? { ...ref, size: 99 } : { dataBase64: null }));
    await expect(openAttachment(1, ref)).rejects.toThrow("Couldn’t open scan.pdf.");
    expect(opened[0]!.close).toHaveBeenCalled();
  });

  it("keeps the last three preview URLs, revoking the oldest", async () => {
    const ref = stored("scan.pdf", "application/pdf");
    const first = urls;
    for (let i = 0; i < 5; i++) await openAttachment(1, ref);
    const mine = Array.from({ length: 5 }, (_, i) => `blob:test/${first + i}`);
    expect(revoked.slice(-2)).toEqual(mine.slice(0, 2));
    for (const url of mine.slice(2)) expect(revoked).not.toContain(url);
  });

  it("opens only what a browser shows itself", () => {
    expect(canOpenAttachment("a.pdf")).toBe(true);
    expect(canOpenAttachment("a.jpeg")).toBe(true);
    for (const name of ["a.svg", "a.html", "a.docx", "a.heic", "a.fig"]) expect(canOpenAttachment(name), name).toBe(false);
  });
});

describe("openAttachment on desktop (plan 212)", () => {
  it("follows the bridge: none, and nothing opens; with it, the OS's documents do", () => {
    vi.stubGlobal("window", { ternoDesktop: {} });
    expect(canOpenAttachment("a.pdf")).toBe(false);
    vi.stubGlobal("window", { ternoDesktop: { openAttachment: vi.fn() } });
    expect(canOpenAttachment("a.pdf")).toBe(true);
    expect(canOpenAttachment("a.docx")).toBe(true);
    expect(canOpenAttachment("a.command")).toBe(false);
  });

  it("hands main the name and the bytes, and says what to do when it couldn't open them", async () => {
    const open = vi.fn(async () => ({ status: "opened" as const }));
    vi.stubGlobal("window", { ternoDesktop: { openAttachment: open } });
    const ref = stored("scan.pdf", "application/pdf");
    expect(await openAttachment(1, ref)).toBe("opened");
    const [name, bytes] = open.mock.calls[0]! as unknown as [string, ArrayBuffer];
    expect(name).toBe("scan.pdf");
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    open.mockResolvedValueOnce({ status: "busy" } as never);
    expect(await openAttachment(1, ref)).toBe("busy");
    open.mockResolvedValueOnce({ status: "failed" } as never);
    await expect(openAttachment(1, ref)).rejects.toThrow("Couldn’t open scan.pdf");
    open.mockRejectedValueOnce(new Error("ipc") as never);
    await expect(openAttachment(1, ref)).rejects.toThrow("Couldn’t open scan.pdf");
  });
});

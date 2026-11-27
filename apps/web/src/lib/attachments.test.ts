import { afterEach, expect, it, vi } from "vitest";
const { call, error } = vi.hoisted(() => ({ call: vi.fn(), error: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
vi.mock("./snack", () => ({ snack: Object.assign(vi.fn(), { error }) }));
const { attachFiles, attachmentUploading } = await import("./attachments");
const { createDraft, discardDraft, editDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { setApp } = await import("~/state/app");

afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); call.mockReset(); error.mockReset(); });

function upload() {
  setApp({ accounts: [{ id: 1 } as import("@terno/core").Account] });
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const sealing = new Promise<void>((r) => { reached = r; });
  const ref = { assetId: "00000000-0000-4000-8000-000000000001", filename: "binary.bin", mime: "application/octet-stream", size: 3, contentId: null };
  call.mockImplementation(async (method: string) => {
    if (method === "attachments.create") return ref;
    if (method === "attachments.seal") { reached(); await gate; }
    return { ok: true };
  });
  setDraftTransport(async () => ({ id: 1, revision: 1 }));
  const key = createDraft(newFields(1));
  const work = attachFiles(key, [new File([new Uint8Array([0,255,128])], "binary.bin", { type: "application/octet-stream" })]);
  return { key, work, sealing, release, ref };
}

it("a late upload after discard never resurrects a draft or attaches to its replacement", async () => {
  const u = upload();
  await u.sealing;
  expect(attachmentUploading(u.key)).toBe(true);
  await discardDraft(u.key);
  const replacement = createDraft(newFields(1));
  u.release(); await u.work;
  expect(useDrafts.getState().drafts[u.key]).toBeUndefined();
  expect(useDrafts.getState().drafts[replacement]!.attachments).toBeUndefined();
  expect(call).toHaveBeenCalledWith("attachments.discard", { accountId: 1, assetId: u.ref.assetId });
  expect(attachmentUploading(u.key)).toBe(false);
});

it("an account switch fences a pending upload and its cleanup stays bound to the original account", async () => {
  const u = upload();
  await u.sealing;
  editDraft(u.key, { accountId: 2, bodyText: "keep this edit" });
  u.release(); await u.work;
  expect(useDrafts.getState().drafts[u.key]).toMatchObject({ accountId: 2, bodyText: "keep this edit" });
  expect(useDrafts.getState().drafts[u.key]!.attachments).toBeUndefined();
  expect(call).toHaveBeenCalledWith("attachments.discard", { accountId: 1, assetId: u.ref.assetId });
});

it("plan 293 (CASA 5.2.1): a Gmail draft leaves out what Gmail won't send, says so plainly, and attaches the rest; IMAP attaches both", async () => {
  const files = () => [
    new File([new Uint8Array([0x4d, 0x5a, 0x90, 0])], "setup.exe", { type: "application/octet-stream" }),
    new File([new TextEncoder().encode("%PDF-1.7")], "report.pdf", { type: "application/pdf" }),
  ];
  const created: string[] = [];
  call.mockImplementation(async (method: string, p: { filename?: string }) => {
    if (method === "attachments.create") return (created.push(p.filename!), { assetId: `00000000-0000-4000-8000-00000000000${created.length}`, filename: p.filename, mime: "application/octet-stream", size: 4, contentId: null });
    return { ok: true };
  });
  setDraftTransport(async () => ({ id: 1, revision: 1 }));
  setApp({ accounts: [{ id: 1, kind: "gmail" } as import("@terno/core").Account, { id: 2, kind: "imap" } as import("@terno/core").Account] });
  const gmail = createDraft(newFields(1));
  expect(await attachFiles(gmail, files())).toBe(true);
  expect(error).toHaveBeenCalledWith("Gmail won’t send setup.exe: it doesn’t allow .exe files.");
  expect(created).toEqual(["report.pdf"]);
  expect(useDrafts.getState().drafts[gmail]!.attachments!.map((a) => a.filename)).toEqual(["report.pdf"]);
  // a renamed program is caught by its content
  error.mockReset();
  expect(await attachFiles(gmail, [new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46])], "photo.jpg")])).toBe(false);
  expect(error).toHaveBeenCalledWith("Gmail won’t send photo.jpg: it doesn’t allow programs.");
  created.length = 0;
  error.mockReset();
  const imap = createDraft(newFields(2));
  expect(await attachFiles(imap, files())).toBe(true);
  expect(error).not.toHaveBeenCalled();
  expect(created).toEqual(["setup.exe", "report.pdf"]);
});

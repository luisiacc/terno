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

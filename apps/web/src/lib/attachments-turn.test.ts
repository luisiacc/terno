import { afterEach, expect, it, vi } from "vitest";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
vi.mock("./snack", () => ({ snack: Object.assign(vi.fn(), { error: vi.fn() }) }));
const { attachFilesInTurn, attachmentUploading } = await import("./attachments");
const { createDraft, draftWorkPending, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { setApp } = await import("~/state/app");

afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); call.mockReset(); });

it("a drop is draft work, and holds Send, from the moment it lands: while its image is still being prepared (plan 76, Codex review)", async () => {
  setApp({ accounts: [{ id: 1 } as import("@terno/core").Account] });
  call.mockImplementation(async (method: string) => (method === "attachments.create" ? { assetId: "00000000-0000-4000-8000-000000000002", filename: "a.png", mime: "image/png", size: 1, contentId: null } : { ok: true }));
  setDraftTransport(async () => ({ id: 1, revision: 1 }));
  const key = createDraft(newFields(1));
  let prepared!: (v: { files: File[] }) => void;
  const work = attachFilesInTurn(key, new Promise((r) => { prepared = r; }));
  // nothing staged yet: a quit or a store switch still waits, and Send refuses
  expect(draftWorkPending()).toBe(true);
  expect(attachmentUploading(key)).toBe(true);
  prepared({ files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] });
  expect(await work).toBe(true);
  await vi.waitFor(() => expect(attachmentUploading(key)).toBe(false));
  expect(draftWorkPending()).toBe(false);
});

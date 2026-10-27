import { afterEach, expect, it, vi } from "vitest";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc } }));
const { attachFiles } = await import("~/lib/attachments");
const { acquireDraftHold, beginDraftWork, createDraft, draftEditsHeld, draftWorkPending, draftsSaved, editDraft, forgetDraft, setDraftTransport, useDrafts } = await import("~/lib/drafts");
const { newFields } = await import("~/lib/compose-fields");
const { whenDraftsSaved } = await import("./reload");
const { setApp } = await import("~/state/app");
import type { Account } from "@terno/core";
const account: Account = { id: 1, kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", signature: "", color: "blue", senderName: "Synthetic", syncWindowDays: null, syncState: { status: "idle", syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null } };
afterEach(() => { for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); rpc.mockReset(); });
function setup() {
  setApp({ accounts: [account] });
  setDraftTransport(async (_m, p) => ({ ...(p as object), id: 10, generation: "original", revision: 1 }));
  const key = createDraft(newFields(1)); editDraft(key, { bodyText: "exact saved", bodyHtml: "<div><b>exact saved</b></div>" }); return key;
}
it("default web admission retains accepted files until seal/adoption and exact save settle", async () => {
  const key = setup(); await draftsSaved();
  let finish!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => { finish = r; }), waiting = new Promise<void>((r) => { reached = r; });
  rpc.mockImplementation(async (method: string) => {
    if (method === "attachments.create") return { assetId: "file", filename: "selected.bin", mime: "application/octet-stream", size: 1 };
    if (method === "attachments.seal") { reached(); await gate; }
    return { ok: true };
  });
  const upload = attachFiles(key, [new File([new Uint8Array([255])], "selected.bin")]); await waiting;
  expect(draftWorkPending()).toBe(true); expect(useDrafts.getState().drafts[key]!.attachments).toBeUndefined();
  const go = vi.fn(); const admitted = await whenDraftsSaved(go);
  finish(); await upload;
  expect(useDrafts.getState().drafts[key]!).toMatchObject({ bodyText: "exact saved", attachments: [{ assetId: "file", filename: "selected.bin", size: 1 }] });
  expect(admitted).toBe(false); expect(go).not.toHaveBeenCalled();
  expect(await whenDraftsSaved(go)).toBe(true); expect(go).toHaveBeenCalledTimes(1);
});
it("pending composition refuses admission, including work that finishes during the save await", async () => {
  setup(); await draftsSaved();
  const finish = beginDraftWork()!;
  const checking = draftsSaved(); finish();
  expect(await checking).toBe(false);
  expect(await draftsSaved()).toBe(true);
});
it("the default guard owns edit admission through its asynchronous commit", async () => {
  setup(); await draftsSaved();
  let finish!: () => void, reached!: () => void;
  const commit = new Promise<void>((r) => { finish = r; }), waiting = new Promise<void>((r) => { reached = r; });
  const pending = whenDraftsSaved(async () => { reached(); await commit; }); await waiting;
  const work = beginDraftWork(); work?.();
  expect(draftEditsHeld()).toBe(true); expect(work).toBeNull();
  finish(); expect(await pending).toBe(true); expect(draftEditsHeld()).toBe(false);
  const held = acquireDraftHold(); held!();
});

it("the save barrier rejects new editing/async intent before its final acknowledgement", async () => {
  const key = setup();
  let finish!: (value: object) => void, reached!: () => void;
  const waiting = new Promise<void>((r) => { reached = r; });
  let fields: object = {};
  setDraftTransport((_m, p) => { fields = p as object; reached(); return new Promise((r) => { finish = r; }); });
  const go = vi.fn(), transition = whenDraftsSaved(go); await waiting;
  expect(beginDraftWork()).toBeNull(); expect(editDraft(key, { bodyText: "unaccepted edit" })).toBe(false);
  expect(go).not.toHaveBeenCalled(); finish({ ...fields, id: 10, generation: "ack", revision: 1 });
  expect(await transition).toBe(true); expect(go).toHaveBeenCalledTimes(1); expect(draftEditsHeld()).toBe(false);
});

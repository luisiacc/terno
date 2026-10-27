import { expect, it, vi } from "vitest";
import { attachBody, createDraft, editDraft, flushDraft, forgetDraft, materialize, retryDraft, setDraftTransport, useDrafts } from "./drafts";
import { newFields } from "./compose-fields";

it.each([false, true])("does not automatically reread a failed body after an older save rejects (saved=%s)", async (saved) => {
  vi.useFakeTimers();
  const key = createDraft(newFields(1));
  let reject!: (error: Error) => void, reads = 0, failing = false, calls = 0;
  let latest = "first";
  const pending = new Promise<unknown>((_resolve, fail) => { reject = fail; });
  setDraftTransport(async (_method, params) => {
    calls++;
    if (saved && calls === 1) return { ...params as object, id: 7, generation: "stable", revision: 1, updatedAt: 0 };
    if (calls === (saved ? 2 : 1)) return pending;
    return { ...params as object, id: 7, generation: "stable", revision: saved ? 2 : 1, updatedAt: 0 };
  });
  const source = attachBody(key, () => { reads++; if (failing) throw new Error("reader failed"); return { text: latest, html: `<p>${latest}</p>` }; });
  let saving: Promise<void> | undefined;
  try {
    editDraft(key, { bodyText: "authored" });
    if (saved) await flushDraft(key);
    editDraft(key, { subject: "pending", subjectEdited: true });
    saving = flushDraft(key);
    expect(calls).toBe(saved ? 2 : 1);
    const before = useDrafts.getState().drafts[key]!;
    latest = "newer unread"; source.changed(); failing = true;
    expect(() => materialize(key)).toThrow("reader failed");
    const failedReads = reads;
    reject(new Error("offline")); await saving;
    await vi.advanceTimersByTimeAsync(6000);
    expect(reads).toBe(failedReads);
    expect(calls).toBe(saved ? 2 : 1);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ key, id: before.id, revision: before.revision, status: "error" });
    expect(useDrafts.getState().drafts[key]!.generation).toBe(before.generation);
    failing = false; retryDraft(key); await flushDraft(key);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "newer unread", bodyHtml: "<p>newer unread</p>", status: "saved" });
  } finally { reject(new Error("cleanup")); await saving; source.dispose(); forgetDraft(key); setDraftTransport(async () => null); vi.useRealTimers(); }
});

it("retries a transport failure when the current editor source is healthy", async () => {
  vi.useFakeTimers();
  const key = createDraft(newFields(1)); let calls = 0;
  setDraftTransport(async (_method, params) => { if (++calls === 1) throw new Error("offline"); return { ...params as object, id: 8, generation: "stable", revision: 1, updatedAt: 0 }; });
  const source = attachBody(key, () => ({ text: "healthy", html: "<p>healthy</p>" }));
  try { source.changed(); await flushDraft(key); await vi.advanceTimersByTimeAsync(1000); expect(calls).toBe(2); expect(useDrafts.getState().drafts[key]).toMatchObject({ status: "saved", bodyText: "healthy" }); }
  finally { source.dispose(); forgetDraft(key); setDraftTransport(async () => null); vi.useRealTimers(); }
});

it("keeps a successor editor's autosave deadline during an older rejection notification", async () => {
  vi.useFakeTimers();
  const key = createDraft(newFields(1)); let calls = 0, reject!: (error: Error) => void;
  const pending = new Promise<unknown>((_resolve, fail) => { reject = fail; });
  setDraftTransport(async (_method, params) => { if (++calls === 1) return pending; return { ...params as object, id: 9, generation: "stable", revision: 1, updatedAt: 0 }; });
  const original = attachBody(key, () => ({ text: "old", html: "<p>old</p>" }));
  let replacement: ReturnType<typeof attachBody> | undefined, stop = () => {};
  try {
    original.changed(); retryDraft(key); expect(calls).toBe(1);
    stop = useDrafts.subscribe((state, previous) => {
      if (state.drafts[key]?.status === "error" && previous.drafts[key]?.status === "saving") {
        stop(); replacement = attachBody(key, () => ({ text: "new editor", html: "<p>new editor</p>" })); replacement.changed();
      }
    });
    reject(new Error("offline")); await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toBe(2);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ status: "saved", bodyText: "new editor", bodyHtml: "<p>new editor</p>" });
  } finally { stop(); reject(new Error("cleanup")); await Promise.resolve(); original.dispose(); replacement?.dispose(); forgetDraft(key); setDraftTransport(async () => null); vi.useRealTimers(); }
});

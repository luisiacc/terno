import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DraftFlushRequests } from "../../../desktop/src/draft-flush";
import { NativeReloads, nativeReloadKey, type ReloadEvents } from "../../../desktop/src/native-reload";
vi.mock("~/rpc/connection", () => ({ client: {} }));
const { acquireDraftHold, beginDraftWork, copyDraft, createDraft, draftEditsHeld, draftsSaved, editDraft, flushDraft, forgetDraft, markDraftMissing, setDraftTransport, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const close of cleanups.splice(0)) close(); for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key); vi.useRealTimers(); });
const tick = () => vi.advanceTimersByTimeAsync(0);

it("native refresh chords distinguish ordinary cache bypass from unrelated editing keys", () => {
  const key = { type: "keyDown", key: "r", alt: false, meta: true, control: false, shift: false };
  expect(nativeReloadKey(key, "darwin")).toBe(false); expect(nativeReloadKey({ ...key, shift: true }, "darwin")).toBe(true);
  expect(nativeReloadKey({ ...key, type: "keyUp" }, "darwin")).toBeNull(); expect(nativeReloadKey({ ...key, alt: true }, "darwin")).toBeNull();
  expect(nativeReloadKey({ ...key, meta: false, control: true }, "darwin")).toBeNull();
  expect(nativeReloadKey({ ...key, meta: false, control: true }, "win32")).toBe(false);
  expect(nativeReloadKey({ ...key, control: true }, "darwin")).toBeNull(); expect(nativeReloadKey({ ...key, control: true }, "linux")).toBeNull();
  expect(nativeReloadKey({ ...key, type: "char" }, "darwin")).toBeNull(); expect(nativeReloadKey({ ...key, key: "p" }, "darwin")).toBeNull();
});

it("stopping a DevTools provisional reload restores only the uncommitted document and never revives its old ACK", async () => {
  const target = { id: 1, isDestroyed: () => false, send: vi.fn() }, flushes = new DraftFlushRequests();
  flushes.ready(target, "old"); const old = flushes.request(target, true);
  flushes.navigating(target); expect(await old.saved).toBe(false); expect(flushes.isReady(target)).toBe(false);
  expect(flushes.resumeStopped(target)).toBe(true); expect(flushes.isReady(target)).toBe(true); expect(old.current()).toBe(false);
  const fresh = flushes.request(target, true); let acknowledged = false; void fresh.saved.then(() => { acknowledged = true; });
  flushes.answer(target, old.id, true, "old"); await Promise.resolve(); expect(acknowledged).toBe(false);
  flushes.answer(target, fresh.id, true, "old"); expect(await fresh.saved).toBe(true); old.release(); fresh.release();
  flushes.navigating(target); flushes.committed(target); expect(flushes.resumeStopped(target)).toBe(false);
  flushes.ready(target, "new"); flushes.destroyed(target); expect(flushes.resumeStopped(target)).toBe(false);
});

function harness() {
  const flushes = new DraftFlushRequests(), events = new Map<Target, ReloadEvents>(), warnings: { target: Target; id: number }[] = [];
  let running = true, action = "navigate", calls = 0, stopped = 0;
  class Target {
    document: string;
    gone = false;
    gate: Promise<void> = Promise.resolve();
    leases = new Map<number, () => void>();
    constructor(readonly id: number) { this.document = `document-${id}`; flushes.ready(this, this.document); }
    isDestroyed() { return this.gone; }
    send(channel: string, ...args: unknown[]) {
      const [id, hold, document] = args;
      if (channel === "terno:flush-release") { if (hold === this.document) { this.leases.get(Number(id))?.(); this.leases.delete(Number(id)); } return; }
      if (channel !== "terno:flush-drafts" || document !== this.document) return;
      if (hold) {
        const release = acquireDraftHold();
        if (!release) { flushes.answer(this, id, false, this.document); return; }
        this.leases.set(Number(id), release);
      }
      const token = this.document;
      void this.gate.then(() => draftsSaved()).then((saved) => flushes.answer(this, id, saved, token));
    }
    unload() { for (const release of this.leases.values()) release(); this.leases.clear(); }
  }
  const native = new NativeReloads<Target>({
    allowed: (target) => running && !target.gone,
    ready: (target) => flushes.isReady(target), flush: (target) => flushes.request(target, true),
    watch: (target, handlers) => { events.set(target, handlers); return () => { events.delete(target); }; },
    reload: (target) => { calls++; if (action === "throw") throw new Error("synthetic navigation"); if (action === "navigate") navigate(target); },
    stop: () => { stopped++; },
    warn: (target, id) => warnings.push({ target, id }),
  });
  const first = new Target(1), second = new Target(2);
  function navigate(target: Target) { flushes.navigating(target); native.navigating(target); events.get(target)?.navigating(); }
  function commit(target: Target) { flushes.committed(target); events.get(target)?.committed(); target.unload(); target.document += "-next"; flushes.ready(target, target.document); }
  function fail(target: Target) { events.get(target)?.failed(); }
  function destroy(target: Target) { target.gone = true; events.get(target)?.destroyed(); native.cancel(target); flushes.destroyed(target); target.unload(); }
  cleanups.push(() => { native.cancelAll(); first.unload(); second.unload(); });
  return { native, flushes, first, second, navigate, commit, fail, destroy, warnings, calls: () => calls, stopped: () => stopped, action: (next: string) => { action = next; }, quit: () => { running = false; native.cancelAll(); } };
}
async function savedDraft() {
  setDraftTransport(async (_method, p) => ({ ...(p as object), id: 10, generation: "original", revision: 1 }));
  const key = createDraft(newFields(1)); editDraft(key, { bodyText: "exact saved", bodyHtml: "<div><b>exact saved</b></div>" }); await flushDraft(key); return key;
}

it.each(["missing", "unknown"] as const)("native reload retains %s work, releases before disclosure, then admits an acknowledged safe copy", async (state) => {
  const h = harness(), key = await savedDraft(); markDraftMissing(key);
  editDraft(key, { bodyText: "latest retained", toText: '"Pérez, Ana" <ana@example.test>, bob@' });
  if (state === "unknown") { setDraftTransport(async () => { throw { code: "TIMEOUT" }; }); await copyDraft(key); }
  expect(await h.native.request(h.first)).toBe(false); expect(h.calls()).toBe(0); expect(draftEditsHeld()).toBe(false);
  expect(h.warnings).toEqual([{ target: h.first, id: expect.any(Number) }]);
  expect(useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "latest retained", recovery: { state }, toText: '"Pérez, Ana" <ana@example.test>, bob@' });
  setDraftTransport(async (_method, p) => ({ ...(p as object), id: 11, generation: "copy", revision: 1 })); await copyDraft(key);
  const reload = h.native.request(h.first); await tick(); expect(h.calls()).toBe(1); expect(draftEditsHeld()).toBe(true);
  h.commit(h.first); expect(await reload).toBe(true);
});

it("native ACK is deduplicated and bound to its captured target through delayed document commit", async () => {
  const h = harness(), key = await savedDraft(); let acknowledge!: () => void;
  h.first.gate = new Promise((r) => { acknowledge = r; });
  const request = h.native.request(h.first); expect(h.native.request(h.first, true)).toBe(request);
  expect(editDraft(key, { bodyText: "unaccepted later edit" })).toBe(false); expect(beginDraftWork()).toBeNull();
  acknowledge(); await tick(); expect(h.calls()).toBe(1);
  expect(h.flushes.isReady(h.first)).toBe(false); expect(h.flushes.isReady(h.second)).toBe(true);
  expect(draftEditsHeld()).toBe(true); expect(editDraft(key, { bodyText: "during navigation" })).toBe(false);
  h.commit(h.first); expect(await request).toBe(true); expect(draftEditsHeld()).toBe(false);
  expect(useDrafts.getState().drafts[key]!.bodyText).toBe("exact saved");
});

it.each(["timeout", "navigate", "destroy", "quit"] as const)("a pending ACK releases its own lease on %s and cannot reload after a late acknowledgement", async (outcome) => {
  const h = harness(); await savedDraft(); let acknowledge!: () => void;
  h.first.gate = new Promise((r) => { acknowledge = r; }); const request = h.native.request(h.first);
  if (outcome === "timeout") await vi.advanceTimersByTimeAsync(5000);
  if (outcome === "navigate") h.navigate(h.first);
  if (outcome === "destroy") h.destroy(h.first);
  if (outcome === "quit") h.quit();
  expect(await request).toBe(false); expect(draftEditsHeld()).toBe(false);
  acknowledge(); await tick(); expect(h.calls()).toBe(0);
});

it.each(["throw", "noop", "failed"] as const)("failed/no-op navigation %s restores editing and the still-live old document's admission", async (outcome) => {
  const h = harness(), key = await savedDraft(); h.action(outcome === "failed" ? "navigate" : outcome);
  const request = h.native.request(h.first); await tick();
  if (outcome === "noop") await vi.advanceTimersByTimeAsync(5000);
  if (outcome === "failed") h.fail(h.first);
  expect(await request).toBe(false); expect(draftEditsHeld()).toBe(false); expect(h.flushes.isReady(h.first)).toBe(true);
  expect(editDraft(key, { bodyText: "editing restored" })).toBe(true);
});

it("accepted pending work refuses native admission without cancelling it", async () => {
  const h = harness(); await savedDraft(); const finish = beginDraftWork()!;
  expect(await h.native.request(h.first)).toBe(false); expect(h.calls()).toBe(0); expect(draftEditsHeld()).toBe(false); finish();
});

it("quitting cancels a provisional reload before releasing its lease or starting a new shutdown owner", async () => {
  const h = harness(); await savedDraft(); const reload = h.native.request(h.first); await tick();
  expect(draftEditsHeld()).toBe(true); h.quit(); expect(h.stopped()).toBe(1);
  expect(await reload).toBe(false); expect(h.flushes.isReady(h.first)).toBe(true);
  const shutdown = h.flushes.request(h.first, true); await shutdown.saved;
  expect(draftEditsHeld()).toBe(true); shutdown.release(); expect(draftEditsHeld()).toBe(false);
});

it("only the exact current disclosed refusal can be consumed once; new attempts, navigation and quit invalidate it", async () => {
  const h = harness(), key = await savedDraft(); markDraftMissing(key);
  await h.native.request(h.first); const id = h.warnings[0]!.id;
  expect(h.native.force(h.second, id)).toBe(false); expect(h.native.force(h.first, "malformed")).toBe(false);
  await h.native.request(h.first); expect(h.native.force(h.first, id)).toBe(false);
  const next = h.warnings.at(-1)!.id; expect(h.native.force(h.first, next)).toBe(true); expect(h.native.force(h.first, next)).toBe(false);
  expect(h.calls()).toBe(1); expect(draftEditsHeld()).toBe(false);
  h.flushes.committed(h.first); h.first.document += "-replacement"; h.flushes.ready(h.first, h.first.document);
  await h.native.request(h.first); const replacement = h.warnings.at(-1)!.id; h.quit(); expect(h.native.force(h.first, replacement)).toBe(false);
});

it("shutdown recovery releases only its batch and late old document ACKs cannot settle a new native request", async () => {
  const h = harness(); await savedDraft(); h.action("noop");
  const native = h.native.request(h.first); await tick(); const shutdown = h.flushes.request(h.second, true); await shutdown.saved;
  shutdown.release(); expect(draftEditsHeld()).toBe(true);
  h.navigate(h.first); h.fail(h.first); expect(await native).toBe(false); expect(draftEditsHeld()).toBe(false);
  h.flushes.committed(h.first); h.first.document = "new-document"; h.flushes.ready(h.first, h.first.document);
  h.first.gate = new Promise(() => {}); const later = h.native.request(h.first);
  h.flushes.answer(h.first, 1, true, "document-1"); await tick(); expect(h.calls()).toBe(1); expect(draftEditsHeld()).toBe(true);
  h.native.cancel(h.first); expect(await later).toBe(false); expect(draftEditsHeld()).toBe(false);
});

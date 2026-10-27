import { afterEach, expect, it, vi } from "vitest";
import { coordinateShutdown } from "../../../desktop/src/shutdown";
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("test transport only")) } }));
const { acquireDraftHold, beginDraftWork, createDraft, draftsSaved, editDraft, forgetDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
afterEach(() => { for (const k of Object.keys(useDrafts.getState().drafts)) forgetDraft(k); });

it.each(["closed", "sending", "timeout"] as const)("saved ACK holds editing/creation throughout backend drain and releases on %s", async (outcome) => {
  setDraftTransport(async (_m, p) => ({ ...(p as object), id: 10, revision: 1 }));
  const key = createDraft(newFields(1)); editDraft(key, { bodyText: "exact saved" }); await draftsSaved();
  let finish!: (result: "closed" | "sending") => void, reached!: () => void;
  const draining = new Promise<void>((r) => { reached = r; });
  let release = () => {};
  const done = coordinateShutdown({
    flushWindows: (hold = false) => {
      if (hold) { const lease = acquireDraftHold(); if (!lease) return [Promise.resolve(false)]; release = lease; }
      return [draftsSaved()];
    },
    releaseWindows: () => release(),
    shutdownBackend: () => { reached(); return new Promise((r) => { finish = r; }); },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }, { force: false, sendDeadlineMs: 10, graceMs: 5 });
  await draining;
  editDraft(key, { bodyText: "late work" });
  expect(useDrafts.getState().drafts[key]!.bodyText).toBe("exact saved");
  expect(() => createDraft(newFields(1))).toThrow();
  if (outcome !== "timeout") finish(outcome);
  expect((await done).outcome).toBe(outcome);
  if (outcome === "closed") release();
  editDraft(key, { bodyText: "editing restored" });
  expect(useDrafts.getState().drafts[key]!.bodyText).toBe("editing restored");
});

it("accepted asynchronous draft work defers closure and remains admissible until it settles", async () => {
  const finish = beginDraftWork(); expect(finish).toBeTypeOf("function");
  expect(acquireDraftHold()).toBeNull();
  const key = createDraft(newFields(1)); editDraft(key, { bodyText: "accepted work" });
  finish!(); const release = acquireDraftHold(); expect(release).toBeTypeOf("function"); release!();
});

it("a failed renderer ACK releases every matching lease and a late release cannot unlock a newer attempt", async () => {
  const old = acquireDraftHold()!; old(); const current = acquireDraftHold()!; old();
  expect(() => createDraft(newFields(1))).toThrow(); current();
  const release = vi.fn();
  const result = await coordinateShutdown({ flushWindows: () => [Promise.resolve(false)], releaseWindows: release, shutdownBackend: () => { throw new Error("must not close"); }, setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, { force: false });
  expect(result.outcome).toBe("unsaved"); expect(release).toHaveBeenCalledTimes(1);
});

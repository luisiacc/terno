// @vitest-environment jsdom
/**
 * Plan 115: pinning moves a draft to the card and back; unpinning away from
 * its conversation saves what was written, drops an untouched new message,
 * and never says "saved" for a save that didn't happen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.reject(new Error("not in tests")) } }));

const { createDraft, editDraft, setDraftTransport, useDrafts } = await import("./drafts");
const { newFields } = await import("./compose-fields");
const { pinDraft, unpinDraft } = await import("./pinned-draft");
const { usePinned } = await import("./pinned-draft-state");
const { useSnack, resetSnacks } = await import("./snack");
const { setApp } = await import("~/state/app");

let saves: number;
let fail: boolean;

beforeEach(() => {
  saves = 0;
  fail = false;
  useDrafts.setState({ drafts: {} });
  usePinned.setState({ key: null, threadId: null, inset: 0 });
  resetSnacks();
  setApp({ compose: null, selectedId: null, checked: new Set(), scope: null });
  setDraftTransport(async (method, params) => {
    if (method === "drafts.delete") return { ok: true };
    saves++;
    if (fail) throw new Error("disk full");
    const p = params as Record<string, unknown>;
    return { ...p, id: 1, revision: 1, generation: "g" };
  }, () => Date.now());
});
afterEach(() => vi.useRealTimers());

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("pinning", () => {
  it("lifts a new message out of the reader pane and keeps it pinned", () => {
    const key = createDraft(newFields(1));
    setApp({ compose: { key, seq: 1 } });
    expect(pinDraft(key)).toBe(true);
    expect(usePinned.getState().key).toBe(key);
    expect(usePinned.getState().threadId).toBeNull();
    // the reader pane lets go of it, without forgetting it (untouched or not)
    expect(useDrafts.getState().drafts[key]).toBeDefined();
  });

  it("pinning another draft puts the first one away", () => {
    const a = createDraft(newFields(1));
    const b = createDraft(newFields(1));
    pinDraft(a);
    pinDraft(b);
    expect(usePinned.getState().key).toBe(b);
    // a was untouched: it just went
    expect(useDrafts.getState().drafts[a]).toBeUndefined();
  });

  it("the card goes when its draft does", () => {
    const key = createDraft(newFields(1));
    pinDraft(key);
    useDrafts.setState({ drafts: {} });
    expect(usePinned.getState().key).toBeNull();
  });
});

describe("unpinning away from its conversation", () => {
  it("drops an untouched new message", async () => {
    const key = createDraft(newFields(1));
    pinDraft(key);
    unpinDraft(key, { focus: false });
    await settle();
    expect(useDrafts.getState().drafts[key]).toBeUndefined();
    expect(useSnack.getState().current).toBeNull();
  });

  it("saves what was written and says so, with Open", async () => {
    const key = createDraft(newFields(1));
    editDraft(key, { bodyText: "half a thought" });
    pinDraft(key);
    unpinDraft(key, { focus: false });
    await settle(); await settle();
    expect(saves).toBeGreaterThan(0);
    expect(useDrafts.getState().drafts[key]?.status).toBe("saved");
    expect(useSnack.getState().current?.message).toBe("Draft saved");
    expect(useSnack.getState().current?.action?.label).toBe("Open");
  });

  it("a save that failed is never called saved", async () => {
    fail = true;
    const key = createDraft(newFields(1));
    editDraft(key, { bodyText: "half a thought" });
    pinDraft(key);
    unpinDraft(key, { focus: false });
    await settle(); await settle();
    expect(useDrafts.getState().drafts[key]).toBeDefined();
    expect(useSnack.getState().current?.message).toBe("Draft kept, but not saved yet");
  });
});

// @vitest-environment jsdom
/** Plan 201: a link to an email opens its conversation at that message; a newer open or the user's own move wins. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => {
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return { answer: null as unknown, fail: false, gate: null as Promise<void> | null, calls: [] as unknown[] };
});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: async (method: string, params: unknown) => {
      rpc.calls.push({ method, params });
      if (rpc.gate) await rpc.gate;
      if (rpc.fail) throw new Error("connection lost");
      return rpc.answer;
    },
    on: () => () => {},
  },
}));
const seen = vi.hoisted(() => ({ opened: [] as number[], revealed: [] as number[], snacks: [] as { message: string; description?: string }[], leftDraft: 0, readerViewClosed: 0 }));
vi.mock("~/lib/page", () => ({ openThread: (id: number) => seen.opened.push(id) }));
vi.mock("~/lib/summaries", () => ({ revealSummaryMessage: (id: number) => seen.revealed.push(id) }));
vi.mock("~/lib/compose", () => ({ leaveNewDraft: () => seen.leftDraft++ }));
vi.mock("~/components/mail-reader-back", () => ({ returnFromMailReaderView: () => (seen.readerViewClosed++, false) }));
vi.mock("~/lib/snack", () => ({ snack: { error: (message: string, o?: { description?: string }) => seen.snacks.push({ message, description: o?.description }) } }));

const { openMailLink, supersedeMailLink } = await import("./mail-links");
const { focusIntent } = await import("./focus-intent");
const { getApp, markSelectionIntent, setApp } = await import("~/state/app");

beforeEach(() => {
  Object.assign(seen, { opened: [], revealed: [], snacks: [], leftDraft: 0, readerViewClosed: 0 });
  Object.assign(rpc, { answer: null, fail: false, gate: null, calls: [] });
  setApp({ dialog: null, compose: null, checked: new Set(), scope: null });
});

describe("opening a link", () => {
  it("looks the id up and opens that conversation at that message, closing what covers it", async () => {
    rpc.answer = { threadId: 7, messageId: 70 };
    setApp({ dialog: "settings", checked: new Set([1, 2]) });
    await openMailLink("a@b");
    expect(rpc.calls).toEqual([{ method: "links.resolve", params: { id: "a@b" } }]);
    expect(seen).toMatchObject({ opened: [7], revealed: [70], readerViewClosed: 1, snacks: [] });
    expect(getApp().dialog).toBeNull();
    expect(getApp().checked.size).toBe(0);
  });

  it("an email Terno doesn't have says so, and what it can be", async () => {
    await openMailLink("gone@x");
    expect(seen.opened).toEqual([]);
    expect(seen.snacks).toEqual([{ message: "That email isn't in Terno", description: "It may have been deleted, or it's in an account that isn't connected here." }]);
  });

  it("a lookup that fails isn't 'not found': it says to try again, and nothing moves", async () => {
    rpc.fail = true;
    setApp({ dialog: "settings" });
    await openMailLink("a@b");
    expect(seen.opened).toEqual([]);
    expect(getApp().dialog).toBe("settings");
    expect(seen.snacks).toEqual([{ message: "Couldn't open that email", description: "Terno couldn't reach your mailbox just now. Try the link again in a moment." }]);
  });

  it("yields to anything newer while it looks: another link, a notification's click, a selection, a key", async () => {
    const cases: [() => void, number[]][] = [
      [() => void openMailLink("newer@x"), [8]],
      [supersedeMailLink, []],
      [markSelectionIntent, []],
      [() => void focusIntent.seq++, []],
    ];
    for (const [newer, opened] of cases) {
      let release!: () => void;
      rpc.gate = new Promise((r) => (release = r));
      rpc.answer = { threadId: 7, messageId: 70 };
      const first = openMailLink("a@b");
      // the newer link's own lookup answers with its conversation
      rpc.answer = { threadId: 8, messageId: 80 };
      newer();
      release();
      await first;
      await new Promise((r) => setTimeout(r, 0));
      expect(seen.opened).toEqual(opened);
      expect(seen.snacks).toEqual([]);
      seen.opened = [];
      rpc.gate = null;
    }
  });
});

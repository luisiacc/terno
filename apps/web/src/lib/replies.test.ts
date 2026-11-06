// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const frames: (() => void)[] = [];
vi.stubGlobal("requestAnimationFrame", (run: () => void) => frames.push(run));
vi.stubGlobal("cancelAnimationFrame", () => void frames.splice(0));

const listeners = new Map<string, (e: unknown) => void>();
const call = vi.fn(async (method: string): Promise<unknown> => (method === "ai.prepareReply" ? { status: "started" } : { ok: true }));
vi.mock("~/rpc/connection", () => ({ client: { call, on: (name: string, l: (e: unknown) => void) => (listeners.set(name, l), () => {}), connectionVersion: 1 } }));
const detail = { thread: { id: 7, accountId: 1, waitingSince: Date.now() - 1000, inSpam: false, inTrash: false }, messages: [{ id: 1, from: { name: "Ana", email: "a@x.test" }, to: [], cc: [], isSent: false }] };
const useThreads = create<{ details: Map<number, typeof detail> }>(() => ({ details: new Map([[7, detail]]) }));
vi.mock("~/state/threads", () => ({ loadThread: async () => detail, useThreads, invalidateThreads: vi.fn() }));
vi.mock("~/lib/page", async (real) => ({ ...(await real<object>()), readerShown: () => true }));

const { replyReady, useReplies } = await import("./replies");
const { noteExplicitOpen } = await import("./open-dwell");
const { setApp } = await import("~/state/app");

const opened = async () => {
  setApp({ selectedId: 7, settings: { replies: { enabled: true } } as never, accounts: [{ email: "me@x.test" }] as never });
  noteExplicitOpen(7);
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith("ai.prepareReply", expect.anything()), { timeout: 2000 });
};

describe("what a window shows of a prepared reply (plan 144)", () => {
  beforeEach(() => {
    call.mockClear();
    frames.length = 0;
    useReplies.setState({ shown: null });
  });

  it("Plan 147: what Undo brought back isn't there for r and a with Dev mode's switch off", () => {
    useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Hola", row: {} as never } });
    setApp({ devAi: null, settings: { replies: { enabled: true } } as never });
    expect(replyReady(7)).toBe(true);
    setApp({ devAi: { anthropic: true, openai: false, jev: false }, settings: { replies: { enabled: true }, devAi: false } as never });
    expect(replyReady(7)).toBe(false);
    setApp({ devAi: null });
  });

  it("new mail during the stream ends it: the next word doesn't bring back what's out of date", async () => {
    await opened();
    const event = listeners.get("aiReply")!;
    event({ threadId: 7, phase: "writing", text: "Hola" });
    frames.splice(0).forEach((f) => f());
    expect(useReplies.getState().shown?.text).toBe("Hola");
    useThreads.setState({ details: new Map([[7, { ...detail, messages: [...detail.messages, { ...detail.messages[0]!, id: 2 }] }]]) });
    expect(useReplies.getState().shown).toBeNull();
    expect(call).toHaveBeenCalledWith("ai.replyLeave", { threadId: 7 });
    event({ threadId: 7, phase: "writing", text: "Hola Ana" });
    frames.splice(0).forEach((f) => f());
    expect(useReplies.getState().shown).toBeNull();
  });
});

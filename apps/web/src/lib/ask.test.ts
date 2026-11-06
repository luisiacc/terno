// @vitest-environment jsdom
/** Plan 141: what the renderer keeps of a conversation, and what ends it. The whole of it, in a page, is in e2e/ask.spec.ts. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskSourceRef, AskTurn } from "@terno/core";
import type { AiSettings } from "@terno/core/rpc";

const rpc = vi.hoisted(() => {
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return { calls: [] as { method: string; params: unknown }[], events: new Map<string, (payload: unknown) => void>(), answer: new Map<string, unknown>() };
});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => {
      rpc.calls.push({ method, params });
      return Promise.resolve(rpc.answer.has(method) ? rpc.answer.get(method) : { ok: true });
    },
    on: (event: string, listener: (payload: unknown) => void) => {
      rpc.events.set(event, listener);
      return () => {};
    },
  },
}));
const opened = vi.hoisted(() => ({ threads: [] as number[] }));
vi.mock("~/lib/page", () => ({ openThread: (id: number) => opened.threads.push(id), readerShown: () => true, listLayout: () => false }));

const { askConfigChanged, askQuestion, installAsk, openConversation, openSource, returning, useAsk } = await import("./ask");
const { askReady } = await import("./ai");
installAsk();

const source: AskSourceRef = { messageId: 5, threadId: 2, accountId: 1, fromName: "Ana", fromEmail: "a@x.test", subject: "S", date: 1 };
const turn = { id: 1, conversationId: 7, question: "q", answer: "a [1]", status: "answered", sources: [source], queries: [], kind: "question", model: "m", provider: "p", createdAt: 1, checks: { unlinked: false, unsupported: [] } } as AskTurn;
const showing = (over = {}) => useAsk.setState({ conversationId: 7, turns: [turn], sources: { 5: { state: "ok", threadId: 2 } }, running: null, armedSource: null, noProvider: false, usedAt: Date.now(), ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.answer.clear();
  opened.threads.length = 0;
});

describe("what's shown goes when what it quotes goes", () => {
  it("another window's delete, a clear, or the account's removal ends the conversation here", () => {
    showing();
    rpc.events.get("aiAskGone")!({ conversationIds: [99] });
    expect(useAsk.getState().turns).toHaveLength(1);
    rpc.events.get("aiAskGone")!({ conversationIds: [7] });
    expect(useAsk.getState().turns).toEqual([]);
    showing();
    rpc.events.get("aiAskGone")!({ conversationIds: null });
    expect(useAsk.getState().conversationId).toBeNull();
  });

  it("coming back reads it again: gone is gone, and what's there is as it is now", async () => {
    showing();
    rpc.answer.set("ai.askConversation", { turns: [turn], sources: { 5: { state: "trash", threadId: 2 } }, older: { kind: "offer", since: 1 } });
    returning();
    await flush();
    expect(useAsk.getState().sources[5]).toEqual({ state: "trash", threadId: 2 });
    expect(useAsk.getState().older.kind).toBe("offer");
    rpc.answer.set("ai.askConversation", null);
    returning();
    await flush();
    expect(useAsk.getState().conversationId).toBeNull();
  });
});

describe("a read that was under way when something went", () => {
  it("opening from the history doesn't bring back what was cleared meanwhile", async () => {
    showing({ conversationId: null, turns: [] });
    let answer!: (v: unknown) => void;
    rpc.answer.set("ai.askConversation", new Promise((r) => (answer = r)));
    const opening = openConversation(7);
    rpc.events.get("aiAskGone")!({ conversationIds: null });
    answer({ turns: [turn], sources: {}, older: { kind: "none" } });
    expect(await opening).toBe(false);
    expect(useAsk.getState().turns).toEqual([]);
  });
});

describe("a source opens as it is now", () => {
  it("in the thread it's in now, asked at the moment: a merge in another window counts", async () => {
    showing({ sources: { 5: { state: "ok", threadId: 2 } } });
    rpc.answer.set("ai.askSources", { 5: { state: "ok", threadId: 44 } });
    await openSource(source);
    expect(opened.threads).toEqual([44]);
  });

  it("moved to Spam in another window since it was shown: the first click only says so", async () => {
    showing({ sources: { 5: { state: "ok", threadId: 2 } } });
    rpc.answer.set("ai.askSources", { 5: { state: "spam", threadId: 2 } });
    await openSource(source);
    expect(opened.threads).toEqual([]);
    expect(useAsk.getState().armedSource).toBe(5);
  });

  it("one in Spam or Trash needs asking twice, however it's asked; one that's gone never opens", async () => {
    showing();
    rpc.answer.set("ai.askSources", { 5: { state: "spam", threadId: 2 } });
    await openSource(source);
    expect(opened.threads).toEqual([]);
    expect(useAsk.getState().armedSource).toBe(5);
    await openSource(source);
    expect(opened.threads).toEqual([2]);
    showing();
    rpc.answer.set("ai.askSources", { 5: { state: "gone" } });
    await openSource(source);
    expect(opened.threads).toEqual([2]);
  });
});

describe("where a question can go", () => {
  const ai = (over: Partial<AiSettings>) => ({ provider: "none", model: "", tasks: {}, keys: {}, hasKey: false, keyConfirmed: false, local: false, ...over }) as unknown as AiSettings;

  it("Ask's own target counts, whatever the main provider is", () => {
    expect(askReady(ai({}))).toBe(false);
    expect(askReady(ai({ tasks: { ask: { provider: "openai", model: "m" } } }))).toBe(false);
    expect(askReady(ai({ tasks: { ask: { provider: "openai", model: "m" } }, keys: { openai: { hasKey: true, keyHint: null } } }))).toBe(true);
    expect(askReady(ai({ tasks: { ask: { provider: "ollama", model: "m" } } }))).toBe(true);
  });

  it("a key added lifts what said it had nowhere to go", () => {
    showing({ noProvider: true });
    askConfigChanged();
    expect(useAsk.getState().noProvider).toBe(false);
  });

  it("Continue sends the destination that was read", () => {
    useAsk.setState({ running: null, conversationId: null, turns: [] });
    askQuestion("q", { acknowledge: "dest-a" });
    expect((rpc.calls.find((c) => c.method === "ai.ask")!.params as { acknowledge?: string }).acknowledge).toBe("dest-a");
  });
});

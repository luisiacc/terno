// @vitest-environment jsdom
/** Plan 165: the pinned answer (what it holds, where it goes, what ends it), and coming back to the same place in Ask. The page: e2e/ask-pin.spec.ts. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AskSourceRef, AskTurn } from "@terno/core";

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
const opened = vi.hoisted(() => ({ threads: [] as number[], asks: 0, leftDraft: 0 }));
vi.mock("~/lib/page", () => ({ openThread: (id: number) => opened.threads.push(id), readerShown: () => true, listLayout: () => false }));
vi.mock("~/lib/palette-open", () => ({ toggleAsk: () => void opened.asks++ }));
vi.mock("~/lib/compose", () => ({ leaveNewDraft: () => { opened.leftDraft++; setAppLater({ compose: null }); } }));
const setAppLater = (patch: object) => void import("~/state/app").then(({ setApp }) => setApp(patch));

const { askChosen, askPlace, forgetAsk, installAsk, keepAskPlace, markVisited, openSource, useAsk, useAskVisited } = await import("./ask");
const { closePinnedAnswer, openPinnedSource, pinAnswer, unpinAnswer } = await import("./pinned-ask");
const { CARD_GAP, pinnedAskPlace, usePinnedAsk } = await import("./pinned-ask-state");
const { useSnack } = await import("./snack");
const { getApp, setApp } = await import("~/state/app");
installAsk();

const source: AskSourceRef = { messageId: 5, threadId: 2, accountId: 1, fromName: "Ana", fromEmail: "a@x.test", subject: "S", date: 1 };
const turnOf = (id: number, conversationId = 7, over: Partial<AskTurn> = {}) => ({ id, conversationId, question: `q${id}`, answer: "a [1]", status: "answered", sources: [source], queries: [], kind: "question", model: "m", provider: "p", createdAt: 1, checks: { unlinked: false, unsupported: [] }, ...over }) as AskTurn;
const showing = (over = {}) => useAsk.setState({ conversationId: 7, turns: [turnOf(1)], sources: { 5: { state: "ok", threadId: 2 } }, running: null, armedSource: null, returnTo: null, noProvider: false, usedAt: Date.now(), ...over });
const flush = () => new Promise((r) => setTimeout(r, 0));
const visited = (conversationId: number) => useAskVisited.getState().byConversation.get(conversationId) ?? [];

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.answer.clear();
  opened.threads.length = 0;
  opened.asks = 0;
  opened.leftDraft = 0;
  setApp({ compose: null, checked: new Set(), scope: null });
  usePinnedAsk.setState({ pinned: null, collapsed: false, inset: 0 });
  forgetAsk();
  setApp({ dialog: null });
});

describe("where the card goes", () => {
  const pane = { width: 1000, height: 700 };

  it("alone: the corner, 24 rem at most, its height 60% of the pane at most", () => {
    expect(pinnedAskPlace(pane, null)).toMatchObject({ right: CARD_GAP, bottom: CARD_GAP, width: 384, maxHeight: 420, squeezed: false, where: "alone" });
    expect(pinnedAskPlace({ width: 300, height: 700 }, null).width).toBe(300 - CARD_GAP * 2);
  });

  it("with a pinned draft: to its left where the pane holds both and 20 rem for the card", () => {
    const place = pinnedAskPlace({ width: 1100, height: 800 }, { width: 512, inset: 400 });
    expect(place).toMatchObject({ where: "beside", right: CARD_GAP * 2 + 512, bottom: CARD_GAP, width: 384 });
    // what's left, down to 20 rem
    const tight = pinnedAskPlace({ width: 512 + 320 + 36, height: 800 }, { width: 512, inset: 400 });
    expect(tight).toMatchObject({ where: "beside", width: 320 });
    // never over the draft: its right edge a gap left of the draft's left
    expect(1100 - place.right).toBeLessThanOrEqual(1100 - CARD_GAP - 512 - CARD_GAP);
  });

  it("narrower: above the draft, as tall as the room left, and its header alone under 140 px", () => {
    const above = pinnedAskPlace({ width: 530, height: 650 }, { width: 506, inset: 400 });
    expect(above).toMatchObject({ where: "above", right: CARD_GAP, bottom: 400, maxHeight: 650 - 400 - CARD_GAP, squeezed: false });
    // the reader's toolbar stays clear, and over a draft it's 20 rem at most
    expect(pinnedAskPlace({ width: 530, height: 650 }, { width: 506, inset: 400 }, 0, 52).maxHeight).toBe(650 - 400 - 52 - CARD_GAP);
    expect(pinnedAskPlace({ width: 770, height: 900 }, { width: 512, inset: 300 }).maxHeight).toBe(320);
    const squeezed = pinnedAskPlace({ width: 530, height: 520 }, { width: 506, inset: 400 });
    expect(squeezed).toMatchObject({ where: "above", squeezed: true });
  });

  it("stands on the snack dock where they'd meet (the floor), and the room shrinks with it", () => {
    expect(pinnedAskPlace(pane, null, 80)).toMatchObject({ bottom: 80, maxHeight: 420 });
    expect(pinnedAskPlace({ width: 530, height: 650 }, { width: 506, inset: 400 }, 200).bottom).toBe(400);
    expect(pinnedAskPlace({ width: 530, height: 650 }, { width: 506, inset: 400 }, 450)).toMatchObject({ bottom: 450, maxHeight: 650 - 450 - CARD_GAP });
  });
});

describe("pinning an answer", () => {
  it("copies the answer showing and closes Ask; a follow-up or a new question in Ask leaves the card as it is", () => {
    showing();
    setApp({ dialog: "palette" });
    expect(pinAnswer()).toBe(true);
    expect(getApp().dialog).toBeNull();
    expect(usePinnedAsk.getState().pinned).toMatchObject({ conversationId: 7, turn: { id: 1 }, views: { 5: { state: "ok", threadId: 2 } } });
    useAsk.setState({ turns: [turnOf(1), turnOf(2)] });
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    expect(usePinnedAsk.getState().pinned?.turn.id).toBe(1);
  });

  it("only a finished answer: not while one is written, not a command's outcome, not before a conversation", () => {
    showing({ running: { requestId: "r", question: "q", text: "", chunks: [], older: null, searchingOlder: false } });
    expect(pinAnswer()).toBe(false);
    showing({ turns: [turnOf(1, 7, { kind: "command" })] });
    expect(pinAnswer()).toBe(false);
    showing({ conversationId: null, turns: [] });
    expect(pinAnswer()).toBe(false);
    expect(usePinnedAsk.getState().pinned).toBeNull();
  });

  it("a source on the card opens in the reader with no Back to the answer (the card is the way back), and is read", async () => {
    showing();
    pinAnswer();
    rpc.answer.set("ai.askSources", { 5: { state: "ok", threadId: 2 } });
    openPinnedSource(source);
    await flush();
    expect(opened.threads).toEqual([2]);
    expect(useAsk.getState().returnTo).toBeNull();
    expect(visited(7)).toEqual([5]);
    expect(usePinnedAsk.getState().pinned).not.toBeNull();
  });

  it("a source of the pinned answer is read in its own conversation, whichever Ask holds now", async () => {
    showing();
    pinAnswer();
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    rpc.answer.set("ai.askSources", { 5: { state: "ok", threadId: 2 } });
    openPinnedSource(source);
    await flush();
    expect(visited(7)).toEqual([5]);
    expect(visited(8)).toEqual([]);
  });

  it("two sources asked for, the first answering last: the reader shows the second", async () => {
    showing();
    pinAnswer();
    const other: AskSourceRef = { ...source, messageId: 6, threadId: 3 };
    const answers: ((v: unknown) => void)[] = [];
    rpc.answer.set("ai.askSources", new Promise((r) => answers.push(r)));
    openPinnedSource(source);
    rpc.answer.set("ai.askSources", new Promise((r) => answers.push(r)));
    openPinnedSource(other);
    answers[1]!({ 6: { state: "ok", threadId: 3 } });
    await flush();
    answers[0]!({ 5: { state: "ok", threadId: 2 } });
    await flush();
    expect(opened.threads).toEqual([3]);
  });

  it("closed while a source was asked for, then the same answer pinned again: the old request opens nothing", async () => {
    showing();
    pinAnswer();
    let answer!: (v: unknown) => void;
    rpc.answer.set("ai.askSources", new Promise((r) => (answer = r)));
    openPinnedSource(source);
    closePinnedAnswer();
    pinAnswer();
    answer({ 5: { state: "ok", threadId: 2 } });
    await flush();
    expect(opened.threads).toEqual([]);
  });

  it("over a new message or a selection (Split), the source is what shows: the new message is put away, the selection ends", async () => {
    showing();
    pinAnswer();
    rpc.answer.set("ai.askSources", { 5: { state: "ok", threadId: 2 } });
    setApp({ compose: { key: "new:1", mode: "new" } as never, checked: new Set([1, 2]) });
    openPinnedSource(source);
    await flush();
    expect(opened.leftDraft).toBe(1);
    expect(getApp().checked.size).toBe(0);
    expect(opened.threads).toEqual([2]);
  });

  it("a Back to the answer from an earlier Ask source, on the same conversation, goes: the card is the way back", async () => {
    showing({ returnTo: { threadId: 2, messageId: 5, conversationId: 3 } });
    pinAnswer();
    rpc.answer.set("ai.askSources", { 5: { state: "ok", threadId: 2 } });
    openPinnedSource(source);
    await flush();
    expect(useAsk.getState().returnTo).toBeNull();
  });

  it("a source asked for after the card went opens nothing", async () => {
    showing();
    pinAnswer();
    let answer!: (v: unknown) => void;
    rpc.answer.set("ai.askSources", new Promise((r) => (answer = r)));
    openPinnedSource(source);
    usePinnedAsk.setState({ pinned: null });
    answer({ 5: { state: "ok", threadId: 2 } });
    await flush();
    expect(opened.threads).toEqual([]);
  });
});

describe("unpin and close", () => {
  it("unpin brings the same answer back into Ask, opened on purpose (Ask's 30 minutes don't apply)", async () => {
    showing({ usedAt: 0 });
    pinAnswer();
    await unpinAnswer();
    expect(usePinnedAsk.getState().pinned).toBeNull();
    expect(opened.asks).toBe(1);
    expect(useAsk.getState().usedAt).toBeGreaterThan(0);
    // Ask held it: nothing read again
    expect(rpc.calls.filter((c) => c.method === "ai.askConversation")).toEqual([]);
  });

  it("Ask holding another conversation: the pinned one is opened from the history first", async () => {
    showing();
    pinAnswer();
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    rpc.answer.set("ai.askConversation", { turns: [turnOf(1)], sources: {}, older: { kind: "none" } });
    await unpinAnswer();
    expect(useAsk.getState().conversationId).toBe(7);
    expect(opened.asks).toBe(1);
  });

  it("a read that's slow while a newer pin comes: the newer card stays, and Ask isn't taken over", async () => {
    showing();
    pinAnswer();
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    let answer!: (v: unknown) => void;
    rpc.answer.set("ai.askConversation", new Promise((r) => (answer = r)));
    const unpinning = unpinAnswer();
    expect(usePinnedAsk.getState().pinned?.conversationId).toBe(7);
    pinAnswer();
    answer({ turns: [turnOf(1)], sources: {}, older: { kind: "none" } });
    await unpinning;
    expect(usePinnedAsk.getState().pinned?.conversationId).toBe(8);
    expect(useAsk.getState().conversationId).toBe(8);
    expect(opened.asks).toBe(0);
  });

  it("a read that's slow while Ask moves on (a new question): Ask isn't taken over", async () => {
    showing();
    pinAnswer();
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    let answer!: (v: unknown) => void;
    rpc.answer.set("ai.askConversation", new Promise((r) => (answer = r)));
    const unpinning = unpinAnswer();
    useAsk.setState({ running: { requestId: "r2", question: "new", text: "", chunks: [], older: null, searchingOlder: false } });
    answer({ turns: [turnOf(1)], sources: {}, older: { kind: "none" } });
    await unpinning;
    expect(useAsk.getState().running?.requestId).toBe("r2");
    expect(useAsk.getState().conversationId).toBe(8);
    expect(opened.asks).toBe(0);
    expect(usePinnedAsk.getState().pinned?.conversationId).toBe(7);
  });

  it("a read that fails keeps the card, and says so", async () => {
    showing();
    pinAnswer();
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    rpc.answer.set("ai.askConversation", Promise.reject(new Error("down")));
    await unpinAnswer();
    expect(usePinnedAsk.getState().pinned?.conversationId).toBe(7);
    expect(opened.asks).toBe(0);
    expect(useSnack.getState().current?.message).toBe("That answer couldn’t be opened in Ask. It’s still pinned: try again in a moment.");
  });

  it("deleted meanwhile: nothing opens", async () => {
    showing();
    pinAnswer();
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    rpc.answer.set("ai.askConversation", null);
    await unpinAnswer();
    expect(opened.asks).toBe(0);
    expect(useAsk.getState().conversationId).toBe(8);
  });

  it("Ask's own pin button unpins in place", async () => {
    showing();
    pinAnswer();
    await unpinAnswer({ toAsk: false });
    expect(usePinnedAsk.getState().pinned).toBeNull();
    expect(opened.asks).toBe(0);
  });
});

describe("what ends the card", () => {
  it("its conversation deleted (here or in another window) or everything cleared, whichever Ask holds", () => {
    showing();
    pinAnswer();
    useAsk.setState({ conversationId: 8, turns: [turnOf(3, 8)] });
    rpc.events.get("aiAskGone")!({ conversationIds: [99] });
    expect(usePinnedAsk.getState().pinned).not.toBeNull();
    rpc.events.get("aiAskGone")!({ conversationIds: [7] });
    expect(usePinnedAsk.getState().pinned).toBeNull();
    showing();
    pinAnswer();
    forgetAsk();
    expect(usePinnedAsk.getState().pinned).toBeNull();
  });
});

describe("coming back to the same place", () => {
  it("a source shown or opened is read, for its conversation; the last 20 conversations are kept", async () => {
    showing();
    rpc.answer.set("ai.askSources", { 5: { state: "ok", threadId: 2 } });
    await openSource(source);
    expect(visited(7)).toEqual([5]);
    expect(useAsk.getState().returnTo).toMatchObject({ messageId: 5 });
    for (let id = 100; id < 120; id++) markVisited(id, 1);
    expect(visited(7)).toEqual([]);
    expect(visited(119)).toEqual([1]);
    markVisited(null, 1);
    expect(useAskVisited.getState().byConversation.size).toBe(20);
  });

  it("the place left (scrolls, the row chosen, a follow-up half typed), per conversation; the row only while no answer has come since", () => {
    showing();
    keepAskPlace(7, { turns: 1, top: 120, sourcesTop: 64, chosen: "source\u00005\u00001", followUp: "and" });
    keepAskPlace(8, { turns: 1, top: 9 });
    expect(askPlace(7)).toMatchObject({ top: 120, sourcesTop: 64, followUp: "and" });
    expect(askChosen()).toBe("source\u00005\u00001");
    useAsk.setState({ turns: [turnOf(1), turnOf(2)] });
    expect(askChosen()).toBeUndefined();
    forgetAsk();
    expect(askPlace(7)).toBeUndefined();
  });
});

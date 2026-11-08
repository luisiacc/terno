// @vitest-environment jsdom
/** Plan 161: an Ask source's way back, and the focus it gives the message it opened (Codex review #4, #5, #6, #7, #8). */
import type { AskTurn } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const saved = { turns: [{ id: 1, question: "q", answer: "a", status: "answered", sources: [], kind: "question", checks: { unlinked: false, unsupported: [] }, model: "m", createdAt: 0 }], sources: {}, older: { kind: "none" } };
const call = vi.fn(async (method: string) => (method === "ai.askConversation" ? saved : {}));
vi.mock("~/rpc/connection", () => ({ client: { call, on: () => () => {}, connectionVersion: 1 } }));
const toggleAsk = vi.fn();
vi.mock("~/lib/palette-open", async (real) => ({ ...(await real<object>()), toggleAsk }));

const { backToAnswer, focusMessage, installAsk, returning, useAsk, ASK_RETURN_MS } = await import("./ask");
const { focusIntent } = await import("./focus-intent");
const { setApp } = await import("~/state/app");
const { useAppearance } = await import("./appearance");
const { Scope } = await import("~/components/ask-page");
installAsk();

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const reader = (inner: string) => {
  document.body.innerHTML = `<div data-reader-scroller>${inner}</div>`;
};

afterEach(() => {
  document.body.innerHTML = "";
  useAsk.setState({ returnTo: null, conversationId: null, turns: [] });
});

describe("focus on the message a source opened", () => {
  it("waits for the reader to draw it, and takes the header", async () => {
    useAsk.setState({ returnTo: { threadId: 1, messageId: 5, conversationId: 3 } });
    reader("");
    focusMessage(5);
    expect(document.activeElement).toBe(document.body);
    // later than any fixed count of frames would wait
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector("[data-reader-scroller]")!.innerHTML = `<article data-message-id="5"><h3><button data-testid="message-toggle">Ana</button></h3></article>`;
    await frame();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("message-toggle");
  });

  it("a design that shows a lone message as a card, with no header button or heading, focuses the message itself", async () => {
    useAsk.setState({ returnTo: { threadId: 1, messageId: 6, conversationId: 3 } });
    reader(`<article data-message-id="6"><div>Ana</div></article>`);
    focusMessage(6);
    expect(document.activeElement?.getAttribute("data-message-id")).toBe("6");
    expect((document.activeElement as HTMLElement).tabIndex).toBe(-1);
  });

  it("yields to the user: a key or a press while it waits keeps their focus", async () => {
    useAsk.setState({ returnTo: { threadId: 1, messageId: 7, conversationId: 3 } });
    reader(`<button id="mine">mine</button>`);
    focusMessage(7);
    (document.getElementById("mine") as HTMLElement).focus();
    focusIntent.seq++;
    document.querySelector("[data-reader-scroller]")!.insertAdjacentHTML("beforeend", `<article data-message-id="7"><h3><button data-testid="message-toggle">Ana</button></h3></article>`);
    await frame();
    expect(document.activeElement?.id).toBe("mine");
  });
});

describe("the way back to the answer", () => {
  it("brings the answer back however long the source was read (⌘⇧K's 30 minutes don't apply)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      useAsk.setState({ conversationId: 3, turns: saved.turns as unknown as AskTurn[], usedAt: Date.now(), returnTo: { threadId: 1, messageId: 5, conversationId: 3 } });
      vi.setSystemTime(Date.now() + ASK_RETURN_MS + 60_000);
      await backToAnswer();
      expect(toggleAsk).toHaveBeenCalled();
      // what the page does as it opens
      returning();
      expect(useAsk.getState().conversationId).toBe(3);
      // and one the palette had already let go of is opened again
      useAsk.setState({ conversationId: null, turns: [], returnTo: { threadId: 1, messageId: 5, conversationId: 3 } });
      await backToAnswer();
      expect(useAsk.getState().conversationId).toBe(3);
      expect(useAsk.getState().turns).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes when its conversation does: another one opened, or List's page closed", () => {
    setApp({ selectedId: 1, readerOpen: true });
    useAsk.setState({ returnTo: { threadId: 1, messageId: 5, conversationId: 3 } });
    setApp({ selectedId: 2 });
    expect(useAsk.getState().returnTo).toBeNull();
    useAppearance.setState({ layout: "list" });
    setApp({ selectedId: 1, readerOpen: true });
    useAsk.setState({ returnTo: { threadId: 1, messageId: 5, conversationId: 3 } });
    setApp({ readerOpen: false });
    expect(useAsk.getState().returnTo).toBeNull();
    useAppearance.setState({ layout: "split" });
  });
});

describe("the search's boundary", () => {
  it("an answer while mail is still downloading says so", () => {
    setApp({ settings: { ask: { enabled: true } } as never });
    useAsk.setState({ running: null, olderFound: null, older: { kind: "downloading" }, turns: saved.turns as unknown as AskTurn[] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Scope />));
    expect(host.querySelector("[data-testid=ask-older-downloading]")?.textContent).toBe("Older mail is still downloading. Ask again when it’s done.");
    useAsk.setState({ older: { kind: "offer", since: Date.UTC(2026, 3, 25) } });
    act(() => root.render(<Scope />));
    expect(host.querySelector("[data-testid=ask-scope]")?.textContent).toMatch(/^Searched mail on this Mac back to .+Search older mail on your servers$/);
    act(() => root.unmount());
  });
});

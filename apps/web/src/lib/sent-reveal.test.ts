// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealSent, setSentRevealer, takeSent } from "./sent-reveal";

const reveal = vi.fn();
setSentRevealer(reveal);

function show(id: number) {
  document.body.innerHTML = `<div data-reader-scroller><article data-message-id="${id}"></article></div>`;
}

afterEach(() => {
  reveal.mockReset();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("revealing a reply just sent", () => {
  it("reveals the copy at once when the thread's change beat the send's answer", () => {
    show(41);
    revealSent(41);
    expect(reveal).toHaveBeenCalledWith(41);
    expect(takeSent([41])).toBeNull();
  });

  it("waits for the copy when it isn't shown yet, and reveals it once", () => {
    revealSent(42);
    expect(reveal).not.toHaveBeenCalled();
    expect(takeSent([40, 42])).toBe(42);
    expect(takeSent([42])).toBeNull();
  });

  it("only the message the send named: another sent message arriving meanwhile isn't it", () => {
    revealSent(43);
    expect(takeSent([44])).toBeNull();
    expect(takeSent([43])).toBe(43);
  });

  it("two sends in flight keep both", () => {
    revealSent(45);
    revealSent(46);
    expect(takeSent([46])).toBe(46);
    expect(takeSent([45])).toBe(45);
  });

  it("a copy that never showed (a forward into another thread) doesn't scroll later", () => {
    vi.useFakeTimers();
    revealSent(47);
    vi.advanceTimersByTime(11_000);
    expect(takeSent([47])).toBeNull();
  });
});

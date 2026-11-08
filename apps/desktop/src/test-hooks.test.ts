import { describe, expect, it } from "vitest";
import { NET_LOG_MAX, netRecorder, offsetClock, testClock, testNetLog } from "./test-hooks";

describe("plan 161: the rating's test hooks, in the demo mailbox only", () => {
  it("a normal launch reaches neither: no demo, no clock and no log, whatever the environment says", () => {
    const env = { TERNO_TEST_NOW: "1792683000000", TERNO_TEST_NET_LOG: "/tmp/net.log" };
    expect(testClock(env, false)).toBeNull();
    expect(testNetLog(env, false)).toBeNull();
    expect(testClock(env, true)).toBe(1792683000000);
    expect(testNetLog(env, true)).toBe("/tmp/net.log");
  });

  it("refuses what isn't an instant or an absolute path", () => {
    expect(testClock({ TERNO_TEST_NOW: "yesterday" }, true)).toBeNull();
    expect(testClock({ TERNO_TEST_NOW: "17926830000" }, true)).toBeNull();
    expect(testClock({}, true)).toBeNull();
    expect(testNetLog({ TERNO_TEST_NET_LOG: "net.log" }, true)).toBeNull();
  });

  it("the clock starts at the instant and runs at the real pace", () => {
    let real = 5_000;
    const now = offsetClock(1_000_000, () => real);
    expect(now()).toBe(1_000_000);
    real += 1_234;
    expect(now()).toBe(1_001_234);
  });

  it("the log writes one JSON line a decision, and stops at its bound", () => {
    const lines: string[] = [];
    const record = netRecorder("/x", (_, line) => lines.push(line));
    record({ purpose: "ai", url: "http://127.0.0.1:5/v1/chat/completions", allowed: true });
    expect(lines).toEqual(['{"purpose":"ai","url":"http://127.0.0.1:5/v1/chat/completions","allowed":true}\n']);
    for (let i = 0; i < NET_LOG_MAX + 5; i++) record({ purpose: "icons", url: "https://x.test/", allowed: false });
    expect(lines).toHaveLength(NET_LOG_MAX);
  });
});

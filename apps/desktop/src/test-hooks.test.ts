import { describe, expect, it } from "vitest";
import { demoCodeWanted, NET_LOG_MAX, netRecorder, offsetClock, testClock, testDevAi, testNetLog } from "./test-hooks";
import { clockArgs, clockShiftOf, shiftClock } from "./window-clock";

describe("plan 161: the rating's test hooks, in the demo mailbox only", () => {
  it("a normal launch reaches neither: no demo, no clock and no log, whatever the environment says", () => {
    const env = { TERNO_TEST_NOW: "1792683000000", TERNO_TEST_NET_LOG: "/tmp/net.log" };
    expect(testClock(env, false)).toBeNull();
    expect(testNetLog(env, false)).toBeNull();
    expect(testClock(env, true)).toBe(1792683000000);
    expect(testNetLog(env, true)).toBe("/tmp/net.log");
  });

  it("Dev mode for the rating's real models: the demo mailbox on an unpackaged build, and only when asked", () => {
    const env = { TERNO_TEST_DEV_AI: "1" };
    expect(testDevAi(env, false, true)).toBe(true);
    // a normal launch is a real mailbox; an installed app's keys are the user's own, whatever it's given
    expect(testDevAi(env, false, false)).toBe(false);
    expect(testDevAi(env, true, true)).toBe(false);
    expect(testDevAi({}, false, true)).toBe(false);
    expect(testDevAi({ TERNO_TEST_DEV_AI: "true" }, false, true)).toBe(false);
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

  it("the log writes one JSON line a decision, and stops at its bound with a line that says so", () => {
    const lines: string[] = [];
    const record = netRecorder("/x", (_, line) => lines.push(line));
    record({ purpose: "ai", url: "http://127.0.0.1:5/v1/chat/completions", allowed: true });
    expect(lines).toEqual(['{"purpose":"ai","url":"http://127.0.0.1:5/v1/chat/completions","allowed":true}\n']);
    for (let i = 0; i < NET_LOG_MAX + 5; i++) record({ purpose: "icons", url: "https://x.test/", allowed: false });
    expect(lines).toHaveLength(NET_LOG_MAX + 1);
    expect(lines.at(-1)).toBe('{"overflow":true}\n');
  });
});

describe("plan 167: the demo's fixed clock in the window", () => {
  it("an argument only when there's a shift, read back as it was given", () => {
    expect(clockArgs(null)).toEqual([]);
    expect(clockShiftOf(["electron", ...clockArgs(-1_555_200_123.4)])).toBe(-1_555_200_123);
    expect(clockShiftOf(["electron", ...clockArgs(42)])).toBe(42);
    // a normal window has none; anything that isn't a whole number of ms is no shift
    expect(clockShiftOf(["electron", "--type=renderer"])).toBeNull();
    expect(clockShiftOf(["--terno-test-clock-shift=soon"])).toBeNull();
    expect(clockShiftOf(["--terno-test-clock-shift="])).toBeNull();
  });

  it("Date and Date.now() read the shifted clock and run on; a date given stays that date", () => {
    let real = 1_800_000_000_000;
    class FakeReal extends Date {
      constructor(...args: [] | [number]) {
        super(args.length ? args[0]! : real);
      }
      static override now = () => real;
    }
    const scope = { Date: FakeReal as unknown as DateConstructor };
    shiftClock(-1_000, scope);
    const D = scope.Date;
    expect(D.now()).toBe(real - 1_000);
    expect(new D().getTime()).toBe(real - 1_000);
    real += 5_000;
    expect(D.now()).toBe(real - 1_000);
    expect(new D(0).getTime()).toBe(0);
    expect(D.UTC(2026, 9, 22)).toBe(Date.UTC(2026, 9, 22));
    expect(new D()).toBeInstanceOf(FakeReal);
    expect(typeof (D as unknown as () => string)()).toBe("string");
  });

  it("the shift is self-contained: it still works serialized, as executeInMainWorld sends it", () => {
    const scope = { Date };
    const revived = new Function(`return (${shiftClock.toString()})`)() as typeof shiftClock;
    revived(86_400_000, scope);
    expect(scope.Date.now() - Date.now()).toBeGreaterThan(86_399_000);
    expect(new scope.Date().getTime() - Date.now()).toBeGreaterThan(86_399_000);
  });

  it("no sign-in code under a fixed clock: it would be a message from weeks ahead atop the Inbox", () => {
    expect(demoCodeWanted({ demo: true, dev: true })).toBe(true);
    expect(demoCodeWanted({ demo: true, dev: true, testNow: 1_792_683_000_000 })).toBe(false);
    expect(demoCodeWanted({ demo: true, dev: false })).toBe(false);
    expect(demoCodeWanted({ demo: false, dev: true })).toBe(false);
  });
});

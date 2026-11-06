// @vitest-environment jsdom
/**
 * Plan 116 in the window: one notice (with Cancel) for what waits, and
 * (Codex code review #12) a failure said wherever you are, with Retry only
 * when nothing could have gone; what had failed before the window opened
 * isn't news.
 */
import type { ForwardInfo, ForwardSnapshot } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

const calls: { method: string; params: unknown }[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === "forwards.cancel" || method === "forwards.cancelWaiting" ? { cancelled: 1 } : { ok: true };
    },
    on: () => () => {},
  },
}));

const { applyForwards } = await import("./forwards");
const { useSnack, resetSnacks, runAction } = await import("./snack");

const ANA = { name: "Ana", email: "ana@books.test" };
const item = (id: number, status: ForwardInfo["status"], over: Partial<ForwardInfo> = {}): ForwardInfo => ({
  id, messageId: id, threadId: id, accountId: 1, rule: { kind: "category", id: 7 }, ruleName: "Facturas", to: [ANA], status, dueAt: Date.now() + 10_000, at: Date.now(), filesMissing: false, reason: null, ...over,
});
const snap = (items: ForwardInfo[], waiting = items.filter((i) => i.status === "waiting").length): ForwardSnapshot => ({ items, questions: [], waiting });

describe("forwards in the window (plan 116)", () => {
  beforeEach(() => {
    resetSnacks();
    calls.length = 0;
  });

  it("one notice for what waits, its Cancel taking every one up to the newest it showed; gone when nothing waits", async () => {
    applyForwards(snap([item(1, "failed")]));
    applyForwards(snap([item(1, "failed"), item(2, "waiting"), item(3, "waiting")]));
    expect(useSnack.getState().current).toMatchObject({ id: "forwards-waiting", message: "Forwarding 2 messages to Ana", description: "From Facturas" });
    runAction("action");
    await Promise.resolve();
    expect(calls).toEqual([{ method: "forwards.cancelWaiting", params: { upTo: 3 } }]);
    applyForwards(snap([item(1, "failed"), item(2, "waiting"), item(3, "waiting")]));
    applyForwards(snap([item(1, "failed"), item(2, "cancelled"), item(3, "cancelled")]));
    expect(useSnack.getState().current?.id).not.toBe("forwards-waiting");
  });

  it("Codex code review round 2 #1: more waiting than the list holds: the notice counts them all", () => {
    applyForwards(snap([item(9, "waiting"), item(8, "waiting")], 250));
    expect(useSnack.getState().current).toMatchObject({ id: "forwards-waiting", message: "Forwarding 250 messages" });
    expect(useSnack.getState().current?.action?.name).toBe("Cancel forwarding 250 messages");
  });

  it("#12: a failure is said once, with Retry when nothing went and View when something may have", async () => {
    applyForwards(snap([item(4, "sending")]));
    applyForwards(snap([item(4, "failed", { reason: "forward.reason.failed" })]));
    expect(useSnack.getState().current).toMatchObject({ tone: "error", message: "Couldn't forward a message from Facturas to Ana", action: { label: "Retry" }, secondary: { label: "View" } });
    runAction("action");
    await Promise.resolve();
    expect(calls).toEqual([{ method: "forwards.retry", params: { id: 4 } }]);
    resetSnacks();
    applyForwards(snap([item(4, "failed", { reason: "forward.reason.failed" })]));
    expect(useSnack.getState().current).toBeNull();
    applyForwards(snap([item(5, "unknown")]));
    expect(useSnack.getState().current).toMatchObject({ tone: "error", action: { label: "View" } });
    expect(useSnack.getState().current?.secondary).toBeUndefined();
  });
});

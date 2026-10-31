import type { SimilarScope } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import { chainUndo, isLatest, orderOffers, unchain } from "./offers";
import { registerUndo, resetSnacks, runUndo, undoLast, useSnack } from "./snack";

afterEach(() => resetSnacks());

describe("plan 86: offers", () => {
  it("one order everywhere: sender and subject, sender, domain, list", () => {
    const of = (...kinds: SimilarScope["kind"][]) => kinds.map((kind) => ({ scope: { kind } as SimilarScope }));
    expect(orderOffers(of("list", "sender", "domain", "subject")).map((o) => o.scope.kind)).toEqual(["subject", "sender", "domain", "list"]);
  });

  it("Undo takes back the newest first, then what it followed; a retry skips what came back", async () => {
    const order: string[] = [];
    const action = registerUndo(async () => void order.push("action"));
    let failOnce = true;
    const chained = chainUndo(async () => void order.push("default"), action);
    const later = chainUndo(async () => {
      order.push("offer");
      if (failOnce) {
        failOnce = false;
        throw new Error("boom");
      }
    }, chained);
    expect(isLatest(later)).toBe(true);
    await expect(runUndo(later)).rejects.toThrow("boom");
    // z still points at it: the retry runs it again, then the rest, each once
    undoLast();
    await expect.poll(() => order).toEqual(["offer", "offer", "default", "action"]);
    expect([later.state, chained.state, action.state]).toEqual(["done", "done", "done"]);
  });

  it("“No, only …” retires the chain and gives z back the action itself", async () => {
    const order: string[] = [];
    const action = registerUndo(async () => void order.push("action"));
    const chained = chainUndo(async () => void order.push("default"), action);
    expect(useSnack.getState().undo).toBe(chained);
    unchain(chained, action);
    expect(chained.state).toBe("done");
    expect(useSnack.getState().undo).toBe(action);
    undoLast();
    await expect.poll(() => order).toEqual(["action"]);
  });
});

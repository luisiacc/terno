import type { SimilarOffer, SimilarScope } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import { chainUndo, filingOffers, isLatest, orderOffers, unchain } from "./offers";
import { registerUndo, resetSnacks, runUndo, undoLast, useSnack } from "./snack";

afterEach(() => resetSnacks());

describe("plan 91: offers", () => {
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

describe("filingOffers (plans 81, 128)", () => {
  const offer = (scope: SimilarScope, count: number, capped = false): SimilarOffer => ({ scope, count, capped, skipped: 0 });
  const sender = { kind: "sender", email: "a@x.test" } as const;
  const subject = { kind: "subject", email: "a@x.test", subject: "Hi" } as const;
  const domain = { kind: "domain", domain: "x.test" } as const;
  const list = { kind: "list", listId: "news.x.test" } as const;
  const kinds = (o: SimilarOffer[]) => filingOffers(o).map((x) => x.scope.kind);

  it("the sender's stays with nothing left: it's about new mail", () => {
    expect(kinds([offer(sender, 0)])).toEqual(["sender"]);
  });

  it("a subject needs more of it; narrowest first", () => {
    expect(kinds([offer(sender, 2), offer(subject, 0)])).toEqual(["sender"]);
    expect(kinds([offer(sender, 2), offer(subject, 1)])).toEqual(["subject", "sender"]);
  });

  it("a domain or list holding no more than the sender is said once; capped counts can't say so", () => {
    expect(kinds([offer(sender, 2), offer(domain, 2), offer(list, 3)])).toEqual(["sender", "list"]);
    expect(kinds([offer(sender, 2), offer(domain, 0)])).toEqual(["sender"]);
    expect(kinds([offer(sender, 2, true), offer(domain, 2)])).toEqual(["sender", "domain"]);
    expect(kinds([offer(domain, 2)])).toEqual(["domain"]);
  });
});

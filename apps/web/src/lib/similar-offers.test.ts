import type { SimilarOffer } from "@terno/core";
import { describe, expect, it } from "vitest";
import { visibleOffers } from "./similar-offers";

const offer = (kind: "sender" | "subject" | "domain" | "list", count: number, capped = false): SimilarOffer => {
  const scope =
    kind === "sender" ? { kind, email: "a@b.com" }
    : kind === "subject" ? { kind, email: "a@b.com", subject: "Hi" }
    : kind === "domain" ? { kind, domain: "b.com" }
    : { kind, listId: "l.b.com" };
  return { scope, count, capped, skipped: 0 };
};

describe("similar chips (plan 63)", () => {
  it("archive and delete: only scopes with more to do, a wider one only when it holds more than the sender", () => {
    const offers = [offer("sender", 5), offer("subject", 2), offer("domain", 5), offer("list", 9)];
    expect(visibleOffers("archive", offers).map((o) => o.scope.kind)).toEqual(["sender", "subject", "list"]);
    expect(visibleOffers("trash", [offer("sender", 0), offer("subject", 0)])).toEqual([]);
    // capped counts are only equal when both are capped
    expect(visibleOffers("archive", [offer("sender", 1000, true), offer("domain", 1000, false)]).map((o) => o.scope.kind)).toEqual(["sender", "domain"]);
  });

  it("spam: every scope, even with nothing now (each catches future mail)", () => {
    const offers = [offer("sender", 0), offer("subject", 0), offer("domain", 0)];
    expect(visibleOffers("spam", offers)).toEqual(offers);
  });
});
